// The proxy end to end in process: the front door, the real services, and
// providers answered by scripts, on the test clock.
import { describe, expect } from "bun:test"
import { AccountId, LedgerRecord, Limits, Usage, Window } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Account } from "../../src/account.ts"
import { Events } from "../../src/events.ts"
import { linesOf, monthFile } from "../../src/ledger.ts"
import { block, clearBlocks, observe, Pool, unexpiredResets } from "../../src/pool.ts"
import { Quota } from "../../src/quota.ts"
import {
  type Answer,
  chatgptApi,
  claudeApi,
  codexOk,
  endpointApi,
  json,
  on,
  type Route,
  status,
  xaiApi,
} from "../support/memory-upstream.ts"
import {
  apiKey,
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

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

/** Records a reading of one window on an account, with two limit resets banked. */
const reading = (id: string, span: "5h" | "7d", used: number, resetCredits?: number) =>
  Effect.flatMap(Pool, (pool) =>
    pool.update((m, now) =>
      observe(
        m,
        AccountId.make(id),
        new Limits({
          windows: [Window.of(span, used, DateTime.addDuration(now, Duration.hours(span === "5h" ? 2 : 72)))],
          observedAt: now,
          ...(resetCredits === undefined ? {} : { resetCredits }),
        }),
        now,
      ),
    ),
  )

/** A Codex request in session `session`, as `codex exec` sends one. */
const codexIn = (
  session: string,
  options: { readonly body?: string; readonly headers?: Record<string, string> } = {},
) =>
  codexRequest({
    headers: { "session-id": session, "user-agent": "codex_exec/0.159.3 (Linux; x86_64)", ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
  })

const codexCalls = (upstream: ReturnType<typeof proxyStack>["upstream"]) => upstream.at("/backend-api/codex/responses")

/** Sends a Codex request and gives the workspace of the account that served it. */
const servedBy = (upstream: ReturnType<typeof proxyStack>["upstream"], made: Request) =>
  Effect.gen(function* () {
    const answer = yield* send(made)
    expect(answer.status).toBe(200)
    return codexCalls(upstream).at(-1)?.headers.get("chatgpt-account-id")
  })

const codexAccounts = (count: number, token = "tok-ok") =>
  Array.from({ length: count }, (_, index) => oauth("codex", String.fromCharCode(97 + index), token, index))

/** The model list, as an OpenAI-style client asks for it. */
const list = (headers: Record<string, string> = {}) => send(request("GET", "/v1/models", { headers }))

/** A request in session `s` that asks to keep its account. */
const sticky = () => codexIn("s", { headers: { "x-slopmax-affinity": "on" } })

describe("keys", () => {
  it.effect("a request without the slopmax key hears 401 in its own format, and nothing reaches a provider", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const wrong = { authorization: "Bearer wrong" }
      const messages = yield* send(claudeCode({ headers: wrong }))
      expect(messages.status).toBe(401)
      expect(JSON.parse(messages.text)).toEqual({
        type: "error",
        error: { type: "authentication_error", message: "missing or invalid slopmax key; see `slopmax env`" },
      })
      const chat = yield* send(request("POST", "/v1/chat/completions", { body: "{}", headers: { authorization: "" } }))
      expect(chat.status).toBe(401)
      expect(JSON.parse(chat.text)).toMatchObject({ error: { type: "authentication_error" } })
      const codex = yield* send(codexRequest({ headers: { authorization: "Bearer nope" } }))
      expect(codex.status).toBe(401)
      expect(JSON.parse(codex.text)).toMatchObject({ error: { type: "authentication_error" } })
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("health and Claude Code's probes need no key, and unknown paths are refused before the key", () => {
    const { layer } = proxyStack({ routes: claudeApi, accounts: [] })
    return Effect.gen(function* () {
      const healthz = yield* send(new Request("http://slopmax.test/healthz"))
      expect(healthz.status).toBe(200)
      expect(JSON.parse(healthz.text)).toMatchObject({ status: "ok", service: "slopmax" })
      const hello = yield* send(new Request("http://slopmax.test/api/hello", { method: "POST" }))
      expect([hello.status, hello.text]).toEqual([200, ""])
      const head = yield* send(new Request("http://slopmax.test/claude/v1/messages", { method: "HEAD" }))
      expect([head.status, head.text]).toEqual([200, ""])
      const unknown = yield* send(new Request("http://slopmax.test/nowhere", { method: "POST" }))
      expect(unknown.status).toBe(404)
      expect(JSON.parse(unknown.text)).toEqual({
        type: "error",
        error: { type: "not_found_error", message: "unknown path; slopmax serves /claude/*, /codex/*, and /v1/*" },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("client keys are held to their models, aliases included", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-ok", 0)],
      settings: {
        keys: [{ name: "laptop", key: "sm-laptop", models: ["gpt-6-*"] }],
        aliases: { "gpt-6-cheap": "gpt-5-mini" },
      },
    })
    const laptop = { authorization: "Bearer sm-laptop" }
    const asking = (model: string) =>
      codexRequest({ headers: laptop, body: JSON.stringify({ model, input: [], stream: true }) })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const aliased = yield* send(asking("gpt-6-cheap"))
      expect(aliased.status).toBe(403)
      expect(aliased.text).toContain('the key \\"laptop\\" may not use the models this request is routed to')
      expect((yield* send(asking("gpt-6-sol"))).status).toBe(200)
      const refused = yield* send(asking("gpt-5-mini"))
      expect(refused.status).toBe(403)
      expect(JSON.parse(refused.text)).toMatchObject({ error: { message: 'the key "laptop" may not use gpt-5-mini' } })
      const twice = yield* send(codexRequest({ headers: laptop, body: '{"model":"gpt-6-sol","model":"gpt-5-mini"}' }))
      expect(twice.status).toBe(403)
      const listed = yield* send(request("GET", "/codex/models?client_version=0.165.0", { headers: laptop }))
      expect(listed.status).toBe(200)
      const packed = yield* send(codexRequest({ headers: { ...laptop, "content-encoding": "zstd" }, body: "(packed)" }))
      expect(packed.status).toBe(403)
      // Only the allowed request and the listing reached ChatGPT.
      expect(upstream.paths()).toEqual(["/backend-api/codex/responses", "/backend-api/codex/models"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("remembers the Codex release and Claude Code's user agent that authenticated requests show", () => {
    const { upstream, layer } = proxyStack({
      routes: [...claudeApi, ...chatgptApi],
      accounts: [oauth("claude", "a", "tok-ok", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* send(claudeCode({ headers: { authorization: "Bearer nope" } }))
      expect((yield* Effect.flatMap(Pool, (pool) => pool.model)).agents.claude).toBeUndefined()
      yield* send(claudeCode())
      yield* send(codexRequest({ headers: { "user-agent": "codex_cli_rs/0.160.1 (Mac OS 26.1.0; arm64)" } }))
      const m = yield* Effect.flatMap(Pool, (pool) => pool.model)
      expect(m.agents.claude).toBe("claude-cli/2.1.287 (external, cli)")
      expect(m.codex.version).toBe("0.160.1")
    }).pipe(Effect.provide(layer))
  })
})

describe("forwarding as sent", () => {
  it.effect("Claude fails over and forwards the request unchanged but for the account's credential", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-limited", 0), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(
        claudeCode({
          headers: {
            "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
            "x-claude-code-session-id": "sess-1",
            "accept-encoding": "gzip, br",
            "x-slopmax-affinity": "on",
          },
        }),
      )
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("message_delta")
      const calls = upstream.at("/v1/messages")
      expect(calls).toHaveLength(2)
      const served = calls[1]
      expect(served?.path).toBe("/v1/messages?beta=true")
      expect(served?.headers.get("authorization")).toBe("Bearer tok-ok")
      expect(served?.headers.get("anthropic-beta")).toBe(
        "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
      )
      expect(served?.headers.get("user-agent")).toBe("claude-cli/2.1.287 (external, cli)")
      expect(served?.headers.get("accept-encoding")).toBe("gzip, br")
      expect(served?.headers.get("x-claude-code-session-id")).toBe("sess-1")
      expect(served?.headers.has("x-slopmax-affinity")).toBe(false)
      expect(served?.text).toBe(claudeBody)

      const [record] = yield* ledger
      expect(record).toMatchObject({
        _tag: "Request",
        account: "claude-b",
        model: "claude-opus-5-5",
        attempts: 2,
        agent: "claude-code",
        session: "sess-1",
        usage: { requests: 1, input: 10, output: 25, cacheRead: 90 },
      })
      const servedHealth = yield* health("claude-b")
      expect(servedHealth.limits.windows[0]?.used).toBe(25)

      // The session now stays on the account that served it.
      upstream.clear()
      yield* send(claudeCode({ headers: { "x-claude-code-session-id": "sess-1" } }))
      expect(upstream.at("/v1/messages").map((seen) => seen.token)).toEqual(["tok-ok"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("splices the model an alias names into the body, leaving every other byte as sent", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-ok", 0)],
      settings: { aliases: { fast: "gpt-6-sol-mini" } },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const body = '{ "input" : [ ], "model" :"fast",  "stream":true }'
      expect((yield* send(codexRequest({ body }))).status).toBe(200)
      expect(codexCalls(upstream)[0]?.text).toBe('{ "input" : [ ], "model" :"gpt-6-sol-mini",  "stream":true }')
    }).pipe(Effect.provide(layer))
  })

  it.effect("a refusal that is the request's own reaches Claude Code as it came, benching no account", () => {
    const { upstream, layer } = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-fast", 0), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(claudeCode())
      expect(answer.status).toBe(429)
      expect(JSON.parse(answer.text)).toMatchObject({ error: { message: "Usage credits are required for fast mode." } })
      expect(upstream.at("/v1/messages")).toHaveLength(1)
      const first = yield* health("claude-a")
      expect([first.blockedUntil, first.throttledUntil]).toEqual([undefined, undefined])
      const [record] = yield* ledger
      expect(record).toMatchObject({ status: 429, account: "claude-a", attempts: 1 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("agents see the pool's windows, not the serving account's", () => {
    const codex = proxyStack({ routes: chatgptApi, accounts: codexAccounts(2) })
    const claude = proxyStack({
      routes: claudeApi,
      accounts: [oauth("claude", "a", "tok-ok", 0), oauth("claude", "b", "tok-ok", 1)],
    })
    return Effect.gen(function* () {
      // Codex: the serving account reports 40% of its week, the other 10%.
      const fromCodex = yield* Effect.gen(function* () {
        yield* followClock(codex.upstream)
        yield* reading("codex-b", "7d", 10)
        return yield* send(codexRequest())
      }).pipe(Effect.provide(codex.layer))
      expect(fromCodex.status).toBe(200)
      expect(fromCodex.headers.get("x-codex-primary-used-percent")).toBe("25.0")
      expect(fromCodex.headers.get("x-codex-primary-window-minutes")).toBe("10080")

      // Claude: a quarter here and three quarters on the other read as half.
      const fromClaude = yield* Effect.gen(function* () {
        yield* followClock(claude.upstream)
        yield* reading("claude-b", "5h", 75)
        return yield* send(claudeCode())
      }).pipe(Effect.provide(claude.layer))
      expect(fromClaude.status).toBe(200)
      expect(fromClaude.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.50")
      expect(fromClaude.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed")
      expect(fromClaude.headers.has("anthropic-ratelimit-unified-representative-claim")).toBe(false)
    })
  })
})

describe("sessions and affinity", () => {
  it.effect("sessions keep their account so the prompt cache stays warm, and stay where they moved", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: codexAccounts(3),
      settings: { strategy: "round-robin" },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const a = yield* servedBy(upstream, codexIn("a"))
      const b = yield* servedBy(upstream, codexIn("b"))
      const c = yield* servedBy(upstream, codexIn("c"))
      expect([a, b, c]).toEqual(["acct-a", "acct-b", "acct-c"])
      for (let round = 0; round < 3; round++) {
        expect(yield* servedBy(upstream, codexIn("b"))).toBe("acct-b")
        expect(yield* servedBy(upstream, codexIn("a"))).toBe("acct-a")
      }
      // A new session goes to the account handed a request longest ago.
      expect(yield* servedBy(upstream, codexIn("d"))).toBe("acct-c")

      // Once its account is limited the session moves, and stays after the old one recovers.
      const pool = yield* Pool
      yield* pool.update((m, now) =>
        block(
          m,
          AccountId.make("codex-b"),
          DateTime.addDuration(now, Duration.minutes(5)),
          undefined,
          "usage limit reached",
        ),
      )
      const moved = yield* servedBy(upstream, codexIn("b"))
      expect(moved).not.toBe("acct-b")
      yield* pool.update((m) => clearBlocks(m, AccountId.make("codex-b"))[1])
      for (let round = 0; round < 3; round++) expect(yield* servedBy(upstream, codexIn("b"))).toBe(moved)
    }).pipe(Effect.provide(layer))
  })

  it.effect("affinity can be turned off for the proxy, or for one request", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: codexAccounts(2),
      settings: { strategy: "round-robin", sessionAffinity: false },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      // Off in the settings: one session's requests take turns.
      const turns: Array<string | null | undefined> = []
      for (let round = 0; round < 4; round++) turns.push(yield* servedBy(upstream, codexIn("s")))
      expect(turns).toEqual(["acct-a", "acct-b", "acct-a", "acct-b"])
      // A request may ask to keep its session's account anyway.
      const first = yield* servedBy(upstream, sticky())
      expect(yield* servedBy(upstream, sticky())).toBe(first)
      expect(yield* servedBy(upstream, sticky())).toBe(first)
      // slopmax's own headers never reach the provider.
      expect(codexCalls(upstream).every((seen) => !seen.headers.has("x-slopmax-affinity"))).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("with affinity on, a request may still ask to be placed afresh", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: codexAccounts(2),
      settings: { strategy: "round-robin", sessionAffinity: true },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const kept = yield* servedBy(upstream, codexIn("t"))
      expect(yield* servedBy(upstream, codexIn("t"))).toBe(kept)
      const loose = () => codexIn("t", { headers: { "x-slopmax-affinity": "off" } })
      const spread = [yield* servedBy(upstream, loose()), yield* servedBy(upstream, loose())]
      expect(spread[0]).not.toBe(spread[1])
    }).pipe(Effect.provide(layer))
  })

  it.effect("moving without affinity still drops another account's state", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: codexAccounts(2),
      settings: { strategy: "round-robin", sessionAffinity: false },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const body = '{"model":"gpt-6-sol","previous_response_id":"resp-1","input":[],"stream":true}'
      yield* servedBy(upstream, codexIn("s", { body }))
      yield* servedBy(upstream, codexIn("s", { body }))
      const [first, second] = codexCalls(upstream)
      // The first had no account before it, so went as sent; the second landed elsewhere.
      expect(first?.text).toBe(body)
      expect(second?.text).not.toContain("previous_response_id")
    }).pipe(Effect.provide(layer))
  })
})

/** ChatGPT refusing a request that carries reasoning another account minted. */
const staleOr = (otherwise: Answer): ReadonlyArray<Route> => [
  on("POST /backend-api/codex/responses", (seen, context) =>
    seen.text.includes("previous_response_id")
      ? status(400, "Item with id 'rs_1' not found.")
      : otherwise(seen, context),
  ),
]

describe("refusals of the request's state", () => {
  const stale = '{"model":"gpt-6-sol","previous_response_id":"resp-9","input":[],"stream":true}'

  it.effect("state the account refuses is dropped and the request tried once more on the same account", () => {
    const { upstream, layer } = proxyStack({ routes: staleOr(codexOk), accounts: codexAccounts(2) })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexIn("s", { body: stale }))
      expect(answer.status).toBe(200)
      const calls = codexCalls(upstream)
      expect(calls.map((call) => call.headers.get("chatgpt-account-id"))).toEqual(["acct-a", "acct-a"])
      expect(calls[0]?.text).toBe(stale)
      expect(calls[1]?.text).not.toContain("previous_response_id")
      const after = yield* health("codex-a")
      expect([after.blockedUntil, after.throttledUntil, after.lastError]).toEqual([undefined, undefined, undefined])
    }).pipe(Effect.provide(layer))
  })

  it.effect("refused again without it, the refusal is the request's own and goes back as it came", () => {
    const { upstream, layer } = proxyStack({
      routes: [on("POST /backend-api/codex/responses", () => status(400, "Item with id 'rs_1' not found."))],
      accounts: codexAccounts(2),
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexIn("s", { body: stale }))
      expect(answer.status).toBe(400)
      expect(answer.text).toContain("Item with id 'rs_1' not found.")
      const accounts = codexCalls(upstream).map((call) => call.headers.get("chatgpt-account-id"))
      expect(accounts).toEqual(["acct-a", "acct-a"])
      const after = yield* health("codex-a")
      expect([after.blockedUntil, after.throttledUntil, after.lastError]).toEqual([undefined, undefined, undefined])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a refusal whose body stops arriving is judged by its status after 600 s", () => {
    let cancelled = false
    const quiet = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"error":{"message":"par')),
          cancel: () => {
            cancelled = true
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    const { upstream, layer } = proxyStack({
      routes: [on("POST /backend-api/codex/responses", quiet)],
      accounts: codexAccounts(1),
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const told = yield* Effect.forkChild(send(codexRequest()))
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(599))
      expect(told.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.seconds(1))
      const answer = yield* Fiber.join(told)
      expect(answer.status).toBe(400)
      expect(cancelled).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

describe("spent pools and limit resets", () => {
  it.effect("a spent Codex pool redeems a limit reset when allowed, and the request is served", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-credit", 0)],
      settings: { redeemWhenExhausted: true },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* reading("codex-a", "7d", 90, 2)
      const answer = yield* send(codexRequest())
      expect(answer.status).toBe(200)
      expect(upstream.paths()).toEqual([
        "/backend-api/codex/responses",
        "/backend-api/wham/rate-limit-reset-credits/consume",
        "/backend-api/codex/responses",
      ])
      const consume = upstream.seen[1]
      expect(consume?.token).toBe("tok-credit")
      expect(consume?.headers.get("chatgpt-account-id")).toBe("acct-a")
      expect(typeof JSON.parse(consume?.text ?? "{}").redeem_request_id).toBe("string")
      const after = yield* health("codex-a")
      expect(after.blockedUntil).toBeUndefined()
      expect(after.limits.resetCredits).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a spent Codex pool keeps its limit resets by default", () => {
    const { upstream, layer } = proxyStack({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-credit", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* reading("codex-a", "7d", 90, 2)
      const answer = yield* send(codexRequest())
      expect(answer.status).toBe(429)
      expect(upstream.paths()).toEqual(["/backend-api/codex/responses"])
      expect((yield* health("codex-a")).limits.resetCredits).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("limit resets are listed with their dates, kept, and redeemed soonest to expire first", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "a", "tok-expiring", 0), oauth("codex", "b", "tok-ok", 1)],
    })
    const listings = () => upstream.at("/backend-api/wham/rate-limit-reset-credits").length
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* reading("codex-a", "7d", 30, 2)
      yield* reading("codex-b", "7d", 30, 0)
      const quota = yield* Quota
      // An account whose usage counts no resets is not asked.
      yield* quota.listDue()
      expect(listings()).toBe(1)
      const now = yield* DateTime.now
      const listed = unexpiredResets(yield* health("codex-a"), now)
      expect(listed.map((reset) => reset.id)).toEqual(["credit-soon", "credit-later"])
      expect(listed[0]?.grantedAt !== undefined && DateTime.isLessThan(listed[0].grantedAt, now)).toBe(true)
      // Not again until the list is due.
      yield* quota.listDue()
      expect(listings()).toBe(1)

      // Redeeming without naming one spends the soonest to expire.
      const account = (yield* Effect.flatMap(Pool, (pool) => pool.model)).accounts.find(
        (candidate: Account) => candidate.id === "codex-a",
      )
      if (account === undefined) return yield* Effect.die("no account")
      expect(yield* quota.redeem(account)).toBe("reset")
      const sent = upstream.seen.at(-1)
      expect(sent?.path).toBe("/backend-api/wham/rate-limit-reset-credits/consume")
      expect(JSON.parse(sent?.text ?? "{}").credit_id).toBe("credit-soon")
      expect(unexpiredResets(yield* health("codex-a"), yield* DateTime.now).map((reset) => reset.id)).toEqual([
        "credit-later",
      ])
    }).pipe(Effect.provide(layer))
  })
})

/** A turn of Claude Code's conversation, asking for a GPT model. */
const turn = (messages: unknown) =>
  claudeCode({
    headers: { "x-claude-code-session-id": "sess-1" },
    body: JSON.stringify({
      model: "gpt-6-sol",
      max_tokens: 1000,
      stream: true,
      system: "You are Claude Code.",
      messages,
      tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }],
    }),
  })

describe("translating for accounts that speak another format", () => {
  it.effect(
    "Claude Code runs GPT models on ChatGPT accounts, its reasoning going back to the account that made it",
    () => {
      const { upstream, layer } = proxyStack({
        routes: [...claudeApi, ...chatgptApi],
        accounts: [oauth("claude", "max", "tok-ok", 0), oauth("codex", "chatgpt", "tok-talk", 1)],
      })
      return Effect.gen(function* () {
        yield* followClock(upstream)
        const answer = yield* send(turn([{ role: "user", content: "list files" }]))
        expect(answer.status).toBe(200)
        expect(answer.headers.get("content-type")).toBe("text/event-stream")
        for (const expected of [
          '"model":"gpt-6-sol"',
          '"text":"Hello"',
          '"type":"tool_use","id":"call_1","name":"Bash"',
          '"partial_json":"{\\"command\\":\\"ls\\"}"',
          '"stop_reason":"tool_use"',
          "message_stop",
        ])
          expect(answer.text).toContain(expected)
        expect(answer.text).not.toContain("enc-1")
        const first = codexCalls(upstream).at(-1)
        const sent = JSON.parse(first?.text ?? "{}")
        expect(sent.instructions).toBe("You are Claude Code.")
        expect(sent.prompt_cache_key).toBe("sess-1")
        expect(first?.headers.get("user-agent")).toMatch(/^slopmax\//)
        yield* settled

        // The next turn carries the call's result, and the reasoning that led to the call.
        const next = yield* send(
          turn([
            { role: "user", content: "list files" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Hello" },
                { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
              ],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.rs" }] },
          ]),
        )
        expect(next.status).toBe(200)
        const input = JSON.parse(codexCalls(upstream).at(-1)?.text ?? "{}").input
        expect(input.map((item: { readonly type: string }) => item.type)).toEqual([
          "message",
          "message",
          "reasoning",
          "function_call",
          "function_call_output",
        ])
        expect(input[2].encrypted_content).toBe("enc-1")
        expect(input[4].output).toBe("a.rs")

        // Usage is recorded under the ChatGPT account and the GPT model.
        const records = yield* ledger
        expect(records[0]).toMatchObject({ account: "codex-chatgpt", model: "gpt-6-sol", usage: { input: 20 } })

        // Claude's own models still go to the Claude account, as sent.
        upstream.clear()
        expect((yield* send(claudeCode())).status).toBe(200)
        expect(upstream.paths()).toEqual(["/v1/messages"])
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("translated failures reach the client in its own format, and token counts are estimated", () => {
    const { upstream, layer } = proxyStack({
      routes: chatgptApi,
      accounts: [oauth("codex", "chatgpt", "tok-limited", 0)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const spent = yield* send(claudeCode({ body: claudeBody.replace("claude-opus-5-5", "gpt-6-sol") }))
      expect(spent.status).toBe(429)
      expect(spent.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
      expect(JSON.parse(spent.text)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } })

      upstream.clear()
      const body = '{"model":"gpt-6-sol","messages":[{"role":"user","content":"hello there"}]}'
      const counted = yield* send(claudeCode({ path: "/v1/messages/count_tokens", body }))
      expect(counted.status).toBe(200)
      expect(JSON.parse(counted.text)).toEqual({ input_tokens: Math.ceil(body.length / 4) })
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a provider's error to a translated request is retold in the client's format", () => {
    const { upstream, layer } = proxyStack({
      routes: [
        on("POST /local/v1/chat/completions", () => json(400, { error: { message: "context too long" } })),
        ...endpointApi,
      ],
      accounts: [endpoint("local", "http://local.test/local/v1", 0)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(
        claudeCode({ path: "/v1/messages", body: claudeBody.replace("claude-opus-5-5", "local-model") }),
      )
      expect(answer.status).toBe(400)
      expect(JSON.parse(answer.text)).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "context too long" },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("a Chat client gets one whole answer from an endpoint when it asks for no stream", () => {
    const { upstream, layer } = proxyStack({
      routes: endpointApi,
      accounts: [endpoint("local", "http://local.test/local/v1", 0)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(
        request("POST", "/v1/chat/completions", {
          body: JSON.stringify({ model: "local-model", messages: [{ role: "user", content: "hi" }] }),
        }),
      )
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.text)).toMatchObject({ object: "chat.completion" })
      const [record] = yield* ledger
      expect(record).toMatchObject({ account: "compat-local", status: 200, usage: { input: 4, output: 1 } })
    }).pipe(Effect.provide(layer))
  })
})

describe("listing models for OpenAI-style clients", () => {
  it.effect("lists every model a connected account offers them, with the aliases, reusing each list a while", () => {
    const { upstream, layer } = proxyStack({
      routes: [...claudeApi, ...chatgptApi, ...xaiApi, ...endpointApi],
      accounts: [
        oauth("claude", "max", "tok-ok", 0),
        oauth("codex", "chatgpt", "tok-ok", 1),
        apiKey("xai", "x", "key-xai", 2),
        endpoint("local", "http://local.test/local/v1", 3),
      ],
      settings: { aliases: { fast: "gpt-6-sol-mini" } },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* list()
      expect(answer.status).toBe(200)
      const body = JSON.parse(answer.text)
      expect(body.object).toBe("list")
      expect(body.data.map((model: { readonly id: string }) => model.id)).toEqual([
        "fast",
        "gpt-6-sol",
        "gpt-6-sol-mini",
        "grok-4",
        "grok-code-fast-1",
        "local-model",
      ])
      expect(body.data[0]).toEqual({ id: "fast", object: "model", created: 0, owned_by: "slopmax" })
      expect(body.data[1]).toEqual({ id: "gpt-6-sol", object: "model", created: 0, owned_by: "codex" })
      expect(upstream.at("/backend-api/codex/models")[0]?.path).toBe("/backend-api/codex/models?client_version=0.159.3")

      // Lists are reused for ten minutes.
      const before = upstream.seen.length
      yield* list()
      expect(upstream.seen.length).toBe(before)

      // Claude Code still gets Anthropic's own list, forwarded.
      upstream.clear()
      yield* send(
        request("GET", "/v1/models?limit=1000", {
          headers: { "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.287 (external, cli)" },
        }),
      )
      expect(upstream.paths()).toEqual(["/v1/models"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("narrows the list to a client key's models, and refuses a request without a key in Chat's shape", () => {
    const { upstream, layer } = proxyStack({
      routes: [...chatgptApi, ...xaiApi],
      accounts: [oauth("codex", "chatgpt", "tok-ok", 0), apiKey("xai", "x", "key-xai", 1)],
      settings: { keys: [{ name: "laptop", key: "sm-laptop", models: ["grok-*"] }] },
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const narrowed = yield* send(request("GET", "/v1/models", { headers: { authorization: "Bearer sm-laptop" } }))
      expect(JSON.parse(narrowed.text).data.map((model: { readonly id: string }) => model.id)).toEqual([
        "grok-4",
        "grok-code-fast-1",
      ])
      const none = yield* send(request("GET", "/v1/models", { headers: { authorization: "" } }))
      expect(none.status).toBe(401)
      expect(JSON.parse(none.text)).toEqual({
        error: { type: "authentication_error", message: "missing or invalid slopmax key; see `slopmax env`" },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("asks ChatGPT for the models of the Codex release last seen", () => {
    const { upstream, layer } = proxyStack({ routes: chatgptApi, accounts: [oauth("codex", "chatgpt", "tok-ok", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* send(codexRequest({ headers: { "user-agent": "codex_cli_rs/0.161.2 (Linux; x86_64)" } }))
      yield* send(request("GET", "/v1/models"))
      expect(upstream.at("/backend-api/codex/models")[0]?.path).toBe("/backend-api/codex/models?client_version=0.161.2")
    }).pipe(Effect.provide(layer))
  })
})

describe("settling into the pool and the ledger", () => {
  it.effect("a stream that says the quota ran out partway sits its account out for 5 minutes", () => {
    const midway = [
      { type: "response.created", response: { id: "r", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.failed",
        response: { id: "r", status: "failed", error: { code: "usage_limit_reached", message: "limit" } },
      },
    ]
    const { upstream, layer } = proxyStack({
      routes: [
        on(
          "POST /backend-api/codex/responses",
          () =>
            new Response(midway.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            }),
        ),
      ],
      accounts: [oauth("codex", "a", "tok-ok", 0)],
    })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const answer = yield* send(codexRequest())
      // Content had begun, so the client hears the failure inside the stream.
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("usage_limit_reached")
      yield* settled
      const spent = yield* health("codex-a")
      expect(spent.blockedUntil).toEqual(DateTime.addDuration(at(0), Duration.minutes(5)))
      expect(spent.lastError).toBe("usage limit reached mid-stream")
    }).pipe(Effect.provide(layer))
  })

  it.effect("remembers the model Codex asked for last, for the window warmups", () => {
    const { upstream, layer } = proxyStack({ routes: chatgptApi, accounts: [oauth("codex", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      yield* send(codexRequest({ body: JSON.stringify({ model: "gpt-6-sol-mini", input: [], stream: true }) }))
      yield* settled
      expect((yield* Effect.flatMap(Pool, (pool) => pool.model)).codex.lastModel).toBe("gpt-6-sol-mini")
    }).pipe(Effect.provide(layer))
  })

  it.effect("the model Codex asked for last outlives a restart through the ledger", () => {
    const record = (provider: "codex" | "claude", model: string, second: number) =>
      LedgerRecord.cases.Request.make({
        at: at(second),
        account: AccountId.make(`${provider}-a`),
        provider,
        model,
        status: 200,
        usage: Usage.zero,
        ms: 1,
        attempts: 1,
        via: "http",
      })
    const { layer } = proxyStack({
      routes: [],
      accounts: [],
      files: {
        [`usage/${monthFile(at(0))}`]: linesOf([
          record("codex", "gpt-6-sol", 10),
          record("codex", "gpt-6-sol-mini", 20),
          record("claude", "claude-opus-5-5", 30),
        ]),
      },
    })
    return Effect.gen(function* () {
      yield* settled
      // Read in the background at start: wait until it is in.
      for (let tries = 0; tries < 100; tries++) {
        if ((yield* Effect.flatMap(Pool, (pool) => pool.model)).codex.lastModel !== undefined) break
        yield* Effect.yieldNow
      }
      expect((yield* Effect.flatMap(Pool, (pool) => pool.model)).codex.lastModel).toBe("gpt-6-sol-mini")
    }).pipe(Effect.provide(layer))
  })

  it.effect("every recorded request is told to the live feed", () => {
    const { upstream, layer } = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const events = yield* Events
      const told = yield* Effect.forkChild(
        events.subscribe.pipe(
          Stream.filter((event) => event._tag === "Request"),
          Stream.take(1),
          Stream.runCollect,
        ),
      )
      yield* Effect.yieldNow
      yield* send(claudeCode())
      yield* settled
      const [event] = yield* Fiber.join(told)
      expect(event?._tag === "Request" ? String(event.record.account) : undefined).toBe("claude-a")
    }).pipe(Effect.provide(layer))
  })
})
