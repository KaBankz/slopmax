import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect, Fiber, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { Accounts } from "../../src/accounts.ts"
import { sooner } from "../../src/proxy/forward.ts"
import { chatgptApi, claudeApi, endpointApi, json, on, sse } from "../support/memory-upstream.ts"
import {
  claudeBody,
  claudeCode,
  codexRequest,
  endpoint,
  followClock,
  health,
  ledger,
  oauth,
  proxyStack,
  request,
  send,
  settled,
} from "./stack.ts"

const now = DateTime.makeUnsafe(0)

const blockedNow = (until: DateTime.Utc | undefined) => until !== undefined && DateTime.isGreaterThan(until, now)

const stored = (id: string) =>
  Effect.map(
    Effect.flatMap(Accounts, (accounts) => accounts.fresh(AccountId.make(id))),
    Option.getOrUndefined,
  )

const chatBody = (model: string) => JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })

describe("refreshing and benching accounts whose tokens are refused", () => {
  it.effect("a rejected token is refreshed and the request tried again on the same account", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-stale", 0, "refresh-good")],
      settings: { refreshTokens: true },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(claudeCode())
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("message_start")
      expect(upstream.at("/v1/messages").map((seen) => seen.token)).toEqual(["tok-stale", "tok-renewed"])
      const refresh = upstream.at("/v1/oauth/token")
      expect(refresh).toHaveLength(1)
      expect(JSON.parse(refresh[0]?.text ?? "{}")).toMatchObject({ grant_type: "refresh_token" })
      // The rotated tokens are saved for next time.
      const saved = yield* stored("claude-a")
      const tokens = saved === undefined ? undefined : Option.getOrUndefined(saved.tokens)
      expect(tokens === undefined ? undefined : Redacted.value(tokens.access)).toBe("tok-renewed")
      expect(tokens?.refresh === undefined ? undefined : Redacted.value(tokens.refresh)).toBe("refresh-next")
      expect(saved?.authError).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("a refused refresh signs the account out and moves on, and later requests skip it untried", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-stale", 0, "refresh-revoked"), oauth("claude", "b", "tok-ok", 1)],
      settings: { refreshTokens: true },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const first = yield* send(claudeCode())
      expect(first.status).toBe(200)
      expect(upstream.at("/v1/messages").map((seen) => seen.token)).toEqual(["tok-stale", "tok-ok"])
      expect((yield* stored("claude-a"))?.authError).toBeDefined()
      expect((yield* health("claude-a")).lastError).toBeDefined()

      // Placed afresh (its session would keep it on the second anyway): the first is neither tried nor refreshed.
      upstream.clear()
      const again = yield* send(claudeCode({ headers: { "x-slopmax-affinity": "off" } }))
      expect(again.status).toBe(200)
      expect(upstream.at("/v1/oauth/token")).toHaveLength(0)
      expect(upstream.at("/v1/messages").map((seen) => seen.token)).toEqual(["tok-ok"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("without refreshing, a rejected token benches its account and the next one serves", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-stale", 0, "refresh-good"), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      expect((yield* send(claudeCode())).status).toBe(200)
      expect(upstream.at("/v1/oauth/token")).toHaveLength(0)
      const benched = yield* health("claude-a")
      expect(blockedNow(benched.blockedUntil)).toBe(true)
      expect(benched.lastError).toBe("unauthorized")
      expect(benched.blockedUntil).toEqual(DateTime.addDuration(now, Duration.minutes(30)))
    }).pipe(Effect.provide(layer))
  })

  it.effect("an account that may not serve is benched for half an hour", () => {
    const { upstream, layer } = proxyStack({
      routes: [on("POST /backend-api/codex/responses", (seen) => (seen.token === "tok-no" ? json(403, {}) : sse([])))],
      accounts: [oauth("codex", "a", "tok-no", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      expect((yield* send(codexRequest())).status).toBe(200)
      const benched = yield* health("codex-a")
      expect(benched.lastError).toBe("forbidden")
      expect(benched.blockedUntil).toEqual(DateTime.addDuration(now, Duration.minutes(30)))
    }).pipe(Effect.provide(layer))
  })
})

describe("setting aside spent and busy accounts", () => {
  it.effect("a throttled account is set aside briefly, not blocked", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-busy", 0), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      expect((yield* send(claudeCode())).status).toBe(200)
      const busy = yield* health("claude-a")
      expect(busy.throttledUntil).toEqual(DateTime.addDuration(now, Duration.seconds(30)))
      expect(busy.blockedUntil).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("when only throttled accounts remain, their refusal goes back to the client", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-busy", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(claudeCode())
      expect(answer.status).toBe(429)
      expect(answer.text).toContain("slow down")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a spent account sits out until its reset while the next one serves", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-limited", 0), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      expect((yield* send(claudeCode())).status).toBe(200)
      const spent = yield* health("claude-a")
      expect(spent.blockedUntil).toEqual(DateTime.makeUnsafe(3600 * 1000))
      expect(spent.lastError).toBe("usage limit reached")
    }).pipe(Effect.provide(layer))
  })

  it.effect("Codex streams that open spent move to the next account before the client sees a byte", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-quiet", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexRequest())
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("response.completed")
      expect(answer.text).not.toContain("usage_limit_reached")
      const spent = yield* health("codex-a")
      expect(spent.blockedUntil).toEqual(DateTime.addDuration(now, Duration.minutes(5)))
      expect(spent.lastError).toBe("usage limit reached")
    }).pipe(Effect.provide(layer))
  })

  it.effect("Codex streams that open overloaded move on without benching the account", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-overloaded", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexRequest())
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("response.completed")
      expect(answer.text).not.toContain("server_is_overloaded")
      const first = yield* health("codex-a")
      expect(first.throttledUntil).toEqual(DateTime.addDuration(now, Duration.seconds(30)))
      expect(first.blockedUntil).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("every account spent answers in the agent's own limit shape, naming when the next frees up", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-limited", 0), oauth("claude", "b", "tok-limited", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(claudeCode())
      expect(answer.status).toBe(429)
      expect(answer.headers.get("retry-after")).toBe("3600")
      expect(answer.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
      expect(JSON.parse(answer.text)).toEqual({
        type: "error",
        error: {
          type: "rate_limit_error",
          message:
            "slopmax: every Claude account is rate limited; the next one frees up in 1h00m (`slopmax status` for details)",
        },
      })
      // Both were tried, once each, and the failure is in the ledger with both attempts.
      expect(upstream.at("/v1/messages")).toHaveLength(2)
      const [record] = yield* ledger
      expect(record).toMatchObject({
        _tag: "Request",
        status: 429,
        attempts: 2,
        account: "claude-b",
        agent: "claude-code",
      })
      expect(record?._tag === "Request" ? record.firstByteMs : 0).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("Codex hears a spent pool as its usage limit, with when it resets", () => {
    const { upstream, layer } = proxyStack({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-limited", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexRequest())
      expect(answer.status).toBe(429)
      expect(JSON.parse(answer.text)).toMatchObject({
        error: { type: "usage_limit_reached", resets_at: 5400, resets_in_seconds: 5400 },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("with every account turned off, the client hears why no account could take it", () => {
    const off = oauth("claude", "a", "tok-ok", 0)
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [new (Object.getPrototypeOf(off).constructor)({ ...off, disabled: true })],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(claudeCode())
      expect(answer.status).toBe(503)
      expect(answer.text).toContain("every claude account is disabled or signed out")
      expect(JSON.parse(answer.text)).toMatchObject({ type: "error", error: { type: "api_error" } })
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("retrying passing server errors", () => {
  it.effect("a passing server error is tried once more on the same account after 400 ms", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-flaky", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const fiber = yield* Effect.forkChild(send(codexRequest()))
      yield* TestClock.adjust(Duration.millis(400))
      const answer = yield* Fiber.join(fiber)
      expect(answer.status).toBe(200)
      expect(upstream.at("/backend-api/codex/responses").map((seen) => seen.token)).toEqual(["tok-flaky", "tok-flaky"])
      const first = yield* health("codex-a")
      expect(first.blockedUntil).toBeUndefined()
      expect(first.lastError).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("an account answering a server error twice is passed over, never benched", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-down", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const fiber = yield* Effect.forkChild(send(codexRequest()))
      yield* TestClock.adjust(Duration.millis(400))
      const answer = yield* Fiber.join(fiber)
      expect(answer.status).toBe(200)
      expect(upstream.at("/backend-api/codex/responses").map((seen) => seen.token)).toEqual([
        "tok-down",
        "tok-down",
        "tok-ok",
      ])
      const down = yield* health("codex-a")
      expect(down.lastError).toBe("server error 502")
      expect(down.blockedUntil).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })
})

describe("unreachable endpoints and requests no account can take", () => {
  it.effect("an unreachable endpoint fails over and records why on the account", () => {
    const down = on("POST http://down.test/*", () => {
      throw new Error("connection refused")
    })
    const { upstream, layer } = proxyStack({
      routes: [down, ...endpointApi],
      accounts: [endpoint("down", "http://down.test/v1", 0), endpoint("up", "http://local.test/local/v1", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(request("POST", "/v1/chat/completions", { body: chatBody("local-model") }))
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("chat.completion")
      const first = yield* health("compat-down")
      expect(first.lastError?.startsWith("network error")).toBe(true)
      expect(first.blockedUntil).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("a request that names no model is turned away before anything is sent", () => {
    const { upstream, layer } = proxyStack({
      routes: endpointApi,
      accounts: [endpoint("up", "http://local.test/local/v1", 0)],
    })
    return Effect.gen(function* () {
      const answer = yield* send(request("POST", "/v1/chat/completions", { body: JSON.stringify({ messages: [] }) }))
      expect(answer.status).toBe(400)
      expect(answer.text).toContain("the request names no model")
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("Claude's paths refuse other clients before anything is sent", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const answer = yield* send(
        claudeCode({ path: "/claude/v1/messages/count_tokens", headers: { "user-agent": "curl/8.7.1" } }),
      )
      expect(answer.status).toBe(403)
      expect(answer.text).toContain("to Claude Code only")
      expect(answer.text).toContain("this request came from curl/8.7.1")
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("another client asking for a Claude model on /v1/messages is refused before anything is sent", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const answer = yield* send(
        request("POST", "/v1/messages", { body: claudeBody, headers: { "user-agent": "OpenAI/Python 2.4.0" } }),
      )
      expect(answer.status).toBe(403)
      expect(JSON.parse(answer.text)).toMatchObject({ type: "error", error: { type: "permission_error" } })
      expect(answer.text).toContain("to Claude Code only")
      expect(answer.text).toContain("this request came from OpenAI/Python 2.4.0")
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a model no account serves is named back in the client's format", () => {
    const { layer } = proxyStack({ routes: endpointApi, accounts: [endpoint("up", "http://local.test/local/v1", 0)] })
    return Effect.gen(function* () {
      const answer = yield* send(request("POST", "/v1/chat/completions", { body: chatBody("grok-9") }))
      expect(answer.status).toBe(404)
      expect(JSON.parse(answer.text)).toEqual({
        error: {
          type: "not_found_error",
          message: 'no connected account serves "grok-9" in the chat format (`slopmax status` lists accounts)',
        },
      })
    }).pipe(Effect.provide(layer))
  })
})

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

describe("combining why steps could not serve", () => {
  it("the earliest return wins across steps, and the first reason is kept", () => {
    const first = sooner(undefined, { reason: "first", until: at(500) })
    expect(sooner(first, { reason: "second", until: at(100) })).toEqual({ reason: "first", until: at(100) })
    expect(sooner(first, { reason: "second", until: undefined })).toEqual({ reason: "first", until: at(500) })
    expect(sooner({ reason: "none", until: undefined }, { reason: "later", until: at(9) })).toEqual({
      reason: "none",
      until: at(9),
    })
  })
})

describe("settling served answers", () => {
  it.effect("a served answer is counted once, with its usage, timings and attempts", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      expect((yield* send(claudeCode())).status).toBe(200)
      yield* settled
      const records = yield* ledger
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        _tag: "Request",
        account: "claude-a",
        provider: "claude",
        model: "claude-opus-5-5",
        status: 200,
        attempts: 1,
        agent: "claude-code",
        usage: { requests: 1, input: 10, cacheRead: 90, output: 25 },
        firstByteMs: 0,
      })
      const served = yield* health("claude-a")
      expect(served.served.requests).toBe(1)
      expect(served.lastUsed).toEqual(now)
    }).pipe(Effect.provide(layer))
  })
})
