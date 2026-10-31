// WebSockets for Codex. A socket from Codex is relayed to ChatGPT's own
// WebSocket endpoint on one account, which keeps the conversation warm
// upstream and starts answers sooner than HTTP streaming.
//
// A socket stays on the account it opened on. When that account turns out
// to be spent mid-turn, the socket is closed: Codex retries on a new
// socket with the whole conversation, and that one opens on an account
// that can serve. Anything slopmax cannot relay is refused with 426, which
// sends Codex back to HTTP streaming, where failover is finer-grained.
import { type Cause, Clock, Effect, Fiber, Queue, type Scope } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"

import { log, text as texts, Timestamp } from "@slopmax/common"
import { client as net, server, ws } from "@slopmax/net"
import { json, responses, type Usage } from "@slopmax/wire"

import type { Account } from "../account.ts"
import { session as sessionOf } from "../agent/mod.ts"
import { detect } from "../agent/registry.ts"
import type { ClientKey } from "../config.ts"
import { type Refusal } from "../limits.ts"
import { DEFAULT_BLOCK, DEFAULT_THROTTLE } from "../pool.ts"
import * as codexLimits from "../provider/codex/limits.ts"
import { stripAccountState } from "../provider/codex/wire.ts"
import { ProviderId } from "../provider/mod.ts"
import { plan } from "../route.ts"
import { swapRemove } from "../serde.ts"
import { affinity, header, insert } from "./headers.ts"
import { type App, entry, error, type Target } from "./app.ts"

/** The WebSocket protocol version ChatGPT's endpoint speaks. */
const BETA = "responses_websockets=2026-02-06"
/** How long the upstream handshake may take. */
const CONNECT = "15 seconds"
/** How many messages wait for each side's writer. */
const QUEUED = 64
/** How long the writers get to send what is queued once the relay ends. */
const FLUSH = "5 seconds"

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

type Response = HttpServerResponse.HttpServerResponse

/**
 * Answers a WebSocket handshake on Codex's path: relays it, or refuses
 * with 426 so Codex streams over HTTP instead.
 */
export const accept = Effect.fn("socket.accept")(function* (
  app: App,
  target: Target,
  headers: Headers,
  client: ClientKey | undefined,
): Effect.fn.Return<Response, never, HttpServerRequest.HttpServerRequest | Scope.Scope> {
  const config = yield* app.config
  if (!config.websockets) return refuse("websockets are off in the config")
  if (target.provider !== "codex" || !target.byModel) return refuse("only Codex's /responses is relayed")
  // A socket carries many requests, each naming its own model; a key held
  // to some models is checked request by request, over HTTP.
  if (client !== undefined && client.models.length > 0) return refuse("the key is held to some models")
  const key = text(headers, "sec-websocket-key")
  if (key === undefined) return error(undefined, 400, "missing Sec-WebSocket-Key")
  if (text(headers, "sec-websocket-version") !== "13") {
    return HttpServerResponse.setHeader(upgradeRequired(), "sec-websocket-version", "13")
  }

  // Codex names the model in its routing hint; a socket only serves models
  // ChatGPT serves as they are.
  const model = routingModel(headers)
  const agent = detect(headers)
  const session = sessionOf(agent, headers, new Uint8Array(0))
  const accounts = yield* app.pool.accounts
  let candidates: ReadonlyArray<string>
  if (model !== undefined) {
    const steps = plan(
      { accounts, aliases: config.aliases, fallbacks: config.fallbacks, paidOverflow: config.paidOverflow },
      { model, dialect: "responses", agent: agent?.id, default: "codex" },
    )
    const step = steps._tag === "Success" ? steps.success[0] : undefined
    if (step === undefined || step.provider !== "codex" || step.model !== model) {
      return refuse("the model is not served by a ChatGPT account")
    }
    candidates = step.accounts
  } else {
    candidates = accounts.filter((a) => a.provider === "codex").map((a) => a.id)
  }
  const picked = yield* Effect.result(
    app.pool.pick(
      {
        provider: "codex",
        session,
        affinity: affinity(headers),
        housekeeping: false,
        model,
        candidates,
        exclude: [],
      },
      yield* Timestamp.now,
    ),
  )
  if (picked._tag === "Failure") return refuse("no ChatGPT account can serve now")
  const choice = picked.success
  const moved = choice.movedFrom !== undefined
  const account = yield* app.ready(choice.account)
  if (account === undefined) return refuse("the account's sign-in could not be refreshed")
  const connected = yield* Effect.result(connect(app, headers, account, moved))
  if (connected._tag === "Failure") {
    log.warn(`${account.id}: websocket handshake failed: ${connected.failure}`)
    return refuse("the upstream handshake failed")
  }
  const [upstream, answer] = connected.success

  // Bun writes the `101` itself, with `upgrade`, `connection`, and the
  // accept key for the client's key.
  const out = new Headers()
  for (const name of ["openai-model", "x-reasoning-included", "x-models-etag"]) {
    const value = answer.get(name)
    if (value !== null) out.set(name, value)
  }
  const upgraded = yield* Effect.result(server.upgrade(out))
  if (upgraded._tag === "Failure") {
    log.warn(`websocket upgrade failed: ${upgraded.failure.message}`)
    return upgradeRequired()
  }
  log.info(`websocket opened on ${choice.account.id}`)
  yield* relay(app, account, upgraded.success, upstream, moved, { agent: agent?.id, session })
  return HttpServerResponse.empty()
})

