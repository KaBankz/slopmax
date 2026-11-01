// Codex's WebSocket relay: what it decides from a handshake and from each
// frame, what it refuses (so Codex streams over HTTP), and, end to end on
// real sockets, what Codex and ChatGPT each see through it.
import { describe, expect } from "bun:test"
import { AccountId, ClientKey, KeyName } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { type Context, DateTime, Duration, Effect, Fiber, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { Account, Credential, Identity, Tokens } from "../../src/account.ts"
import { block, observe, Pool } from "../../src/pool.ts"
import { Caller } from "../../src/proxy/auth.ts"
import { routeFor } from "../../src/proxy/classify.ts"
import {
  answerHeaders,
  behindClose,
  eventKind,
  finishRelay,
  limitedClose,
  maxBehind,
  routingModel,
  Screen,
  screen,
  type Sides,
  sendable,
  socketsBeta,
  startsTurn,
  startTurn,
  tooFarBehind,
  turnOutcome,
  upstreamGoneClose,
  upstreamHeaders,
  withoutHandshake,
} from "../../src/proxy/socket.ts"
import { eventVerdict, limitsFromEvent, rebindTurn } from "../../src/providers/codex.ts"
import { Server } from "../../src/server.ts"
import { openClient, patterned, patternedText } from "../dial/support.ts"
import { apiKey, health, key, ledger, oauth, type Options, proxyStack, settled } from "../proxy/stack.ts"
import { chatgptApi, json, on } from "../support/memory-upstream.ts"
import { chatgpt, floodSize, rateLimits, stalledChatgpt } from "./chatgpt.ts"

const socketHeaders = (model: string | undefined, extra: Readonly<Record<string, string>> = {}) => ({
  authorization: `Bearer ${key}`,
  "user-agent": "codex_exec/0.159.3 (Linux; x86_64)",
  "session-id": "ws-session",
  ...(model === undefined ? {} : { "x-codex-routing-hint": `model=${model};tier=priority` }),
  ...extra,
})

/** The pool, as a test reaches it. */
const poolService = Effect.gen(function* () {
  return yield* Pool
})

/** An event's `type`. */
const typeOf = (event: unknown): unknown =>
  typeof event === "object" && event !== null && "type" in event ? event.type : undefined

const create = { type: "response.create", model: "gpt-6-sol", input: [], stream: true }

const codexRoute = (path = "/codex/responses") => {
  const route = routeFor("GET", path, new Headers({ upgrade: "websocket" }))
  if (route === undefined) throw new Error(`no route for ${path}`)
  return route
}

const handshake = (extra: Readonly<Record<string, string>> = {}) =>
  new Headers({ "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...extra })

const owner = Caller.Owner()

/** Why a handshake was refused, if it was. */
const whyRefused = (value: Screen) => (value._tag === "Refuse" ? value.why : undefined)

describe("the socket relay, deciding from a handshake", () => {
  it("reads the model from Codex's routing hint", () => {
    expect(routingModel(new Headers())).toBeUndefined()
    expect(routingModel(new Headers({ "x-codex-routing-hint": "model=gpt-6-sol;tier=priority" }))).toBe("gpt-6-sol")
    expect(routingModel(new Headers({ "x-codex-routing-hint": "tier=flex; model=gpt-6-sol-mini " }))).toBe(
      "gpt-6-sol-mini",
    )
    expect(routingModel(new Headers({ "x-codex-routing-hint": "model=;tier=flex" }))).toBeUndefined()
  })

  it("refuses sockets that are off, off Codex's /responses, or for a key held to some models", () => {
    const held = Caller.Client({
      key: new ClientKey({ name: KeyName.make("laptop"), key: Redacted.make("sm-laptop"), models: ["gpt-6-*"] }),
    })
    const free = Caller.Client({
      key: new ClientKey({ name: KeyName.make("ci"), key: Redacted.make("sm-ci"), models: [] }),
    })
    expect(whyRefused(screen(false, codexRoute(), owner, handshake()))).toBe("websockets are off in the settings")
    expect(whyRefused(screen(true, codexRoute("/codex/models"), owner, handshake()))).toBe(
      "only Codex's /responses is relayed",
    )
    expect(whyRefused(screen(true, codexRoute("/claude/v1/messages"), owner, handshake()))).toBe(
      "only Codex's /responses is relayed",
    )
    expect(whyRefused(screen(true, codexRoute(), held, handshake()))).toBe("the key is held to some models")
    expect(screen(true, codexRoute(), free, handshake())).toEqual(Screen.Open({ model: undefined }))
    expect(screen(true, codexRoute("/v1/responses"), owner, handshake())._tag).toBe("Open")
  })

  it("asks for a handshake key and the protocol version slopmax speaks", () => {
    expect(screen(true, codexRoute(), owner, new Headers({ "sec-websocket-version": "13" }))._tag).toBe("MissingKey")
    expect(screen(true, codexRoute(), owner, handshake({ "sec-websocket-version": "8" }))._tag).toBe("WrongVersion")
    expect(
      screen(
        true,
        codexRoute(),
        owner,
        handshake({ "sec-websocket-version": " 13 ", "x-codex-routing-hint": "model=m" }),
      ),
    ).toEqual(Screen.Open({ model: "m" }))
  })

  it("hands ChatGPT the client's headers without its own handshake, uncompressed, in ChatGPT's socket protocol", () => {
    const client = handshake({
      "sec-websocket-extensions": "permessage-deflate",
      "sec-websocket-protocol": "chat",
      "session-id": "s",
      "accept-encoding": "gzip",
    })
    const own = withoutHandshake(client)
    expect([...own.keys()].toSorted()).toEqual(["accept-encoding", "session-id"])
    const sent = upstreamHeaders(own)
    expect(sent.get("accept-encoding")).toBeNull()
    expect(sent.get("openai-beta")).toBe(socketsBeta)
    expect(upstreamHeaders(new Headers({ "openai-beta": "responses_websockets=2099-01-01" })).get("openai-beta")).toBe(
      "responses_websockets=2099-01-01",
    )
  })

  it("copies the model, reasoning and model-list tag from ChatGPT's 101", () => {
    const upstream = new Headers({
      "openai-model": "gpt-6-sol",
      "x-reasoning-included": "true",
      "x-models-etag": "e1",
      "sec-websocket-accept": "abc",
      "set-cookie": "x",
    })
    expect(answerHeaders(upstream)).toEqual({
      "openai-model": "gpt-6-sol",
      "x-reasoning-included": "true",
      "x-models-etag": "e1",
    })
  })
})

describe("the socket relay, deciding from a frame", () => {
  const withState = {
    type: "response.create",
    model: "gpt-6-sol",
    previous_response_id: "resp_1",
    input: [{ type: "reasoning", summary: [], encrypted_content: "gAAA" }],
    client_metadata: { "x-codex-turn-state": "sticky", session_id: "s" },
  }

  it("starts a turn on response.create, keeping its text as sent unless a moved socket drops state", () => {
    const text = JSON.stringify(withState)
    expect(startsTurn(text)).toBe(true)
    const kept = startTurn(text, false, rebindTurn)
    expect(kept).toEqual({ model: "gpt-6-sol", text })
    const moved = startTurn(text, true, rebindTurn)
    expect(moved?.model).toBe("gpt-6-sol")
    const sent: unknown = JSON.parse(moved?.text ?? "{}")
    expect(sent).toEqual({
      type: "response.create",
      model: "gpt-6-sol",
      input: [{ type: "reasoning", summary: [] }],
      client_metadata: { session_id: "s" },
    })
    // Nothing to drop: the text goes on byte for byte even on a moved socket.
    const clean = '{"type":"response.create",  "model":"gpt-6-sol","input":[]}'
    expect(startTurn(clean, true, rebindTurn)?.text).toBe(clean)
    // A model named after other members is still read, from the whole turn.
    const late = '{"type":"response.create","input":[],"model":"gpt-6-sol-mini"}'
    expect(startTurn(late, false, rebindTurn)).toEqual({ model: "gpt-6-sol-mini", text: late })
    expect(startTurn('{"type":"response.create","input":[]}', false, rebindTurn)).toEqual({
      model: undefined,
      text: '{"type":"response.create","input":[]}',
    })
  })

  it("reads only client texts that start a turn", () => {
    expect(startsTurn('{"type":"response.cancel"}')).toBe(false)
    expect(startsTurn('{"model":"m","type":"response.create"}')).toBe(false)
    expect(startsTurn(' { "type" : "response.create", "input": []}')).toBe(true)
    expect(startTurn("not json", false, rebindTurn)).toBeUndefined()
  })

  it("names what an upstream event is from its type alone", () => {
    expect(eventKind("codex.rate_limits")).toBe("rateLimits")
    expect(eventKind("response.completed")).toBe("finished")
    expect(eventKind("response.incomplete")).toBe("finished")
    expect(eventKind("response.done")).toBe("finished")
    expect(eventKind("response.failed")).toBe("failed")
    expect(eventKind("error")).toBe("failed")
    expect(eventKind("response.output_text.delta")).toBe("other")
    expect(eventKind(undefined)).toBe("other")
  })

  it("closes the socket for a spent or throttled account, and lets the request's own failures pass", () => {
    const now = DateTime.makeUnsafe(1_000_000)
    const spent = eventVerdict(
      { type: "error", status: 429, error: { type: "usage_limit_reached", resets_at: 5_000 } },
      now,
    )
    expect(Option.map(spent, (verdict) => verdict._tag)).toEqual(Option.some("Exhausted"))
    if (Option.isSome(spent) && spent.value._tag === "Exhausted") {
      expect(spent.value.until).toEqual(DateTime.makeUnsafe(5_000_000))
      expect(spent.value.model).toBeUndefined()
    }
    const busy = eventVerdict({ type: "response.failed", response: { error: { code: "server_is_overloaded" } } }, now)
    expect(Option.map(busy, (verdict) => verdict._tag)).toEqual(Option.some("Throttled"))
    const request = eventVerdict(
      { type: "response.failed", response: { error: { code: "context_length_exceeded" } } },
      now,
    )
    expect(Option.isNone(request)).toBe(true)
  })

  it("counts a finished turn's usage, or one request when it names none", () => {
    const usage = turnOutcome({
      type: "response.completed",
      response: { usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 4 } },
    }).usage
    expect([usage.requests, usage.input, usage.cacheRead, usage.output]).toEqual([1, 30, 20, 4])
    const none = turnOutcome({ type: "response.done" }).usage
    expect([none.requests, none.input, none.output]).toEqual([1, 0, 0])
  })

  it("passes on only the close codes a socket may send", () => {
    expect([1000, 1011, 1012, 4000, 4999].every(sendable)).toBe(true)
    expect([999, 1004, 1005, 1006, 1015, 5000].some(sendable)).toBe(false)
  })

  it("tells a client too far ahead of ChatGPT to back off", () => {
    expect(tooFarBehind(maxBehind - 1)).toBe(false)
    expect(tooFarBehind(maxBehind)).toBe(true)
    expect(behindClose.code).toBe(1013)
  })
})

/** Two sides that close after `closedAfter` on the clock, or never. */
const sides = (closedAfter: Duration.Duration | undefined) =>
  Effect.gen(function* () {
    const seen = { cut: false, closed: false }
    let wake: (() => void) | undefined
    if (closedAfter !== undefined) {
      yield* Effect.sleep(closedAfter).pipe(
        Effect.andThen(
          Effect.sync(() => {
            seen.closed = true
            wake?.()
          }),
        ),
        Effect.forkChild,
      )
    }
    const both: Sides = {
      closed: () => seen.closed,
      onClosed: (next) => {
        wake = next
      },
      cut: () => {
        seen.cut = true
      },
    }
    return { seen, both }
  })

describe("the socket relay's end", () => {
  it.effect("gives each side five seconds to send what it queued, then cuts what is still open", () =>
    Effect.gen(function* () {
      const { seen, both } = yield* sides(undefined)
      const ending = yield* Effect.forkChild(finishRelay(both))
      yield* Effect.yieldNow
      yield* TestClock.adjust("4 seconds")
      expect(ending.pollUnsafe()).toBeUndefined()
      expect(seen.cut).toBe(false)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(ending)
      expect(seen.cut).toBe(true)
    }),
  )

  it.effect("ends as soon as both sides have closed", () =>
    Effect.gen(function* () {
      const { seen, both } = yield* sides(Duration.seconds(1))
      const ending = yield* Effect.forkChild(finishRelay(both))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(ending)
      // Cutting what already closed does nothing; it is still asked, as the end always is.
      expect(seen.closed).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// Refusals, through the front door in process

/** A handshake as Codex sends it, to the front door in process. */
const socketRequest = (headers: Readonly<Record<string, string>>, path = "/codex/responses") =>
  new Request(`http://slopmax.test${path}`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  })

const answer = (request: Request) =>
  Effect.gen(function* () {
    const server = yield* Server
    const response = yield* Effect.promise(() => Promise.resolve(server.fetch(request)))
    const body: unknown = yield* Effect.promise(() => response.json())
    return { status: response.status, headers: response.headers, body }
  })

const inProcess = (options: Omit<Options, "sockets">) => proxyStack({ ...options, sockets: {} })

const refusalBody = { error: { type: "invalid_request_error", message: "slopmax relays this over HTTP streaming" } }

describe("the socket relay, refusing", () => {
  it.effect("answers 426 in Responses' shape when websockets are off, so Codex streams over HTTP", () => {
    const stack = inProcess({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-ok", 0)],
      settings: { websockets: false },
    })
    return Effect.gen(function* () {
      const refused = yield* answer(socketRequest(socketHeaders("gpt-6-sol")))
      expect(refused.status).toBe(426)
      expect(refused.body).toMatchObject(refusalBody)
      expect(stack.upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("needs slopmax's key", () => {
    const stack = inProcess({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const refused = yield* answer(socketRequest({ ...socketHeaders("gpt-6-sol"), authorization: "Bearer nope" }))
      expect(refused.status).toBe(401)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("sends a key held to some models to HTTP, where each request is checked", () => {
    const stack = inProcess({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-ok", 0)],
      settings: { keys: [{ name: "laptop", key: "sm-laptop", models: ["gpt-6-*"] }] },
    })
    return Effect.gen(function* () {
      const refused = yield* answer(socketRequest({ ...socketHeaders("gpt-6-sol"), authorization: "Bearer sm-laptop" }))
      expect(refused.status).toBe(426)
      expect(refused.body).toMatchObject(refusalBody)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("asks for a handshake key, and for protocol version 13", () => {
    const stack = inProcess({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const request = socketRequest(socketHeaders("gpt-6-sol"))
      const noKey = new Request(request, { headers: new Headers(request.headers) })
      noKey.headers.delete("sec-websocket-key")
      const missing = yield* answer(noKey)
      expect(missing.status).toBe(400)
      expect(missing.body).toMatchObject({ type: "error", error: { message: "missing Sec-WebSocket-Key" } })
      const old = yield* answer(socketRequest({ ...socketHeaders("gpt-6-sol"), "sec-websocket-version": "8" }))
      expect(old.status).toBe(426)
      expect(old.headers.get("sec-websocket-version")).toBe("13")
      expect(old.body).toMatchObject(refusalBody)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("sends models no ChatGPT account serves as named to HTTP", () => {
    const stack = inProcess({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-ok", 0), apiKey("xai", "x", "key-xai", 1)],
      settings: { aliases: { fast: "gpt-6-sol-mini" } },
    })
    return Effect.gen(function* () {
      // Translated for another provider, or renamed by an alias: both need HTTP.
      expect((yield* answer(socketRequest(socketHeaders("grok-4")))).status).toBe(426)
      expect((yield* answer(socketRequest(socketHeaders("fast")))).status).toBe(426)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("refuses when no ChatGPT account can serve now", () => {
    const stack = inProcess({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const pool = yield* Pool
      yield* pool.update((m, now) =>
        block(m, AccountId.make("codex-a"), DateTime.addDuration(now, Duration.hours(1)), undefined, "spent"),
      )
      const refused = yield* answer(socketRequest(socketHeaders("gpt-6-sol")))
      expect(refused.status).toBe(426)
      // With no hint every ChatGPT account is a candidate, and none is ready either.
      expect((yield* answer(socketRequest(socketHeaders(undefined)))).status).toBe(426)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("refuses when the account's sign-in cannot be refreshed", () => {
    const expired = new Account({
      id: AccountId.make("codex-old"),
      provider: "codex",
      credential: Credential.cases.OAuth.make({
        tokens: new Tokens({
          access: Redacted.make("tok-old"),
          refresh: Redacted.make("refresh-revoked"),
          expiresAt: DateTime.makeUnsafe(0),
        }),
      }),
      identity: new Identity({ accountId: "acct-old" }),
      addedAt: DateTime.makeUnsafe(0),
    })
    const stack = inProcess({
      routes: [
        ...chatgptApi,
        on("POST https://auth.openai.com/oauth/token", () => json(400, { error: "invalid_grant" })),
      ],
      accounts: [expired],
      settings: { refreshTokens: true },
    })
    return Effect.gen(function* () {
      yield* TestClock.setTime(Duration.toMillis(Duration.hours(1)))
      const refused = yield* answer(socketRequest(socketHeaders("gpt-6-sol")))
      expect(refused.status).toBe(426)
      expect(stack.upstream.paths()).toContain("/oauth/token")
    }).pipe(Effect.provide(stack.layer))
  })
})

// ---------------------------------------------------------------------------
// End to end, on real sockets

/** The proxy on a loopback port with the relay on, dialing ChatGPT at `endpoint`, for the life of the test. */
const listening = (options: Omit<Options, "sockets">, endpoint: { readonly origin: string }) =>
  Effect.gen(function* () {
    const stack = proxyStack({
      ...options,
      settings: { listen: "127.0.0.1:0", ...options.settings },
      listen: true,
      sockets: { "https://chatgpt.com": endpoint.origin },
    })
    const context = yield* Layer.build(stack.layer)
    const server = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* Server
      }),
      context,
    )
    return { stack, context, url: `ws://${server.address}/codex/responses` }
  })

type Built = Context.Context<Layer.Success<ReturnType<typeof proxyStack>["layer"]>>

/** Runs `effect` on the services of a stack built by {@link listening}. */
const within =
  (context: Built) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, context)

describe("the socket relay end to end", () => {
  it.live("relays Codex's socket to ChatGPT on one account, and records the turn", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url, context } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0)] },
        endpoint,
      )
      const client = yield* openClient(url, socketHeaders("gpt-6-sol", { "accept-encoding": "gzip" }))
      // Bun answered with the accept key for Codex's own key (the client checks it) and ChatGPT's three headers.
      expect(client.upgrade.get("openai-model")).toBe("gpt-6-sol")
      expect(client.upgrade.get("x-reasoning-included")).toBe("true")
      expect(client.upgrade.get("x-models-etag")).toBe("etag-1")
      expect(client.upgrade.get("upgrade")?.toLowerCase()).toBe("websocket")

      client.sendJson(create)
      const events = yield* client.until("response.completed")
      expect(events.map(typeOf)).toEqual([
        "response.created",
        "codex.rate_limits",
        "response.output_text.delta",
        "response.completed",
      ])

      const [upgrade] = endpoint.handshakes
      expect(upgrade?.path).toBe("/backend-api/codex/responses")
      expect(upgrade?.headers.get("authorization")).toBe("Bearer tok-ok")
      expect(upgrade?.headers.get("openai-beta")).toBe(socketsBeta)
      expect(upgrade?.headers.get("chatgpt-account-id")).toBe("acct-a")
      expect(upgrade?.headers.get("accept-encoding")).toBeNull()
      expect(upgrade?.headers.get("sec-websocket-key")).not.toBe("dGhlIHNhbXBsZSBub25jZQ==")
      expect(endpoint.sent("tok-ok")).toEqual([create])

      const records = yield* within(context)(ledger)
      expect(records).toHaveLength(1)
      const [record] = records
      expect(record).toMatchObject({
        _tag: "Request",
        account: "codex-a",
        provider: "codex",
        model: "gpt-6-sol",
        status: 200,
        attempts: 1,
        agent: "codex",
        session: "ws-session",
        via: "socket",
      })
      if (record?._tag === "Request") {
        expect([record.usage.requests, record.usage.input, record.usage.cacheRead, record.usage.output]).toEqual([
          1, 30, 20, 4,
        ])
        expect(record.firstByteMs).toBeDefined()
      }
      const account = yield* within(context)(health("codex-a"))
      expect(account.limits.windows[0]?.used).toBe(33)
      expect(account.lastUsed).toBeDefined()
    }),
  )

  it.live("shows Codex the pool's windows, not the account's", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url, context } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0), oauth("codex", "b", "tok-also", 1)] },
        endpoint,
      )
      yield* within(context)(
        Effect.flatMap(poolService, (pool) =>
          pool.update((m, now) => {
            const limits = Option.getOrUndefined(limitsFromEvent(rateLimits(0), now))
            return limits === undefined ? m : observe(m, AccountId.make("codex-b"), limits, now)
          }),
        ),
      )
      const client = yield* openClient(url, socketHeaders("gpt-6-sol"))
      client.sendJson(create)
      const events = yield* client.until("response.completed")
      const shown = events.find((event) => typeOf(event) === "codex.rate_limits")
      // The serving account used 33% of its 5-hour window; the other none.
      expect(shown).toMatchObject({
        rate_limits: { primary: { used_percent: 16.5, window_minutes: 300 }, limit_reached: false },
      })
    }),
  )

  it.live("closes a spent account's socket so Codex reconnects on another", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url, context } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-limited", 0), oauth("codex", "b", "tok-ok", 1)] },
        endpoint,
      )
      const first = yield* openClient(url, socketHeaders("gpt-6-sol"))
      first.sendJson(create)
      // The limit is not passed on: the socket closes, and Codex retries elsewhere.
      const message = yield* first.next
      expect(message).toMatchObject({ _tag: "Closed", code: limitedClose.code, reason: limitedClose.reason })
      yield* within(context)(settled)
      const spent = yield* within(context)(health("codex-a"))
      expect(spent.blockedUntil).toBeDefined()
      expect(spent.lastError).toBe("usage limit reached")

      const second = yield* openClient(url, socketHeaders("gpt-6-sol"))
      second.sendJson(create)
      yield* second.until("response.completed")
      expect(endpoint.handshakes.map((each) => each.token)).toEqual(["tok-limited", "tok-ok"])
      // The upstream heard a bare close from slopmax.
      expect(endpoint.closes.find((each) => each.token === "tok-limited")?.code).toBe(1005)
    }),
  )

  it.live("closes a throttled account's socket too, and passes the request's own failures on", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url, context } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-busy", 0), oauth("codex", "b", "tok-badreq", 1)] },
        endpoint,
      )
      const busy = yield* openClient(url, socketHeaders("gpt-6-sol"))
      busy.sendJson(create)
      expect((yield* busy.closed).code).toBe(limitedClose.code)
      yield* within(context)(settled)
      expect((yield* within(context)(health("codex-a"))).throttledUntil).toBeDefined()

      const failing = yield* openClient(url, socketHeaders("gpt-6-sol"))
      failing.sendJson(create)
      const [failure] = yield* failing.until("response.failed")
      expect(failure).toMatchObject({ response: { error: { code: "context_length_exceeded" } } })
      yield* within(context)(settled)
      const fine = yield* within(context)(health("codex-b"))
      expect([fine.blockedUntil, fine.throttledUntil]).toEqual([undefined, undefined])
    }),
  )

  it.live("refuses with 426 when ChatGPT's handshake fails, without upgrading Codex", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-revoked", 0)] },
        endpoint,
      )
      const refused = yield* Effect.flip(openClient(url, socketHeaders("gpt-6-sol")))
      expect(refused.status).toBe(426)
      expect(endpoint.handshakes.map((each) => each.token)).toEqual(["tok-revoked"])
    }),
  )

  it.live("drops the old account's state from turns on a socket whose session moved", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url, context } = yield* listening(
        { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0), oauth("codex", "b", "tok-also", 1)] },
        endpoint,
      )
      const stateful = {
        ...create,
        previous_response_id: "resp_1",
        input: [{ type: "reasoning", summary: [], encrypted_content: "gAAA" }],
        client_metadata: { "x-codex-turn-state": "sticky", session_id: "s" },
      }
      const first = yield* openClient(url, socketHeaders("gpt-6-sol"))
      first.sendJson(stateful)
      yield* first.until("response.completed")
      first.raw.close(1000)
      // On the account it started on, the turn goes up byte for byte.
      expect(endpoint.got.find((each) => each.token === "tok-ok")?.message).toBe(JSON.stringify(stateful))

      yield* within(context)(
        Effect.flatMap(poolService, (pool) =>
          pool.update((m, now) =>
            block(m, AccountId.make("codex-a"), DateTime.addDuration(now, Duration.hours(1)), undefined, "spent"),
          ),
        ),
      )
      const moved = yield* openClient(url, socketHeaders("gpt-6-sol", { "x-codex-turn-state": "sticky" }))
      moved.sendJson(stateful)
      yield* moved.until("response.completed")
      const movedHandshake = endpoint.handshakes.find((each) => each.token === "tok-also")
      expect(movedHandshake?.headers.get("x-codex-turn-state")).toBeNull()
      expect(endpoint.sent("tok-also")).toEqual([
        {
          ...create,
          input: [{ type: "reasoning", summary: [] }],
          client_metadata: { session_id: "s" },
        },
      ])
    }),
  )

  it.live("answers pings on each side without passing them on", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url } = yield* listening({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-echo", 0)] }, endpoint)
      const client = yield* openClient(url, socketHeaders(undefined))
      const pong = Effect.callback<void>((resume) => {
        client.raw.once("pong", () => resume(Effect.void))
      })
      client.raw.ping()
      yield* pong
      // ChatGPT pings: slopmax's side answers it, and the client hears nothing of it.
      client.raw.send("ping-me")
      expect(yield* client.next).toMatchObject({ _tag: "Text", text: "ponged" })
      expect(endpoint.pings).toEqual([])
    }),
  )

  it.live("passes a client's close up as it came, and a vanished client as a bare close", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url } = yield* listening({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-echo", 0)] }, endpoint)
      const closing = yield* openClient(url, socketHeaders(undefined))
      closing.raw.close(4000, "bye")
      expect(yield* closing.closed).toEqual({ code: 4000, reason: "bye" })
      const vanishing = yield* openClient(url, socketHeaders(undefined))
      vanishing.raw.send("hello")
      yield* vanishing.next
      vanishing.raw.terminate()
      yield* endpoint.closed(2)
      expect(endpoint.closes.map((each) => [each.code, each.reason])).toEqual([
        [4000, "bye"],
        [1005, ""],
      ])
    }),
  )

  it.live("passes ChatGPT's close on as it came, and its vanishing as 1011", () =>
    Effect.gen(function* () {
      const endpoint = yield* chatgpt
      const { url } = yield* listening({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-echo", 0)] }, endpoint)
      const closed = yield* openClient(url, socketHeaders(undefined))
      closed.raw.send("close-me")
      expect(yield* closed.closed).toEqual({ code: 4001, reason: "done" })
      const dropped = yield* openClient(url, socketHeaders(undefined))
      dropped.raw.send("drop-me")
      expect(yield* dropped.closed).toEqual({ code: upstreamGoneClose.code, reason: upstreamGoneClose.reason })
    }),
  )

  it.live(
    "carries text and binary messages of every frame length both ways",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* chatgpt
        const { url } = yield* listening(
          { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-echo", 0)] },
          endpoint,
        )
        const client = yield* openClient(url, socketHeaders(undefined))
        for (const size of [0, 125, 126, 65_535, 65_536, 1024 * 1024]) {
          client.raw.send(patternedText(size))
          expect(yield* client.next).toEqual({ _tag: "Text", text: patternedText(size) })
          client.raw.send(patterned(size))
          expect(yield* client.next).toEqual({ _tag: "Binary", bytes: patterned(size) })
        }
      }),
    15_000,
  )

  it.live(
    "holds ChatGPT's messages while Codex reads slowly, and loses none",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* chatgpt
        const { url } = yield* listening(
          { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-echo", 0)] },
          endpoint,
        )
        const client = yield* openClient(url, socketHeaders(undefined))
        const count = 96
        // Codex stops reading while ChatGPT sends far more than any socket buffers hold.
        client.raw.pause()
        client.raw.send(`flood-${count}`)
        yield* Effect.sleep("500 millis")
        client.raw.resume()
        for (let index = 0; index < count; index++) {
          const message = yield* client.next
          if (message._tag !== "Binary") throw new Error(`message ${index} is ${message._tag}`)
          const view = new DataView(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength)
          expect([message.bytes.byteLength, view.getUint32(0), message.bytes[floodSize - 1]]).toEqual([
            floodSize,
            index,
            (floodSize - 1) % 251,
          ])
        }
      }),
    30_000,
  )

  it.live(
    "tells a client far ahead of a ChatGPT that stopped reading to back off",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* stalledChatgpt
        const { url } = yield* listening(
          { routes: chatgptApi, accounts: [oauth("codex", "a", "tok-stalled", 0)] },
          endpoint,
        )
        const client = yield* openClient(url, socketHeaders(undefined))
        const chunk = patterned(1024 * 1024)
        for (let sent = 0; sent < 100; sent++) client.raw.send(chunk)
        expect(yield* client.closed).toEqual({ code: behindClose.code, reason: behindClose.reason })
      }),
    30_000,
  )
})
