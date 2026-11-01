// Restarting the daemon on the same home: what the pool learned (spent
// accounts, each session's account), what the ledger recorded, and the home's lock all
// carry over, as they must when `slopmax serve` is stopped and started again.
import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Exit } from "effect"
import { AlreadyServing } from "../../src/lock.ts"
import { claudeCodeBody, claudeSession } from "../support/clients.ts"
import { subscriptions } from "../support/fixtures.ts"
import { type Harness as HarnessShape, Harness } from "../support/harness.ts"

/** Which ChatGPT workspace served a Codex request in session `session`. */
const servedBy = (harness: HarnessShape, session: string) =>
  Effect.gen(function* () {
    const answer = yield* harness.codex({ headers: { "session-id": session } })
    expect(answer.status).toBe(200)
    return harness.upstream.seen.at(-1)?.headers.get("chatgpt-account-id")
  })

describe("restarting the daemon", () => {
  it.live("a spent account stays benched across a restart", () =>
    Effect.gen(function* () {
      const first = yield* Harness.ports({ accounts: yield* subscriptions("claude", ["tok-limited", "tok-ok"]) })
      expect((yield* first.claude()).status).toBe(200)
      const benched = (yield* first.health(AccountId.make("claude-0"))).blockedUntil
      expect(benched).toBeDefined()

      const second = yield* first.restart
      expect((yield* second.health(AccountId.make("claude-0"))).blockedUntil).toEqual(benched)
      second.upstream.clear()
      // A new session is placed past the spent account without asking it again.
      const fresh = yield* second.claude({
        headers: { "x-claude-code-session-id": "sess-2" },
        body: claudeCodeBody().replace(claudeSession, "sess-2"),
      })
      expect(fresh.status).toBe(200)
      expect(second.upstream.seen.map((call) => call.token)).toEqual(["tok-ok"])
    }),
  )

  it.live("each session keeps its account across a restart", () =>
    Effect.gen(function* () {
      const first = yield* Harness.ports({
        accounts: yield* subscriptions("codex", ["tok-ok", "tok-ok"]),
        settings: { strategy: "round-robin" },
      })
      expect(yield* servedBy(first, "a")).toBe("acct-codex0")
      expect(yield* servedBy(first, "b")).toBe("acct-codex1")

      const second = yield* first.restart
      // Asked first after the restart, "b" would be placed on codex0 if its binding were lost.
      expect(yield* servedBy(second, "b")).toBe("acct-codex1")
      expect(yield* servedBy(second, "a")).toBe("acct-codex0")
    }),
  )

  it.live("what the ledger recorded before a restart is there after it", () =>
    Effect.gen(function* () {
      const first = yield* Harness.ports({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
      yield* first.codex()
      yield* first.codex()
      expect(yield* first.ledger).toHaveLength(2)

      const second = yield* first.restart
      yield* second.codex()
      const records = yield* second.ledger
      expect(records).toHaveLength(3)
      expect(records.every((record) => record._tag === "Request" && record.account === "codex-0")).toBe(true)
      // The API's usage sums read the same history.
      const api = yield* second.api
      const summary = yield* api.usage.summary({ query: { range: "all", by: "account" } })
      expect(summary.total.requests).toBe(3)
    }),
  )

  it.live("a second daemon on the same home is refused while the first runs, and starts once it stops", () =>
    Effect.gen(function* () {
      const first = yield* Harness.ports({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
      const refused = yield* Effect.exit(first.alongside)
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        const error = refused.cause.reasons.find((reason) => reason._tag === "Fail")
        expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(AlreadyServing)
      }
      // The first daemon was not disturbed.
      expect((yield* first.codex()).status).toBe(200)

      yield* first.stop
      const next = yield* first.alongside
      expect((yield* next.codex()).status).toBe(200)
    }),
  )
})
