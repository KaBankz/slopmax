// The daemon's own reading of the providers: each account's usage polled
// from its provider, and Claude's limit resets listed and spent as Claude
// Code, against the same scripted providers the requests reach.
import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Option } from "effect"
import { Accounts } from "../../src/accounts.ts"
import { Quota } from "../../src/quota.ts"
import { claudeAgent, parseJson } from "../support/clients.ts"
import { claudeOrg, subscriptions } from "../support/fixtures.ts"
import { transports } from "../support/harness.ts"

/** An account's windows as `span used%`. */
const windowsOf = (windows: ReadonlyArray<{ readonly span: string; readonly used: number }>) =>
  windows.map((window) => `${window.span} ${window.used}%`)

for (const [where, make] of transports) {
  describe(`reading the providers ${where}`, () => {
    it.live("polls each subscription's usage from its provider", () =>
      Effect.gen(function* () {
        const claude = yield* subscriptions("claude", ["tok-ok"])
        const codex = yield* subscriptions("codex", ["tok-ok"])
        const harness = yield* make({ accounts: [...claude, ...codex] })
        yield* harness.run(Effect.flatMap(Quota, (quota) => quota.pollDue({ force: true })))

        const claudeHealth = yield* harness.health(AccountId.make("claude-0"))
        expect(windowsOf(claudeHealth.limits.windows)).toEqual(["5h 25%"])
        const codexHealth = yield* harness.health(AccountId.make("codex-0"))
        expect(windowsOf(codexHealth.limits.windows)).toEqual(["5h 5%"])
        expect(codexHealth.limits.plan).toBe("pro")
        expect(
          harness.upstream.seen.map((seen) => `${seen.method} ${seen.url.origin}${seen.url.pathname}`).toSorted(),
        ).toEqual(["GET https://api.anthropic.com/api/oauth/usage", "GET https://chatgpt.com/backend-api/wham/usage"])
      }),
    )

    it.live(
      "lists Claude's limit resets as Claude Code once it has been seen, and spends the one Claude spends next",
      () =>
        Effect.gen(function* () {
          const harness = yield* make({ accounts: yield* subscriptions("claude", ["tok-ok"]) })
          const id = AccountId.make("claude-0")
          const account = yield* harness.run(
            Effect.map(
              Effect.flatMap(Accounts, (accounts) => accounts.fresh(id)),
              Option.getOrThrow,
            ),
          )
          // Claude answers its resets to Claude Code alone, so none are asked for before it has called.
          const early = yield* Effect.flip(harness.run(Effect.flatMap(Quota, (quota) => quota.listResets(account))))
          expect(early._tag).toBe("NeedsAgent")

          expect((yield* harness.claude()).status).toBe(200)
          harness.upstream.clear()
          yield* harness.run(Effect.flatMap(Quota, (quota) => quota.listDue({ force: true })))
          const listed = yield* harness.health(id)
          expect(listed.resets?.list.map((reset) => reset.id)).toEqual(["launch", "older"])

          const outcome = yield* harness.run(Effect.flatMap(Quota, (quota) => quota.redeem(account)))
          expect(outcome).toBe("reset")
          const [spent] = harness.upstream.at(`/api/organizations/${claudeOrg(0)}/reset_rate_limits`)
          expect(parseJson(spent?.text ?? "")).toMatchObject({ program: "cedar_ember", grant_id: "launch" })
          expect(harness.upstream.seen.every((seen) => seen.headers.get("user-agent") === claudeAgent)).toBe(true)
        }),
    )

    it.live("lists none for an account Claude has granted no limit resets", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("claude", ["tok-ok", "tok-limited"]) })
        expect((yield* harness.claude()).status).toBe(200)
        yield* harness.run(Effect.flatMap(Quota, (quota) => quota.listDue({ force: true })))
        expect((yield* harness.health(AccountId.make("claude-0"))).resets?.list).toHaveLength(2)
        const none = yield* harness.health(AccountId.make("claude-1"))
        expect(none.resets?.list).toEqual([])
        expect(none.resets?.listedAt).toBeDefined()
      }),
    )
  })
}
