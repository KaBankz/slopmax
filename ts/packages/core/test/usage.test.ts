import { describe, expect } from "bun:test"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { Account, Store } from "../src/account.ts"
import { API } from "../src/provider/claude/mod.ts"
import { json, Mock, reply, Seen } from "../src/testkit.ts"
import { tempDirs } from "./support/temp.ts"
import { poll } from "../src/usage.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../src/provider/registry.ts"

const ORIGINS = [API, "https://platform.claude.com"]

const account = (token: string, expiresIn: number): Account => {
  const now = Timestamp.nowUnsafe()
  const made = Account.make(
    "claude",
    { accessToken: token, refreshToken: "rt", expiresAt: Timestamp.add(now, SignedDuration.fromSecs(expiresIn)) },
    now,
  )
  return Account.assignId({ ...made, orgId: "org" })
}

const tempDir = tempDirs()

const store = (): Store => Store.at(join(tempDir("usage"), "accounts"))

/**
 * Usage answers for `accepted` only (500 for `down`), and the token
 * endpoint answers `refresh` with a new token `fresh`.
 */
const mock = (accepted: string, refresh: number) =>
  Mock.start((seen) => {
    switch (Seen.route(seen)) {
      case "/api/oauth/usage": {
        const auth = Seen.header(seen, "authorization")
        if (auth === `Bearer ${accepted}`) return json(200, { five_hour: { utilization: 30 } })
        if (auth === "Bearer down") return reply(500, "broken")
        return reply(401, "")
      }
      case "/v1/oauth/token":
        return refresh === 200
          ? json(200, { access_token: "fresh", expires_in: 28800 })
          : json(refresh, { error: "invalid_grant" })
      default:
        return reply(404, "")
    }
  })

const refreshes = (m: Mock): number => m.seenAt("/v1/oauth/token").length

describe("usage", () => {
  it.live("reads_usage_with_a_working_token", () =>
    Effect.gen(function* () {
      const m = yield* mock("live", 200)
      const [got, reading] = yield* poll(yield* m.client(ORIGINS), store(), account("live", 7200), true)
      expect(got.tokens.accessToken).toBe("live")
      expect(reading.limits.windows[0]?.used).toBe(30.0)
      expect(refreshes(m)).toBe(0)
    }),
  )

  it.live("refreshes_a_due_token_before_reading", () =>
    Effect.gen(function* () {
      const m = yield* mock("fresh", 200)
      const accounts = store()
      const [got] = yield* poll(yield* m.client(ORIGINS), accounts, account("old", 60), true)
      expect(got.tokens.accessToken).toBe("fresh")
      expect(refreshes(m)).toBe(1)
      expect((yield* accounts.get(got.id))?.tokens.accessToken).toBe("fresh")
    }),
  )

  it.live("a_rejected_token_is_refreshed_once_and_retried", () =>
    Effect.gen(function* () {
      const m = yield* mock("fresh", 200)
      const [got, reading] = yield* poll(yield* m.client(ORIGINS), store(), account("old", 7200), true)
      expect(got.tokens.accessToken).toBe("fresh")
      expect(reading.limits.windows.length).toBe(1)
      expect(refreshes(m)).toBe(1)
      expect(m.seenAt("/api/oauth/usage").length).toBe(2)
    }),
  )

  it.live("a_token_rejected_after_refresh_is_an_error", () =>
    Effect.gen(function* () {
      const m = yield* mock("nobody", 200)
      const err = yield* Effect.flip(poll(yield* m.client(ORIGINS), store(), account("old", 7200), true))
      expect(err.message).toBe("token rejected after refresh")
    }),
  )

  it.live("without_refresh_a_rejected_token_is_reported", () =>
    Effect.gen(function* () {
      const m = yield* mock("nobody", 200)
      const err = yield* Effect.flip(poll(yield* m.client(ORIGINS), store(), account("old", 60), false))
      expect(err.message).toBe("token rejected (refresh disabled)")
      expect(refreshes(m)).toBe(0)
    }),
  )

  it.live("revoked_logins_say_how_to_reconnect", () =>
    Effect.gen(function* () {
      const m = yield* mock("nobody", 400)
      const err = yield* Effect.flip(poll(yield* m.client(ORIGINS), store(), account("old", 60), true))
      expect(err.message.endsWith("; run `slopmax login claude`")).toBe(true)
    }),
  )

  it.live("passing_refresh_failures_keep_their_reason", () =>
    Effect.gen(function* () {
      const m = yield* mock("nobody", 503)
      const err = yield* Effect.flip(poll(yield* m.client(ORIGINS), store(), account("old", 7200), true))
      expect(err.message).toContain("token refresh failed (503")
    }),
  )

  it.live("other_failures_pass_through_before_and_after_a_refresh", () =>
    Effect.gen(function* () {
      const m = yield* mock("nobody", 200)
      const err = yield* Effect.flip(poll(yield* m.client(ORIGINS), store(), account("down", 7200), true))
      expect(err.message.startsWith("usage endpoint returned 500")).toBe(true)

      // The refreshed token reads a failing endpoint.
      const failing = yield* Mock.start((seen) => {
        if (Seen.route(seen) !== "/api/oauth/usage") return json(200, { access_token: "fresh" })
        return Seen.header(seen, "authorization") === "Bearer fresh" ? reply(502, "bad gateway") : reply(401, "")
      })
      const after = yield* Effect.flip(poll(yield* failing.client(ORIGINS), store(), account("old", 7200), true))
      expect(after.message.startsWith("usage endpoint returned 502")).toBe(true)
    }),
  )
})
