import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Client } from "@slopmax/net"
import type { json } from "@slopmax/wire"

import { Account } from "../../../src/account.ts"
import { encodeUnsigned } from "../../../src/auth/jwt.ts"
import type { PoolWindow } from "../../../src/limits.ts"
import { poolEvent } from "../../../src/provider/codex/limits.ts"
import { BACKEND, Codex } from "../../../src/provider/codex/mod.ts"
import { Spec, Verdict } from "../../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json as reply200, Mock, noEnv, reply, Seen } from "../../../src/testkit.ts"

const account = (token: string, workspace: string | undefined): Account => {
  const base = Account.make("codex", { accessToken: token }, 0)
  return Account.assignId(workspace === undefined ? base : { ...base, accountId: workspace })
}

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const chatgpt = () =>
  Mock.start((seen) => {
    const route = Seen.route(seen)
    const good = Seen.header(seen, "authorization") === "Bearer good"
    if (route === "/wham/usage" && good) {
      return reply200(200, {
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 60 } },
        rate_limit_reset_credits: { available_count: 2 },
      })
    }
    if (route === "/codex/models" && good) {
      return reply200(200, {
        models: [
          { slug: "gpt-6-sol", visibility: "list" },
          { slug: "gpt-hidden", visibility: "hide" },
          { slug: "gpt-plain" },
          { visibility: "list" },
        ],
      })
    }
    return reply(good ? 404 : 401, "")
  })

describe("provider/codex", () => {
  plain("requests_carry_the_token_and_workspace", () => {
    const client = new Headers({ authorization: "Bearer sm", "x-codex-turn-state": "turn" })
    const a = account("tok", "ws-1")
    const stay = Codex.headers(client, a, false)
    expect(stay.get("authorization")).toBe("Bearer tok")
    expect(stay.get("chatgpt-account-id")).toBe("ws-1")
    expect(stay.has("x-codex-turn-state")).toBe(true)
    const moved = Codex.headers(client, a, true)
    expect(moved.has("x-codex-turn-state")).toBe(false)
    expect(Codex.identity(a)).toBe("ws-1")
    expect(Spec.deviceLogin(Codex.spec)).toBe(true)
    expect(Codex.credits()).toBeDefined()
  })

  plain("translated_requests_drop_output_limits_and_moved_state", () => {
    const body: json.Json = { model: "gpt-6", max_output_tokens: 100 }
    Codex.shape("responses", body)
    expect(body).toEqual({ model: "gpt-6" })
    const notObject: json.Json = [1]
    Codex.shape("responses", notObject)
    expect(notObject).toEqual([1])

    const rebound = Codex.rebind(bytes('{"previous_response_id":"r1","input":[]}'))
    expect(rebound).toBeDefined()
    expect(new TextDecoder().decode(rebound)).not.toContain("r1")
    expect(Codex.rebind(bytes('{"input":[]}'))).toBeUndefined()
  })

  plain("verdicts_cover_limits_stale_state_and_disguised_limits", () => {
    const now = ts(1_000)
    const none = new Headers()
    const verdict = (status: number, body: string) => Codex.verdict(status, none, bytes(body), undefined, now)
    const limit = '{"error":{"type":"usage_limit_reached","resets_at":5000}}'
    expect(verdict(429, limit)._tag).toBe("Exhausted")
    expect(verdict(402, limit)._tag).toBe("Exhausted")
    expect(verdict(400, '{"error":{"code":"invalid_encrypted_content"}}')).toEqual(Verdict.StaleState)
    expect(verdict(400, "bad request")).toEqual(Verdict.Final)
    expect(verdict(502, "Your usage limit has been reached")).toEqual(Verdict.Exhausted(undefined, undefined))
    expect(verdict(502, "gateway")).toEqual(Verdict.Final)
    expect(verdict(403, "")).toEqual(Verdict.Forbidden)

    // Without a reset in the body, the headers say when.
    const spent = new Headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": "4000" })
    const body = bytes('{"error":{"type":"usage_limit_reached"}}')
    expect(Codex.verdict(429, spent, body, undefined, now)).toEqual(Verdict.Exhausted(ts(4000), undefined))
    const later = new Headers({ "retry-after": "30" })
    expect(Codex.verdict(429, later, body, undefined, now)).toEqual(
      Verdict.Exhausted(Timestamp.add(now, SignedDuration.fromSecs(30)), undefined),
    )
  })

  plain("windows_come_from_headers_and_the_pool_replaces_them", () => {
    const now = ts(1_000)
    const headers = new Headers({ "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300" })
    const limits = Codex.limits(headers, now)
    expect([limits?.windows[0]?.span, limits?.windows[0]?.used]).toEqual(["5h", 25.0])
    const pool: ReadonlyArray<PoolWindow> = [{ span: "5h", used: 60.0, resetsAt: undefined }]
    Codex.showPool(pool, headers)
    expect(headers.get("x-codex-primary-used-percent")).toBe("60.0")
    // Socket events without limits are left alone.
    const event: json.Json = { type: "codex.rate_limits" }
    poolEvent(pool, event)
    expect(event).toEqual({ type: "codex.rate_limits" })
  })

  it.live("new_tokens_are_read_for_identity", () =>
    Effect.gen(function* () {
      const access = encodeUnsigned({
        "https://api.openai.com/auth": { chatgpt_account_id: "ws-9", chatgpt_plan_type: "pro" },
      })
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      const identified = yield* Codex.identify(http, account(access, undefined))
      expect(identified.accountId).toBe("ws-9")
      expect(identified.plan).toBe("pro")
    }),
  )

  it.live("usage_reads_windows_plan_and_credits", () =>
    Effect.gen(function* () {
      const mock = yield* chatgpt()
      const http = yield* mock.client([BACKEND])
      const reading = yield* Codex.usage(http, account("good", "ws-1"))
      expect(reading.plan).toBe("pro")
      expect(reading.limits.windows[0]?.span).toBe("5h")
      expect(reading.limits.windows[0]?.used).toBe(20.0)
      expect(reading.limits.resetCredits).toBe(2)
      const sent = mock.seenAt("/wham/usage")[0]
      expect(sent && Seen.header(sent, "chatgpt-account-id")).toBe("ws-1")

      const noWorkspace = yield* Codex.usage(http, account("good", undefined))
      expect(noWorkspace.plan).toBe("pro")
      const second = mock.seenAt("/wham/usage")[1]
      expect(second).toBeDefined()
      expect(second && Seen.header(second, "chatgpt-account-id")).toBeUndefined()
      const rejected = yield* Effect.flip(Codex.usage(http, account("bad", undefined)))
      expect(rejected._tag).toBe("Unauthorized")
    }),
  )

  it.live("the_catalog_lists_visible_models", () =>
    Effect.gen(function* () {
      const mock = yield* chatgpt()
      const http = yield* mock.client([BACKEND])
      const models = yield* Codex.catalog(http, account("good", "ws-1"), "0.160.0")
      expect(models).toEqual(["gpt-6-sol", "gpt-plain"])
      const sent = mock.seenAt("/codex/models")[0]
      expect(sent?.path).toBe("/codex/models?client_version=0.160.0")
      expect(sent && Seen.header(sent, "chatgpt-account-id")).toBe("ws-1")
      expect((yield* Effect.result(Codex.catalog(http, account("good", undefined), "1")))._tag).toBe("Success")
      expect((yield* Effect.result(Codex.catalog(http, account("bad", undefined), "1")))._tag).toBe("Failure")
    }),
  )
})
