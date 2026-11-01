import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { type Account, accountText } from "../../src/account.ts"
import { Events } from "../../src/events.ts"
import { Ledger } from "../../src/ledger.ts"
import { Pool, SavedState } from "../../src/pool.ts"
import { Quota } from "../../src/quota.ts"
import { offline, report } from "../../src/report.ts"
import { home, json, mockUpstream, reply, storeLayer } from "../providers/support.ts"
import { subscription } from "../pool/fixtures.ts"

const stateFile = `${home}/state.json`

const layerWith = (upstream: ReturnType<typeof mockUpstream>, accounts: ReadonlyArray<Account>, state?: unknown) =>
  Quota.layer.pipe(
    Layer.provideMerge(Pool.layer),
    Layer.provideMerge(Ledger.layer),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(
      storeLayer(
        upstream.layer,
        {},
        {
          files: {
            ...Object.fromEntries(
              accounts.map((account) => [`${home}/accounts/${account.id}.json`, accountText(account)]),
            ),
            ...(state === undefined ? {} : { [stateFile]: JSON.stringify(state) }),
          },
        },
      ),
    ),
    Layer.provideMerge(DateTime.layerCurrentZoneOffset(0)),
  )

/** ChatGPT's usage endpoint, fresh for each test so one test's calls are not seen by another. */
const chatgptUsage = () =>
  mockUpstream((seen) => {
    if (seen.url.pathname !== "/backend-api/wham/usage") return reply(404)
    if (seen.headers.get("authorization") === "Bearer token-broken") return reply(503, "down")
    return json(200, {
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
    })
  })

describe("the report without a running proxy", () => {
  const good = subscription("codex", "good")
  const broken = subscription("codex", "broken")
  const out = subscription("codex", "out", 0, { authError: "revoked" })

  it.effect("reads state.json and shows no live sessions", () => {
    const chatgpt = chatgptUsage()
    return Effect.gen(function* () {
      const built = yield* offline({ refresh: false })
      expect(built.live).toBe(false)
      expect(built.accounts.map((account) => [account.id, account.sessions, account.notes.map((n) => n._tag)])).toEqual(
        [[good.id, 0, ["Pinned", "LastError"]]],
      )
      expect(chatgpt.seen).toHaveLength(0)
      expect(built.pools[0]?.next?.reason).toBe("pinned")
    }).pipe(
      Effect.provide(
        layerWith(chatgpt, [good], {
          pins: { codex: good.id },
          health: { [good.id]: { lastError: "earlier" } },
          sessions: [{ provider: "codex", id: "s", account: good.id, at: "1970-01-01T00:00:00Z" }],
        }),
      ),
    )
  })

  it.effect(
    "with a refresh, reads every signed-in subscription's usage, records failures, and writes state.json",
    () => {
      const chatgpt = chatgptUsage()
      return Effect.gen(function* () {
        const built = yield* offline({ refresh: true })
        const byId = new Map(built.accounts.map((account) => [account.id, account]))
        expect(byId.get(good.id)?.windows.map((w) => w.used)).toEqual([35])
        expect(byId.get(broken.id)?.notes).toContainEqual(expect.objectContaining({ _tag: "LastError" }))
        const lastError = byId.get(broken.id)?.notes.find((note) => note._tag === "LastError")
        expect(lastError?._tag === "LastError" ? lastError.text : "").toStartWith("usage poll: ")
        expect(byId.get(out.id)?.condition._tag).toBe("SignInNeeded")
        expect(chatgpt.seen.filter((seen) => seen.headers.get("authorization") === "Bearer token-out")).toHaveLength(0)
        const fs = yield* FileSystem.FileSystem
        const saved = Schema.decodeUnknownSync(Schema.fromJsonString(SavedState))(yield* fs.readFileString(stateFile))
        expect(saved.health[good.id]?.limits.windows[0]?.used).toBe(35)
        // The live report reads the same pool.
        expect((yield* report(true)).live).toBe(true)
      }).pipe(Effect.provide(layerWith(chatgpt, [good, broken, out])))
    },
  )
})
