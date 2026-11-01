// Codex's WebSockets. A socket from Codex is relayed to ChatGPT's own
// WebSocket endpoint on one account, which keeps the conversation warm
// upstream and starts answers sooner than HTTP streaming.
//
// A socket stays on the account it opened on. When that account turns out
// to be spent mid-turn, both sides are closed and Codex retries on a new
// socket with the whole conversation, which opens on an account that can
// serve. Anything slopmax will not relay is refused with 426, which sends
// Codex back to HTTP streaming at once, where failover is finer-grained.
//
// The upstream socket opens first; only then is Codex's handshake upgraded,
// so a failed upstream handshake never leaves Codex with a dead socket.
// Frames are relayed in native callbacks. Each decision about a frame is a
// pure function; the few that change the pool or the ledger go through the
// settler's queue, and a rate-limit event, which the client must hear
// rewritten with the pool's windows, holds the frames behind it until the
// pool has read it, so the client hears them in order.
import { type AccountId, type AgentId, type ProviderId } from "@slopmax/domain"
import { errorBody, observe as observeEvent, scan, TapOutcome } from "@slopmax/wire"
import { Cause, Clock, Data, DateTime, Duration, Effect, Exit, FiberSet, Layer, Option, Scope } from "effect"
import type { WebSocket } from "ws"
import { Accounts } from "../accounts.ts"
import { maxMessage, ReadyState, type UpstreamSocket } from "../dial.ts"
import { commonSession, detect } from "../agents/index.ts"
import {
  affinityOverride,
  block,
  defaultBlock,
  defaultThrottle,
  failed,
  observe,
  pick,
  Pool,
  routingOf,
  succeeded,
  throttle,
} from "../pool.ts"
import { isRecord, parseJson, type SocketHooks } from "../providers/provider.ts"
import { providers } from "../providers/registry.ts"
import { plan } from "../router.ts"
import { Relay, type RelayShape, type SocketServer } from "../server.ts"
import { SettingsService } from "../settings.ts"
import { Upstream } from "../upstream.ts"
import { authenticate, type Caller, heldKey, keyRing } from "./auth.ts"
import type { Route } from "./classify.ts"
import { Proxy } from "./forward.ts"
import { error, json, kindOf, noKey, noSocket } from "./replies.ts"
import { Settlement, Settler } from "./settle.ts"

/** The version of ChatGPT's WebSocket protocol slopmax speaks, unless Codex names one. */
export const socketsBeta = "responses_websockets=2026-02-06"

/** How far the upstream may fall behind a client's messages before the client is told to back off. */
export const maxBehind = 64 * 1024 * 1024

/** How long each side gets to send what it has queued, its close included, once the relay ends. */
export const flushWait: Duration.Duration = Duration.seconds(5)

/** What Codex hears when slopmax will not relay its socket. */
export const refusalText = "slopmax relays this over HTTP streaming"

/** The 426 that sends Codex to HTTP streaming at once. */
export const refusal = (): Response => noSocket(refusalText)

/** The refusal for a protocol version slopmax does not speak, naming the one it does. */
export const wrongVersion = (): Response =>
  json(426, errorBody("responses", kindOf(426), refusalText), { "sec-websocket-version": "13" })

/** The close Codex gets when the account it is on turns out to be limited: it reconnects, and lands elsewhere. */
export const limitedClose = { code: 1012, reason: "the account is limited; reconnect" } as const

/** The close Codex gets when ChatGPT's side went away without closing. */
export const upstreamGoneClose = { code: 1011, reason: "upstream closed" } as const

/** The close a client gets for sending faster than ChatGPT takes it. */
export const behindClose = { code: 1013, reason: "the upstream is not keeping up; try again" } as const

// ---------------------------------------------------------------------------
// The handshake, decided from its headers