/** A refusal, said in the log too. */
const refuse = (why: string): Response => {
  log.info(`websocket refused (${why}); Codex will stream over HTTP`)
  return upgradeRequired()
}

const upgradeRequired = (): Response => error("responses", 426, "slopmax relays this over HTTP streaming")

const text = (headers: Headers, name: string): string | undefined => {
  const value = header(headers, name)
  return value === undefined ? undefined : texts.trim(value)
}

/** `gpt-6-sol` from `x-codex-routing-hint: model=gpt-6-sol;tier=…`. */
export const routingModel = (headers: Headers): string | undefined => {
  const hint = text(headers, "x-codex-routing-hint")
  if (hint === undefined) return undefined
  for (const part of hint.split(";")) {
    const trimmed = texts.trim(part)
    if (trimmed.startsWith("model=")) {
      const model = trimmed.slice("model=".length)
      return model === "" ? undefined : model
    }
  }
  return undefined
}

/**
 * Opens the upstream socket on `account`. Returns it with the headers of
 * the upstream's `101`; the connection closes with the scope.
 */
const connect = Effect.fn("socket.connect")(function* (
  app: App,
  client: Headers,
  account: Account,
  moved: boolean,
): Effect.fn.Return<readonly [net.Upgraded, Headers], string, Scope.Scope> {
  const provider = ProviderId.get("codex")
  const own = new Headers(client)
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
  ]) {
    own.delete(name)
  }
  const headers = provider.headers(own, account, moved)
  const key = ws.newKey()
  insert(headers, "upgrade", "websocket")
  insert(headers, "connection", "Upgrade")
  insert(headers, "sec-websocket-version", "13")
  insert(headers, "sec-websocket-key", key)
  headers.delete("accept-encoding")
  if (!headers.has("openai-beta")) headers.set("openai-beta", BETA)
  const response = yield* app.http
    .get(`${provider.api(account)}/responses`)
    .headers(headers)
    .timeout(CONNECT)
    .send()
    .pipe(Effect.mapError((e) => e.message))
  if (response.status !== 101) return yield* Effect.fail(`answered ${net.statusText(response.status)}`)
  if (header(response.headers, "sec-websocket-accept") !== ws.acceptKey(key)) {
    yield* response.close
    return yield* Effect.fail("the handshake's accept key is wrong")
  }
  const socket = yield* response.upgrade().pipe(Effect.mapError((e) => e.message))
  return [socket, response.headers] as const
})

/** The turn in flight, for the usage ledger (times in the clock's milliseconds). */
interface Turn {
  started: number | undefined
  model: string | undefined
  firstByte: number | undefined
}

/** Who opened the socket, for the usage ledger. */
interface Origin {
  readonly agent: string | undefined
  readonly session: string | undefined
}

/** Sends what `queue` holds through `send` until a close goes out or a send fails. */
const writer = Effect.fn("socket.writer")(
  function* (
    queue: Queue.Queue<ws.Message, Cause.Done>,
    send: (message: ws.Message) => Effect.Effect<void, unknown>,
  ): Effect.fn.Return<void> {
    for (;;) {
      const message = yield* Effect.option(Queue.take(queue))
      if (message._tag === "None") return
      const sent = yield* Effect.result(send(message.value))
      if (sent._tag === "Failure" || message.value._tag === "Close") return
    }
  },
  (effect, queue) => Effect.ensuring(effect, Queue.shutdown(queue)),
)

