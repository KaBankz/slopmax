// Sessions and sign-ins end to end: an agent's session keeps its account so
// the provider's prompt cache stays warm, moving only when that account
// cannot serve; and an expired or rejected sign-in is refreshed once, however
// many requests need it at the same moment.
import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect, Option, Redacted } from "effect"
import { Accounts } from "../../src/accounts.ts"
import { block, Pool } from "../../src/pool.ts"
import type { Harness } from "../support/harness.ts"
import { subscription, subscriptions } from "../support/fixtures.ts"
import { transports } from "../support/harness.ts"

/** Which ChatGPT workspace served a Codex request in session `session`. */
const servedBy = (harness: Harness, session: string) =>
  Effect.gen(function* () {
    const answer = yield* harness.codex({ headers: { "session-id": session } })
    expect(answer.status).toBe(200)
    return harness.upstream.seen.at(-1)?.headers.get("chatgpt-account-id")
  })

/** The access token an account holds now, as stored. */
const accessOf = (harness: Harness, id: string) =>
  harness.run(
    Effect.map(
      Effect.flatMap(Accounts, (accounts) => accounts.fresh(AccountId.make(id))),
      Option.match({
        onNone: () => undefined,
        onSome: (account) =>
          account.credential._tag === "OAuth" ? Redacted.value(account.credential.tokens.access) : undefined,
      }),
    ),
  )

for (const [where, make] of transports) {
  describe(`sessions ${where}`, () => {
    it.live("a session keeps its account across requests, and stays where it moved once that account was spent", () =>
      Effect.gen(function* () {
        const harness = yield* make({
          accounts: yield* subscriptions("codex", ["tok-ok", "tok-ok", "tok-ok"]),
          settings: { strategy: "round-robin" },
        })
        expect(yield* servedBy(harness, "a")).toBe("acct-codex0")
        expect(yield* servedBy(harness, "b")).toBe("acct-codex1")
        for (let round = 0; round < 3; round++) {
          expect(yield* servedBy(harness, "a")).toBe("acct-codex0")
          expect(yield* servedBy(harness, "b")).toBe("acct-codex1")
        }

        yield* harness.run(
          Effect.flatMap(Pool, (pool) =>
            pool.update((m, now) =>
              block(m, AccountId.make("codex-0"), DateTime.addDuration(now, Duration.minutes(5)), undefined, "spent"),
            ),
          ),
        )
        const moved = yield* servedBy(harness, "a")
        expect(moved).not.toBe("acct-codex0")
        for (let round = 0; round < 3; round++) expect(yield* servedBy(harness, "a")).toBe(moved)
      }),
    )

    it.live("requests racing on an expired sign-in share one refresh, and each is sent with the new token", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const expired = subscription("claude", "tok-old", 0, now, {
          refresh: "refresh-good",
          expiresAt: DateTime.subtract(now, { minutes: 1 }),
        })
        const harness = yield* make({ accounts: [expired], settings: { refreshTokens: true } })
        const answers = yield* Effect.all([harness.claude(), harness.claude(), harness.claude()], {
          concurrency: "unbounded",
        })
        expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
        expect(harness.upstream.at("/v1/oauth/token")).toHaveLength(1)
        expect(harness.upstream.at("/v1/messages").map((call) => call.token)).toEqual([
          "tok-renewed",
          "tok-renewed",
          "tok-renewed",
        ])
        // The new tokens are saved with the account, for every later request and the next start.
        expect(yield* accessOf(harness, "claude-0")).toBe("tok-renewed")
      }),
    )

    it.live("a token the provider rejects is refreshed and the request sent again on the same account", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const stale = subscription("claude", "tok-stale", 0, now, { refresh: "refresh-good" })
        const harness = yield* make({
          accounts: [stale, subscription("claude", "tok-ok", 1, now)],
          settings: { refreshTokens: true },
        })
        const answer = yield* harness.claude()
        expect(answer.status).toBe(200)
        expect(harness.upstream.at("/v1/messages").map((call) => call.token)).toEqual(["tok-stale", "tok-renewed"])
        expect(yield* accessOf(harness, "claude-0")).toBe("tok-renewed")
      }),
    )

    it.live("a refused refresh signs the account out, and the next account serves without it being tried again", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const revoked = subscription("claude", "tok-old", 0, now, {
          refresh: "refresh-revoked",
          expiresAt: DateTime.subtract(now, { minutes: 1 }),
        })
        const harness = yield* make({
          accounts: [revoked, subscription("claude", "tok-ok", 1, now)],
          settings: { refreshTokens: true },
        })
        const answer = yield* harness.claude()
        expect(answer.status).toBe(200)
        expect(harness.upstream.at("/v1/messages").map((call) => call.token)).toEqual(["tok-ok"])
        const signedOut = yield* harness.run(
          Effect.flatMap(Accounts, (accounts) => accounts.fresh(AccountId.make("claude-0"))),
        )
        expect(Option.getOrUndefined(signedOut)?.authError).toBeDefined()

        harness.upstream.clear()
        yield* harness.claude()
        expect(harness.upstream.paths()).toEqual(["/v1/messages"])
      }),
    )
  })
}