/** `gpt-6-sol` from `x-codex-routing-hint: model=gpt-6-sol;tier=…`. */
export const routingModel = (headers: Headers): string | undefined => {
  const hint = headers.get("x-codex-routing-hint")
  if (hint === null) return undefined
  for (const part of hint.split(";")) {
    const trimmed = part.trim()
    if (!trimmed.startsWith("model=")) continue
    const model = trimmed.slice("model=".length)
    return model === "" ? undefined : model
  }
  return undefined
}

/** What a handshake gets, before any account is looked at. */
export type Screen = Data.TaggedEnum<{
  /** Codex streams over HTTP instead, for this reason. */
  Refuse: { readonly why: string }
  /** Not a WebSocket handshake at all. */
  MissingKey: {}
  /** A protocol version slopmax does not speak. */
  WrongVersion: {}
  /** Relay it, on an account serving `model` when the hint names one. */
  Open: { readonly model: string | undefined }
}>
export const Screen = Data.taggedEnum<Screen>()

const pathOnly = (path: string): string => {
  const query = path.indexOf("?")
  return query < 0 ? path : path.slice(0, query)
}

/**
 * Whether to relay a handshake: sockets turned on, Codex's `/responses`
 * routed by model, a key not held to some models (a socket carries many
 * requests, each naming its own model, so such a key is checked request
 * by request over HTTP), and a well-formed handshake.
 */
export const screen = (websockets: boolean, route: Route, caller: Caller, headers: Headers): Screen => {
  if (!websockets) return Screen.Refuse({ why: "websockets are off in the settings" })
  if (route.pathProvider !== "codex" || !route.byModel || pathOnly(route.path) !== "/responses") {
    return Screen.Refuse({ why: "only Codex's /responses is relayed" })
  }
  if (heldKey(caller) !== undefined) return Screen.Refuse({ why: "the key is held to some models" })
  const key = headers.get("sec-websocket-key")?.trim()
  if (key === undefined || key === "") return Screen.MissingKey()
  if (headers.get("sec-websocket-version")?.trim() !== "13") return Screen.WrongVersion()
  return Screen.Open({ model: routingModel(headers) })
}

/** The handshake headers the upstream must not see: the client's own key, version and offers. */
const ownHandshake = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]

/** The client's headers, without its own handshake: the upstream handshake is the dialer's. */
export const withoutHandshake = (client: Headers): Headers => {
  const out = new Headers(client)
  for (const name of ownHandshake) out.delete(name)
  return out
}

/**
 * The upstream handshake's headers, from what the provider built: frames
 * are not compressed (the relay reads them), and the protocol version is
 * slopmax's unless Codex asked for its own.
 */
export const upstreamHeaders = (built: Headers): Headers => {
  const out = new Headers(built)
  out.delete("accept-encoding")
  if (!out.has("openai-beta")) out.set("openai-beta", socketsBeta)
  return out
}

/** What Codex reads from ChatGPT's 101: the model it serves, whether reasoning is included, and the model list's tag. */
const answered = ["openai-model", "x-reasoning-included", "x-models-etag"]