/** Relays messages both ways until either side closes. */
const relay = Effect.fn("socket.relay")(function* (
  app: App,
  account: Account,
  client: server.ServerSocket,
  upstream: net.Upgraded,
  moved: boolean,
  origin: Origin,
) {
  const toClient = yield* Queue.bounded<ws.Message, Cause.Done>(QUEUED)
  const toUpstream = yield* Queue.bounded<ws.Message, Cause.Done>(QUEUED)
  // The client's side is framed by Bun (unmasked); the upstream side here,
  // masked, as a client's must be.
  const upstreamWriter = ws.Writer.client(upstream)
  const clientWriter = yield* Effect.forkChild(writer(toClient, client.send))
  const upstreamWriting = yield* Effect.forkChild(writer(toUpstream, upstreamWriter.send))
  const turn: Turn = { started: undefined, model: undefined, firstByte: undefined }
  const reading = yield* Effect.forkChild(fromClient(client, toUpstream, toClient, turn, moved))
  const answering = yield* Effect.forkChild(
    fromUpstream(app, account, new ws.Reader(upstream), toClient, toUpstream, turn, origin),
  )
  // Either side ending ends the relay; the writers flush what is queued,
  // closes included, once nothing more is added.
  yield* Effect.raceFirst(Fiber.await(reading), Fiber.await(answering))
  yield* Fiber.interrupt(reading)
  yield* Fiber.interrupt(answering)
  yield* Queue.end(toClient)
  yield* Queue.end(toUpstream)
  yield* Effect.timeoutOption(Effect.all([Fiber.await(clientWriter), Fiber.await(upstreamWriting)]), FLUSH)
  yield* Fiber.interrupt(clientWriter)
  yield* Fiber.interrupt(upstreamWriting)
  yield* Effect.ignore(client.send(ws.Message.closeBare))
})

// Queues `message` for a writer; false once that writer has stopped.
const offer = (queue: Queue.Queue<ws.Message, Cause.Done>, message: ws.Message): Effect.Effect<boolean> =>
  Queue.offer(queue, message)

const fromClient = Effect.fn("socket.fromClient")(function* (
  client: server.ServerSocket,
  toUpstream: Queue.Queue<ws.Message, Cause.Done>,
  toClient: Queue.Queue<ws.Message, Cause.Done>,
  turn: Turn,
  moved: boolean,
): Effect.fn.Return<void> {
  for (;;) {
    const read = yield* Effect.result(client.message)
    const message = read._tag === "Success" ? read.success : undefined
    if (message === undefined) {
      yield* offer(toUpstream, ws.Message.closeBare)
      return
    }
    let next: ws.Message
    switch (message._tag) {
      case "Text":
        next = ws.Message.text(outgoing(message.text, turn, moved, yield* Clock.currentTimeMillis))
        break
      case "Ping":
        yield* offer(toClient, ws.Message.pong(message.data))
        continue
      case "Pong":
        continue
      case "Close":
        yield* offer(toUpstream, message)
        return
      case "Binary":
        next = message
        break
    }
    if (!(yield* offer(toUpstream, next))) return
  }
})

/**
 * A client message on its way up: a new turn starts the clock, and on a
 * socket that moved accounts, state bound to the old account is dropped.
 */
export const outgoing = (message: string, turn: Turn, moved: boolean, now: number): string => {
  const request = json.parse(message)
  if (request === undefined || json.str(json.get(request, "type")) !== "response.create") return message
  turn.started = now
  turn.model = json.str(json.get(request, "model"))
  turn.firstByte = undefined
  if (!moved) return message
  const metadata = json.get(request, "client_metadata")
  let changed = json.isObject(metadata) && swapRemove(metadata, "x-codex-turn-state")
  let bytes: Uint8Array = utf8.encode(json.stringify(request))
  const stripped = stripAccountState(bytes)
  if (stripped !== undefined) {
    bytes = stripped
    changed = true
  }
  return changed ? fromUtf8.decode(bytes) : message
}

/** A fresh turn, for tests. */
export const newTurn = (): Turn => ({ started: undefined, model: undefined, firstByte: undefined })

