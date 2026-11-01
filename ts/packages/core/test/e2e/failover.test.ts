// Invisible failover: a spent, refused or failing account is passed over
// before the client gets its first byte, so Claude Code and Codex see one
// answer from whichever account could give it.
import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect } from "effect"
import type { Health } from "../../src/pool.ts"
import { claudeCodeBody, codexAgent, eventually, field, until } from "../support/clients.ts"
import { subscriptions } from "../support/fixtures.ts"
import { transports } from "../support/harness.ts"

/** How many minutes from now an account sits out; 0 when it is not benched. */
const benchedFor = (health: Health): Effect.Effect<number> =>
  Effect.map(DateTime.now, (now) =>
    health.blockedUntil === undefined ? 0 : Duration.toMinutes(DateTime.distance(now, health.blockedUntil)),
  )

for (const [where, make] of transports) {
  describe(`failing over ${where}`, () => {
    it.live("Claude Code's request moves past a spent account and reaches the next as Claude Code wrote it", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("claude", ["tok-limited", "tok-ok"]) })
        const answer = yield* harness.claude()
        expect(answer.status).toBe(200)
        expect(answer.text).toContain("message_stop")
        // The spent account's refusal never reached the client.
        expect(answer.text).not.toContain("rate_limit_error")

        const calls = harness.upstream.at("/v1/messages")
        expect(calls.map((call) => call.token)).toEqual(["tok-limited", "tok-ok"])
        for (const call of calls) {
          expect(call.path).toBe("/v1/messages?beta=true")
          expect(call.text).toBe(claudeCodeBody())
          expect(call.headers.get("x-claude-code-session-id")).toBe("sess-1")
          expect(call.headers.get("user-agent")).toBe("claude-cli/2.1.287 (external, cli)")
        }

        const spent = yield* harness.health(AccountId.make("claude-0"))
        // Its five-hour window resets in an hour.
        expect(yield* benchedFor(spent)).toBeGreaterThan(59)
        const [record] = yield* harness.ledger
        expect(record).toMatchObject({
          _tag: "Request",
          account: "claude-1",
          status: 200,
          attempts: 2,
          agent: "claude-code",
          session: "sess-1",
          usage: { requests: 1, input: 10, cacheRead: 90, output: 25 },
        })
      }),
    )

    it.live("Codex fails over with its workspace and release headers, and the account that served counts it", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-limited", "tok-ok"]) })
        const answer = yield* harness.codex({
          headers: { "session-id": "codex-session", "user-agent": codexAgent },
          body: '{"model":"gpt-6-sol","input":[],"stream":true,"store":false,"prompt_cache_key":"codex-session"}',
        })
        expect(answer.status).toBe(200)
        expect(answer.text).toContain("response.completed")

        const calls = harness.upstream.seen
        expect(calls).toHaveLength(2)
        const served = calls[1]
        expect(served?.path).toBe("/backend-api/codex/responses")
        expect(served?.headers.get("authorization")).toBe("Bearer tok-ok")
        expect(served?.headers.get("chatgpt-account-id")).toBe("acct-codex1")
        expect(served?.headers.get("version")).toBe("0.159.3")
        expect(served?.headers.get("session-id")).toBe("codex-session")

        const spent = yield* harness.health(AccountId.make("codex-0"))
        // ChatGPT said its limit resets in 90 minutes.
        expect(yield* benchedFor(spent)).toBeGreaterThan(89)
        yield* harness.settled
        const next = yield* harness.health(AccountId.make("codex-1"))
        expect([next.served.requests, next.served.input, next.served.cacheRead, next.served.output]).toEqual([
          1, 40, 60, 7,
        ])
        expect(next.limits.windows[0]?.span).toBe("7d")
      }),
    )

    it.live("a Codex stream that opens spent moves to the next account before Codex sees a byte", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-quiet", "tok-ok"]) })
        const answer = yield* harness.codex()
        expect(answer.status).toBe(200)
        expect(answer.text).toContain("response.completed")
        expect(answer.text).not.toContain("usage_limit_reached")
        expect(answer.text).not.toContain("resp_3")
        expect(harness.upstream.seen.map((call) => call.token)).toEqual(["tok-quiet", "tok-ok"])
        const spent = yield* harness.health(AccountId.make("codex-0"))
        expect(spent.blockedUntil).toBeDefined()
      }),
    )

    it.live("a server error that passes is tried once more on the same account, unseen by the client", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-flaky", "tok-ok"]) })
        const answer = yield* harness.codex()
        expect(answer.status).toBe(200)
        expect(harness.upstream.seen.map((call) => call.token)).toEqual(["tok-flaky", "tok-flaky"])
        const flaky = yield* harness.health(AccountId.make("codex-0"))
        expect(flaky.blockedUntil).toBeUndefined()
      }),
    )

    it.live("with every account spent, the client hears its own limit error naming when one frees up", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-limited", "tok-limited"]) })
        const answer = yield* harness.call("POST", "/v1/responses", { body: { model: "gpt-6-sol", input: [] } })
        expect(answer.status).toBe(429)
        expect(field(answer.json, "error", "type")).toBe("usage_limit_reached")
        const resetsAt = Number(field(answer.json, "error", "resets_at"))
        expect(resetsAt).toBeGreaterThan(DateTime.toEpochMillis(yield* DateTime.now) / 1000)

        // Both accounts now sit out: the next request reaches no provider.
        harness.upstream.clear()
        const again = yield* harness.codex()
        expect(again.status).toBe(429)
        expect(harness.upstream.seen).toHaveLength(0)
        const records = yield* eventually(
          Effect.flatMap(harness.ledger, (all) => Effect.as(until(all.length === 2, "two records"), all)),
        )
        expect(records.map((record) => (record._tag === "Request" ? record.status : 0))).toEqual([429, 429])
      }),
    )

    it.live("a spent account sits out until its reset while the next one serves", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("claude", ["tok-limited", "tok-ok"]) })
        yield* harness.claude()
        harness.upstream.clear()
        // While benched, requests go straight to the next account.
        yield* harness.claude({ headers: { "x-claude-code-session-id": "sess-2" } })
        expect(harness.upstream.seen.map((call) => call.token)).toEqual(["tok-ok"])
        expect(yield* benchedFor(yield* harness.health(AccountId.make("claude-0")))).toBeGreaterThan(59)
      }),
    )
  })
}