/** The upstream 101's headers Codex gets on its own 101. */
export const answerHeaders = (upstream: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of answered) {
    const value = upstream.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Frames, decided one at a time

/** Codex starts a turn with `{"type":"response.create",…}`, its type first. */
const turnStart = /^\s*\{\s*"type"\s*:\s*"response\.create"/

/** …and names its model next, which is all an unmoved socket needs of the turn. */
const turnHead = /^\s*\{\s*"type"\s*:\s*"response\.create"\s*,\s*"model"\s*:\s*"([^"\\]*)"/

/** Whether a client text starts a turn: only those are read. */
export const startsTurn = (text: string): boolean => turnStart.test(text.slice(0, 64))

/** A turn the client started: its model, and the text to send on. */
export interface Started {
  readonly model: string | undefined
  readonly text: string
}

/**
 * A client text that starts a turn, read. On a socket whose session moved
 * accounts, the state the old account minted is dropped; the text is
 * written again only when something was dropped, so it otherwise goes on
 * byte for byte. A turn carries the whole conversation, so on a socket that
 * did not move only its head is read when the model is named there.
 */
export const startTurn = (text: string, moved: boolean, rebind: SocketHooks["rebindTurn"]): Started | undefined => {
  if (!moved) {
    const head = turnHead.exec(text.slice(0, 256))
    if (head !== null) return { model: head[1], text }
  }
  const request = Option.getOrUndefined(parseJson(text))
  if (!isRecord(request) || request["type"] !== "response.create") return undefined
  const model = typeof request["model"] === "string" ? request["model"] : undefined
  if (!moved) return { model, text }
  return Option.match(rebind(request), {
    onNone: () => ({ model, text }),
    onSome: (rebound) => ({ model, text: JSON.stringify(rebound) }),
  })
}

/** What an upstream text is to the relay. */
export type EventKind = "rateLimits" | "finished" | "failed" | "other"

/** The kind of an upstream event, from its `type`; nothing else of it is read. */
export const eventKind = (type: string | undefined): EventKind => {
  switch (type) {
    case "codex.rate_limits":
      return "rateLimits"
    case "response.completed":
    case "response.incomplete":
    case "response.done":
      return "finished"
    case "response.failed":
    case "error":
      return "failed"
    default:
      return "other"
  }
}

/** A finished turn's usage, from `response.usage`; one request with no tokens when it names none. */
export const turnOutcome = (event: unknown): TapOutcome => observeEvent("responses", TapOutcome.empty, event).counted()

/** Whether a close code may be sent on: the codes that only describe a socket that ended without one may not. */
export const sendable = (code: number): boolean =>
  code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015

/** Whether a client has queued so much for the upstream that it must back off. */
export const tooFarBehind = (bufferedAmount: number): boolean => bufferedAmount >= maxBehind

// ---------------------------------------------------------------------------
// Ending a relay

/** Both sides of a relay, as its end sees them. */
export interface Sides {
  /** Whether both sides have closed. */
  readonly closed: () => boolean
  /** Calls `wake` once both sides have closed. */
  readonly onClosed: (wake: () => void) => void
  /** Cuts whatever side has not closed. */
  readonly cut: () => void
}

/**
 * The end of a relay: each side gets up to {@link flushWait} to send what it
 * has queued and close, then whatever is still open is cut. Follows `Clock`.
 */
export const finishRelay = (sides: Sides): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (sides.closed()) return resume(Effect.void)
    sides.onClosed(() => resume(Effect.void))
  }).pipe(Effect.timeoutOption(flushWait), Effect.andThen(Effect.sync(() => sides.cut())))

// ---------------------------------------------------------------------------
// One relayed socket

/** An upstream frame, or its close, waiting its turn to reach the client. */
type Held = Data.TaggedEnum<{
  Frame: { readonly bytes: Uint8Array; readonly binary: boolean }
  /** A text already read, to send as it is. */
  Read: { readonly text: string }
  Closed: { readonly code: number; readonly reason: string }
}>
const Held = Data.taggedEnum<Held>()

/** The turn in flight, for the ledger (clock milliseconds). */
interface Turn {
  readonly startedAt: number | undefined
  readonly model: string | undefined
  firstByteAt: number | undefined
}

const noTurn = (): Turn => ({ startedAt: undefined, model: undefined, firstByteAt: undefined })

/** Everything the two sides of one socket share. Bun hands it back on each client callback. */
class SocketState {
  /** Codex's side, once Bun has upgraded it. */
  client: Bun.ServerWebSocket<unknown> | undefined = undefined
  turn: Turn = noTurn()
  /** Upstream frames waiting: for the client to open or drain, or behind an event the pool is still reading. */
  readonly held: Array<Held> = []
  holding = true
  /**
   * The client's send buffer is full: frames wait in `held`, as Bun drops
   * what is sent past its limit, and upstream reading pauses until it drained.
   */
  clientFull = false
  paused = false
  clientClosing = false
  upstreamClosing = false
  clientClosed = false
  upstreamClosed = false
  finishing = false
  private wake: (() => void) | undefined = undefined