const fromUpstream = Effect.fn("socket.fromUpstream")(function* (
  app: App,
  account: Account,
  reader: ws.Reader<unknown>,
  toClient: Queue.Queue<ws.Message, Cause.Done>,
  toUpstream: Queue.Queue<ws.Message, Cause.Done>,
  turn: Turn,
  origin: Origin,
): Effect.fn.Return<void> {
  const id = account.id
  for (;;) {
    const read = yield* Effect.result(reader.message)
    const message = read._tag === "Success" ? read.success : undefined
    if (message === undefined) {
      yield* offer(toClient, ws.Message.close(1011, "upstream closed"))
      return
    }
    let body: string
    switch (message._tag) {
      case "Text":
        body = message.text
        break
      case "Ping":
        yield* offer(toUpstream, ws.Message.pong(message.data))
        continue
      case "Pong":
        continue
      case "Close":
        yield* offer(toClient, message)
        return
      case "Binary":
        yield* offer(toClient, message)
        continue
    }
    const now = yield* Timestamp.now
    const event = json.parse(body)
    if (event !== undefined) {
      turn.firstByte ??= yield* Clock.currentTimeMillis
      switch (json.str(json.get(event, "type")) ?? "") {
        case "codex.rate_limits": {
          const limits = codexLimits.fromEvent(event, now)
          if (limits !== undefined) yield* app.pool.observe(id, limits, now)
          // Codex sees the pool, not this account.
          const windows = yield* app.pool.pooled("codex", now)
          if (windows.length > 0) {
            // The event is not read again, so it is rewritten in place.
            codexLimits.poolEvent(windows, event)
            if (!(yield* offer(toClient, ws.Message.text(json.stringify(event))))) return
            continue
          }
          break
        }
        case "response.completed":
        case "response.incomplete":
        case "response.done":
          yield* app.pool.recordSuccess(id, now)
          yield* record(app, id, event, turn, origin)
          break
        case "response.failed":
        case "error": {
          const refused = refusal(event, now)
          if (refused !== undefined) {
            // Leave the turn unfinished: Codex retries it on a new socket,
            // which opens on another account.
            if (refused._tag === "Exhausted") {
              const until = refused.until ?? Timestamp.add(now, DEFAULT_BLOCK)
              yield* app.pool.block(id, until, refused.model, "usage limit reached")
              log.info(`${id}: limited inside a websocket; closing it`)
            } else {
              yield* app.pool.throttle(id, refused.until ?? Timestamp.add(now, DEFAULT_THROTTLE))
            }
            yield* offer(toUpstream, ws.Message.closeBare)
            yield* offer(toClient, ws.Message.close(1012, "the account is limited; reconnect"))
            return
          }
          break
        }
        default:
          break
      }
    }
    if (!(yield* offer(toClient, ws.Message.text(body)))) return
  }
})

const SPENT = ["usage_limit_reached", "usage_limit_exceeded", "usage_not_included", "insufficient_quota"]
const BUSY = ["server_is_overloaded", "slow_down", "rate_limit_exceeded"]

/** A failure event that is the account's rather than the request's. */
export const refusal = (event: json.Json, now: Timestamp): Refusal | undefined => {
  const nested = json.get(json.get(event, "response"), "error")
  const failure = nested !== undefined ? nested : json.get(event, "error")
  if (failure === undefined) return undefined
  const code = json.str(json.get(failure, "code")) ?? json.str(json.get(failure, "type")) ?? ""
  if (SPENT.includes(code)) {
    const body = utf8.encode(json.stringify({ error: failure }))
    return codexLimits.refusal(429, new Headers(), body, now)
  }
  if (BUSY.includes(code)) return { _tag: "Throttled", until: undefined }
  return undefined
}

/** Records a finished turn in the ledger and the account's counters. */
const record = Effect.fn("socket.record")(function* (
  app: App,
  id: string,
  event: json.Json,
  turn: Turn,
  origin: Origin,
): Effect.fn.Return<void> {
  const { started, model, firstByte } = turn
  turn.started = undefined
  turn.model = undefined
  turn.firstByte = undefined
  const reported = json.get(json.get(event, "response"), "usage")
  const usage: Usage =
    reported !== undefined
      ? responses.events.usage(reported)
      : { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  yield* app.pool.addUsage(id, usage)
  const now = yield* Clock.currentTimeMillis
  const from = started ?? now
  app.record(
    entry({
      at: yield* Timestamp.now,
      account: id,
      provider: "codex",
      model,
      status: 200,
      usage: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
      },
      ms: now - from,
      firstByteMs: firstByte === undefined ? undefined : firstByte - from,
      attempts: 1,
      agent: origin.agent,
      session: origin.session,
    }),
  )
})
