import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"

import { Account } from "../../../src/account.ts"
import type { PoolWindow } from "../../../src/limits.ts"
import { API, Claude } from "../../../src/provider/claude/mod.ts"
import { OAUTH_BETA } from "../../../src/provider/claude/oauth.ts"
import { Spec, Verdict } from "../../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../../src/testkit.ts"

const account = (token: string): Account => Account.make("claude", { accessToken: token }, 0)

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const anthropic = () =>
  Mock.start((seen) => {
    const route = Seen.route(seen)
    const auth = Seen.header(seen, "authorization")
    if (route === "/api/oauth/usage" && auth === "Bearer good") {
      return json(200, {
        five_hour: { utilization: 12.5, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 40 },
        seven_day_opus: { utilization: 70 },
      })
    }
    if (route === "/api/oauth/usage" && auth === "Bearer down") return reply(500, "x".repeat(500))
    if (route === "/api/oauth/profile" && auth === "Bearer good") {
      return json(200, { account: { email: "me@x.dev" }, organization: { organization_type: "claude_pro" } })
    }
    return reply(401, "")
  })

describe("provider/claude", () => {
  plain("accounts_are_keyed_by_organization_then_account", () => {
    let a = account("t")
    expect(Claude.identity(a)).toBeUndefined()
    a = { ...a, accountId: "acct" }
    expect(Claude.identity(a)).toBe("acct")
    a = { ...a, orgId: "org" }
    expect(Claude.identity(a)).toBe("org")
  })

  plain("requests_carry_the_token_and_the_oauth_beta", () => {
    const client = new Headers({ "x-api-key": "sm-key", "anthropic-beta": "a-1" })
    const sent = Claude.headers(client, account("tok"), false)
    expect(sent.get("authorization")).toBe("Bearer tok")
    const beta = sent.get("anthropic-beta") ?? ""
    expect(beta.includes("a-1") && beta.includes(OAUTH_BETA)).toBe(true)
    expect(Claude.credits()).toBeDefined()
    expect(Claude.spec.agentOnly).toBe("claude")
    expect(Spec.deviceLogin(Claude.spec)).toBe(false)
  })

  plain("windows_come_from_headers_and_the_pool_replaces_them", () => {
    const now = ts(1_000)
    const read = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": "2000",
    })
    const limits = Claude.limits(read, now)
    expect(limits?.windows[0]?.span).toBe("5h")
    expect(limits?.windows[0]?.used).toBe(50.0)

    const shown = new Headers(read)
    const pool: ReadonlyArray<PoolWindow> = [{ span: "5h", used: 80.0, resetsAt: undefined }]
    Claude.showPool(pool, shown)
    expect(shown.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.80")
    expect(shown.has("anthropic-ratelimit-unified-5h-reset")).toBe(false)

    // Windows Claude Code has no header for are left out.
    const monthly = new Headers(read)
    Claude.showPool([{ span: "30d", used: 10.0, resetsAt: undefined }], monthly)
    expect([...monthly.keys()]).toEqual([])
  })

  plain("verdicts_tell_spent_windows_from_fast_mode_and_auth", () => {
    const now = ts(1_000)
    const none = new Headers()
    const fast = bytes('{"error":{"message":"Fast request rejected"}}')
    expect(Claude.verdict(429, none, fast, undefined, now)).toEqual(Verdict.Final)
    const spent = new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": "5000",
    })
    expect(Claude.verdict(429, spent, bytes("{}"), undefined, now)).toEqual(Verdict.Exhausted(ts(5000), undefined))
    expect(Claude.verdict(429, none, bytes("{}"), undefined, now)).toEqual(Verdict.Throttled(undefined))
    expect(Claude.verdict(401, none, bytes(""), undefined, now)).toEqual(Verdict.Unauthorized)
    expect(Claude.verdict(400, none, bytes(""), undefined, now)).toEqual(Verdict.Final)
  })

  it.live("usage_reads_both_windows", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic()
      const http = yield* mock.client([API])
      const reading = yield* Claude.usage(http, account("good"))
      expect(reading.limits.windows.map((w) => [w.span, w.used])).toEqual([
        ["5h", 12.5],
        ["7d", 40.0],
        ["7d", 70.0],
      ])
      // Older replies name per-model weekly windows at the top level.
      expect(reading.limits.windows[2]?.model).toBe("Opus")
      expect(reading.plan).toBeUndefined()
      const sent = mock.seenAt("/api/oauth/usage")[0]
      expect(sent && Seen.header(sent, "anthropic-beta")).toBe(OAUTH_BETA)

      const rejected = yield* Effect.flip(Claude.usage(http, account("bad")))
      expect(rejected._tag).toBe("Unauthorized")
      const down = yield* Effect.flip(Claude.usage(http, account("down")))
      expect(down._tag).toBe("Failure")
      expect(down.message.startsWith("usage endpoint returned 500")).toBe(true)
      // Only the start of the body is kept.
      expect(down.message.length).toBeLessThan(300)
    }),
  )

  it.live("new_tokens_bring_the_profile", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic()
      const http = yield* mock.client([API])
      const good = yield* Claude.identify(http, account("good"))
      expect(good.email).toBe("me@x.dev")
      expect(good.plan).toBe("pro")
      // A failed lookup changes nothing.
      const bad = yield* Claude.identify(http, account("bad"))
      expect(bad.email).toBeUndefined()
    }),
  )

  it.live("unreachable_usage_endpoints_are_other_failures", () =>
    Effect.gen(function* () {
      const http = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([[API, "http://127.0.0.1:9"]]))
        .build()
        .pipe(Effect.provide(noEnv))
      const result = yield* Effect.flip(Claude.usage(http, account("good")))
      expect(result._tag).toBe("Failure")
    }),
  )
})