  constructor(
    readonly account: AccountId,
    readonly moved: boolean,
    readonly agent: AgentId | undefined,
    readonly session: string | undefined,
    readonly upstream: WebSocket,
    readonly scope: Scope.Closeable,
  ) {}

  /** Both sides as the relay's end sees them. */
  readonly sides: Sides = {
    closed: () => this.clientClosed && this.upstreamClosed,
    onClosed: (wake) => {
      this.wake = wake
    },
    cut: () => {
      if (!this.clientClosed) this.client?.terminate()
      if (this.upstream.readyState !== ReadyState.closed) this.upstream.terminate()
    },
  }

  /** Notes that one side closed, waking the relay's end once both have. */
  closedOne(): void {
    if (this.clientClosed && this.upstreamClosed) this.wake?.()
  }
}

const utf8 = new TextDecoder()

const codex: ProviderId = "codex"

// ---------------------------------------------------------------------------
// The service

/** A refusal, said in the log too. */
const refuse = (why: string): Effect.Effect<Response> =>
  Effect.as(Effect.logInfo(`websocket refused (${why}); Codex will stream over HTTP`), refusal())

const make = Effect.gen(function* () {
  const settings = yield* SettingsService
  const accounts = yield* Accounts
  const pool = yield* Pool
  const upstream = yield* Upstream
  const settler = yield* Settler
  const proxy = yield* Proxy
  const clock = yield* Clock.Clock
  const now = () => clock.currentTimeMillisUnsafe()
  const layerScope = yield* Effect.scope
  const run = Effect.runCallbackWith(yield* Effect.context<never>())
  // Handshakes and each relay's end run here, so shutdown interrupts what is
  // still dialing and leaves nothing behind.
  const handshaking = yield* FiberSet.makeRuntime<never>()
  const finishing = yield* FiberSet.makeRuntime<never>()
  const provider = providers.codex
  const hooks = yield* Option.match(provider.socket, {
    onNone: () => Effect.die(new Error("the Codex provider has no socket hooks")),
    onSome: Effect.succeed,
  })
  const live = new Set<SocketState>()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const state of live) state.sides.cut()
      live.clear()
    }),
  )

  const log = (text: string): void => void run(Effect.logInfo(text))

  /** Starts the relay's end once, when the first side closes. */
  const ended = (state: SocketState): void => {
    if (state.finishing) return
    state.finishing = true
    finishing(
      Effect.ensuring(
        finishRelay(state.sides),
        Effect.suspend(() => {
          live.delete(state)
          return Scope.close(state.scope, Exit.void)
        }),
      ),
    )
  }

  /** Pauses reading upstream while the client is full or frames are held; resumes once neither holds. */
  const flow = (state: SocketState): void => {
    const pause = state.clientFull || state.holding
    if (pause === state.paused) return
    state.paused = pause
    if (pause) state.upstream.pause()
    else state.upstream.resume()
  }

  const closeClient = (state: SocketState, code?: number, reason?: string): void => {
    if (state.clientClosing) return
    state.clientClosing = true
    state.client?.close(code, reason)
    ended(state)
  }

  const closeUpstream = (state: SocketState, code?: number, reason?: string): void => {
    if (state.upstreamClosing) return
    state.upstreamClosing = true
    const up = state.upstream
    if (up.readyState === ReadyState.open || up.readyState === ReadyState.connecting) {
      if (code === undefined) up.close()
      else up.close(code, reason)
    }
    ended(state)
  }

  const toClient = (state: SocketState, data: string | Uint8Array): void => {
    const client = state.client
    if (client === undefined || state.clientClosing) return
    if (client.send(data) === -1) {
      state.clientFull = true
      flow(state)
    }
  }

  /** Lets held frames through, in order, until one holds them again or the client is full. */
  const pump = (state: SocketState): void => {
    while (!state.holding && !state.clientFull && state.held.length > 0) {
      const next = state.held.shift()
      if (next !== undefined) deliver(state, next)
    }
    flow(state)
  }

  const release = (state: SocketState): void => {
    state.holding = false
    pump(state)
  }

  /** The upstream's close, passed on: as it came, or 1011 when the upstream went away without one. */
  const upstreamEnded = (state: SocketState, code: number, reason: string): void => {
    if (code === 1006) closeClient(state, upstreamGoneClose.code, upstreamGoneClose.reason)
    else if (sendable(code)) closeClient(state, code, reason)
    else closeClient(state)
  }

  /** A rate-limit event: the pool reads it, and the client hears the pool's windows when it has any. */
  const rateLimits = (state: SocketState, text: string): void => {
    const event = Option.getOrUndefined(parseJson(text))
    if (event === undefined) return toClient(state, text)
    state.holding = true
    flow(state)
    const read = Effect.gen(function* () {
      const at = yield* DateTime.now
      const limits = hooks.limitsFromEvent(event, at)
      if (Option.isSome(limits)) yield* pool.update((m, time) => observe(m, state.account, limits.value, time))
      const windows = yield* pool.pooled(codex)
      return windows.length > 0 && isRecord(event) ? JSON.stringify(hooks.showPoolInEvent(event, windows)) : text
    })
    run(read, {
      onExit: (exit) => {
        // First in line, still behind a full client.
        state.held.unshift(Held.Read({ text: Exit.isSuccess(exit) ? exit.value : text }))
        release(state)
      },
    })
  }

  /** A finished turn: the account served, and the ledger records it. */
  const finished = (state: SocketState, text: string): void => {
    const event = Option.getOrUndefined(parseJson(text))
    const turn = state.turn
    state.turn = noTurn()
    const endedAt = now()
    const id = state.account
    settler.offer(Settlement.Pool({ change: (m, time) => succeeded(m, id, undefined, time) }))
    settler.offer(
      Settlement.Served({
        account: id,
        provider: codex,
        model: turn.model,
        status: 200,
        report: {
          how: "ended",
          outcome: turnOutcome(event),
          ...(turn.firstByteAt === undefined ? {} : { firstByteAt: turn.firstByteAt }),
        },
        startedAt: turn.startedAt ?? endedAt,
        endedAt,
        attempts: 1,
        agent: state.agent,
        session: state.session,
        via: "socket",
      }),
    )
  }

  /**
   * A failure event: when it is the account's (spent, or throttled), the
   * account sits out and both sides close, so Codex reconnects elsewhere.
   * The turn is left unfinished, and the event is not passed on.
   */
  const failure = (state: SocketState, text: string): boolean => {
    const event = Option.getOrUndefined(parseJson(text))
    if (event === undefined) return false
    const at = DateTime.makeUnsafe(now())
    const verdict = hooks.eventVerdict(event, at)
    if (Option.isNone(verdict)) return false
    const id = state.account
    const found = verdict.value
    if (found._tag === "Exhausted") {
      const until = found.until ?? DateTime.addDuration(at, defaultBlock)
      settler.offer(Settlement.Pool({ change: (m) => block(m, id, until, found.model, "usage limit reached") }))
      log(`${id}: limited inside a websocket; closing it`)
    } else if (found._tag === "Throttled") {
      const until = found.until ?? DateTime.addDuration(at, defaultThrottle)
      settler.offer(Settlement.Pool({ change: (m) => throttle(m, id, until) }))
      log(`${id}: throttled inside a websocket; closing it`)
    } else {
      return false
    }
    closeUpstream(state)
    closeClient(state, limitedClose.code, limitedClose.reason)
    return true
  }

  /** One upstream frame or close, on its way to the client. */
  const deliver = (state: SocketState, held: Held): void => {
    if (held._tag === "Closed") return upstreamEnded(state, held.code, held.reason)
    if (held._tag === "Read") return toClient(state, held.text)
    const { bytes, binary } = held
    if (binary) return toClient(state, bytes)
    const type = scan.findString(bytes, "type")
    if (type !== undefined) state.turn.firstByteAt ??= now()
    const text = utf8.decode(bytes)
    switch (eventKind(type)) {
      case "rateLimits":
        return rateLimits(state, text)
      case "finished":
        finished(state, text)
        break
      case "failed":
        if (failure(state, text)) return
        break
      case "other":
        break
    }
    toClient(state, text)
  }

  const fromUpstream = (state: SocketState, held: Held): void => {
    if (state.holding || state.clientFull || state.held.length > 0) state.held.push(held)
    else deliver(state, held)
  }

  /** The upstream side's messages and close. Bun's `ws` answers its pings itself. */
  const attach = (state: SocketState, socket: UpstreamSocket): void =>
    socket.listen({
      message: (bytes, binary) => fromUpstream(state, Held.Frame({ bytes, binary })),
      close: (code, reason) => {
        state.upstreamClosed = true
        fromUpstream(state, Held.Closed({ code, reason }))
        state.closedOne()
      },
    })

  /** A client text on its way up: a new turn starts its clock, and a moved socket drops the old account's state. */
  const outgoing = (state: SocketState, text: string): string => {
    if (!startsTurn(text)) return text
    const started = startTurn(text, state.moved, hooks.rebindTurn)
    if (started === undefined) return text
    state.turn = { startedAt: now(), model: started.model, firstByteAt: undefined }
    return started.text
  }

  /** Bun's handlers for Codex's side. Bun answers its pings itself. */
  const websocket: Bun.WebSocketHandler<unknown> = {
    maxPayloadLength: maxMessage,
    open: (ws) => {
      const state = ws.data
      if (!(state instanceof SocketState)) return ws.close()
      state.client = ws
      release(state)
    },
    message: (ws, message) => {
      const state = ws.data
      if (!(state instanceof SocketState) || state.upstreamClosing) return
      const up = state.upstream
      if (up.readyState !== ReadyState.open) return
      if (tooFarBehind(up.bufferedAmount)) {
        closeUpstream(state)
        return closeClient(state, behindClose.code, behindClose.reason)
      }
      up.send(typeof message === "string" ? outgoing(state, message) : message)
    },
    drain: (ws) => {
      const state = ws.data
      if (!(state instanceof SocketState)) return
      state.clientFull = false
      pump(state)
    },
    close: (ws, code, reason) => {
      const state = ws.data
      if (!(state instanceof SocketState)) return
      state.clientClosed = true
      state.clientClosing = true
      // A close is passed on as it came; a client gone without one gets a bare close upstream.
      if (sendable(code)) closeUpstream(state, code, reason)
      else closeUpstream(state)
      ended(state)
      state.closedOne()
    },
  }

  const handshake = Effect.fn("Relay.accept")(function* (
    request: Request,
    server: SocketServer | undefined,
    route: Route,
  ) {
    const values = yield* settings.get
    const headers = request.headers
    const caller = authenticate(headers, keyRing(values))
    if (caller === undefined) return noKey(route.dialect)
    const screened = screen(values.websockets, route, caller, headers)
    switch (screened._tag) {
      case "Refuse":
        return yield* refuse(screened.why)
      case "MissingKey":
        return error(undefined, 400, "missing Sec-WebSocket-Key")
      case "WrongVersion":
        return wrongVersion()
      case "Open":
        break
    }
    yield* proxy.noteAgents(headers)

    // Codex names the model in its routing hint; a socket serves only models ChatGPT serves as named.
    const model = screened.model
    const agent = detect(headers)
    const empty = new Uint8Array(0)
    const session = agent?.session(headers, empty) ?? commonSession(headers, empty)
    const list = yield* accounts.list
    let candidates: ReadonlyArray<AccountId>
    if (model === undefined) {
      candidates = list.filter((account) => account.provider === codex).map((account) => account.id)
    } else {
      const planned = plan(
        { accounts: list, settings: values },
        { model, dialect: "responses", agent: agent?.id, pathProvider: codex },
      )
      const first = planned._tag === "Steps" ? planned.steps[0] : undefined
      if (first === undefined || first.provider !== codex || first.model !== model) {
        return yield* refuse("the model is not served by a ChatGPT account")
      }
      candidates = first.accounts
    }
    const picked = yield* pool.modify((m, at) =>
      pick(
        m,
        {
          ...routingOf(values, affinityOverride(headers.get("x-slopmax-affinity"))),
          provider: codex,
          candidates,
          model,
          session,
          housekeeping: false,
          exclude: new Set(),
        },
        at,
      ),
    )
    if (picked._tag === "NoneReady") return yield* refuse("no ChatGPT account can serve now")
    const id = picked.account.id
    const moved = picked.movedFrom !== undefined
    if (moved) yield* Effect.logInfo(`${id}: takes over a session from ${picked.movedFrom}`)
    const readied = yield* Effect.result(accounts.ready(picked.account))
    if (readied._tag === "Failure") {
      yield* Effect.logWarning(`${id}: ${readied.failure.message}`)
      yield* pool.update((m) => failed(m, id, readied.failure.message))
      return yield* refuse("the account's sign-in could not be refreshed")
    }
    // Without a listener (the front door in process) there is no connection to upgrade.
    if (server === undefined) return yield* refuse("nothing to upgrade the socket through")
    const account = readied.success
    const seen = yield* pool.model
    const built = provider.headers({
      client: withoutHandshake(headers),
      account,
      moved,
      agents: seen.agents,
      codex: seen.codex,
    })

    const scope = yield* Scope.fork(layerScope)
    let handedOver = false
    return yield* Effect.gen(function* () {
      const dialed = yield* Effect.result(
        upstream
          .dial(`${provider.apiOf(account).replace(/\/+$/, "")}/responses`, upstreamHeaders(built))
          .pipe(Scope.provide(scope)),
      )
      if (dialed._tag === "Failure") {
        yield* Effect.logWarning(`${id}: websocket handshake failed: ${dialed.failure.message}`)
        return yield* refuse("the upstream handshake failed")
      }
      const state = new SocketState(id, moved, agent?.id, session, dialed.success.raw, scope)
      attach(state, dialed.success)
      // Bun writes the 101 with the accept key for Codex's own key; `open` runs before this returns.
      const upgraded = server.upgrade(request, { headers: answerHeaders(dialed.success.headers), data: state })
      if (!upgraded) {
        yield* Effect.logWarning(`${id}: the client's websocket upgrade failed`)
        return refusal()
      }
      handedOver = true
      live.add(state)
      yield* Effect.logInfo(`websocket opened on ${id}`)
      return undefined
    }).pipe(Effect.onExit(() => (handedOver ? Effect.void : Scope.close(scope, Exit.void))))
  })

  const accept = (request: Request, server: SocketServer | undefined, route: Route): Promise<Response | undefined> =>
    new Promise((resolve) => {
      handshaking(
        handshake(request, server, route).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.sync(() => resolve(exit.value))
            // Whatever went wrong, Codex still streams over HTTP rather than retrying the socket.
            return Effect.logInfo(
              `websocket refused (the handshake failed: ${Cause.pretty(exit.cause)}); Codex will stream over HTTP`,
            ).pipe(Effect.ensuring(Effect.sync(() => resolve(refusal()))))
          }),
          Effect.ignore,
        ),
        // Codex gone before its socket opens takes the handshake with it.
        { signal: request.signal },
      )
    })

  return { accept, websocket } satisfies RelayShape
})

/**
 * Relays Codex's WebSockets to ChatGPT, over the proxy's own pool, settler
 * and accounts; for the life of the layer, which cuts the sockets still open
 * when it closes.
 */
export const relayLayer: Layer.Layer<Relay, never, SettingsService | Accounts | Pool | Upstream | Settler | Proxy> =
  Layer.effect(Relay, make)
