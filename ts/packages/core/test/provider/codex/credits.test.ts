import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect, Schema } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"

import { Account } from "../../../src/account.ts"
import { available, CreditListSchema, Credits } from "../../../src/provider/codex/credits.ts"
import { BACKEND } from "../../../src/provider/codex/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../../src/testkit.ts"

const account = (workspace: string | undefined): Account => {
  const base = Account.make("codex", { accessToken: "tok" }, 0)
  return workspace === undefined ? base : { ...base, accountId: workspace }
}

describe("provider/codex/credits", () => {
  plain("only_codex_window_credits_count", () => {
    const listed = Schema.decodeUnknownSync(CreditListSchema)(
      JSON.parse(`{"credits": [
        {"id": "late", "status": "available", "reset_type": "codex_rate_limits", "granted_at": "2026-11-01T09:30:00Z", "expires_at": "2026-12-01T00:00:00Z"},
        {"id": "review", "status": "available", "reset_type": "code_review_rate_limits", "expires_at": "2026-10-05T00:00:00Z"},
        {"id": "spent", "status": "redeemed", "reset_type": "codex_rate_limits", "expires_at": "2026-10-06T00:00:00Z"},
        {"id": "soon", "status": "available", "reset_type": "codex_rate_limits", "expires_at": "2026-10-07T00:00:00Z"},
        {"id": "untyped", "expires_at": "2026-11-01T00:00:00Z"}
      ]}`),
    )
    const credits = available(listed)
    expect(credits.map((c) => c.id)).toEqual(["soon", "untyped", "late"])
    const granted = Timestamp.parse("2026-11-01T09:30:00Z")
    expect(credits[2]?.grantedAt).toBe(granted._tag === "Success" ? granted.success : -1)
  })

  it.live("listing_and_redeeming_report_failures", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) => {
        const route = Seen.route(seen)
        if (route === "/wham/rate-limit-reset-credits") return reply(502, "")
        if (route === "/wham/rate-limit-reset-credits/consume") {
          const body = Seen.json(seen) as Record<string, unknown>
          if (body.credit_id !== undefined) return reply(409, "")
        }
        return json(200, { code: "nothing_to_reset" })
      })
      const http = yield* mock.client([BACKEND])
      const err = yield* Effect.flip(Credits.list(http, account(undefined), undefined))
      expect(err.message).toBe("listing reset credits failed (502 Bad Gateway)")
      const seen = mock.seen()[0]
      expect(seen && Seen.header(seen, "chatgpt-account-id")).toBeUndefined()
      expect(seen && Seen.header(seen, "authorization")).toBe("Bearer tok")

      const conflict = yield* Effect.flip(Credits.redeem(http, account("ws"), undefined, "c1"))
      expect(conflict.message).toBe("redeeming a reset credit failed (409 Conflict)")
      expect(yield* Credits.redeem(http, account("ws"), undefined, undefined)).toBe("nothing_to_reset")

      const nowhere = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([[BACKEND, "http://127.0.0.1:9"]]))
        .build()
        .pipe(Effect.provide(noEnv))
      const result = yield* Effect.result(Credits.redeem(nowhere, account(undefined), undefined, undefined))
      expect(result._tag).toBe("Failure")
    }),
  )
})

describe("provider/codex/credits, beyond the Rust tests", () => {
  it.live("lists go with the workspace, and odd answers say which", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/wham/rate-limit-reset-credits"
          ? json(200, { credits: [{ id: "a", status: "AVAILABLE" }] })
          : json(200, { code: "spent" }),
      )
      const http = yield* mock.client([BACKEND])
      const credits = yield* Credits.list(http, account("ws"), undefined)
      expect(credits).toEqual([{ id: "a" }])
      const listing = mock.seen()[0]
      expect(listing && Seen.header(listing, "chatgpt-account-id")).toBe("ws")
      const odd = yield* Effect.flip(Credits.redeem(http, account("ws"), undefined, "a"))
      expect(odd.message).toBe("unexpected redeem response")
      const consume = mock.seenAt("/wham/rate-limit-reset-credits/consume")[0]
      const body = consume === undefined ? {} : (Seen.json(consume) as Record<string, unknown>)
      expect(Object.keys(body)).toEqual(["redeem_request_id", "credit_id"])
      expect(Credits.counted).toBe(true)
      expect(Credits.needsAgent).toBe(false)
    }),
  )
})
