import { describe, expect, it as plain } from "bun:test"
import * as net from "node:net"

import { it } from "@slopmax/test"
import { Effect, Result } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"
import type { json as Json } from "@slopmax/wire"

import { Account } from "../../../src/account.ts"
import { available, Claimed, Credits, isUuid, refusedCaller } from "../../../src/provider/claude/credits.ts"
import { API } from "../../../src/provider/claude/mod.ts"
import { profile } from "../../../src/provider/claude/oauth.ts"
import { USER_AGENT } from "../../../src/version.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../../src/testkit.ts"

const ts = (text: string): Timestamp => {
  const parsed = Timestamp.parse(text)
  if (parsed._tag === "Failure") throw new Error(text)
  return parsed.success
}

const ORG = "6f1a2b3c-0000-4000-8000-123456789abc"
const AGENT = "claude-cli/2.1.0 (external, cli)"

const account = (org: string): Account =>
  Account.assignId({ ...Account.make("claude", { accessToken: "tok" }, 0), orgId: org })

const plainClient = () => Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))

const outcome = (result: string, reason?: string) =>
  Claimed.outcome(reason === undefined ? { result } : { result, reason })

const listed = (body: Json.Json, now: Timestamp) => Result.getOrThrow(available(body, now))

describe("provider/claude/credits", () => {
  plain("grants_list_one_credit_per_reset_the_next_first", () => {
    const body = {
      five_hour: { utilization: 4.0 },
      cedar_ember: {
        eligible: true,
        grants: [
          { id: "late", label: "Later", resets_total: 1, resets_left: 1, ends_at: "2026-12-01T00:00:00+00:00" },
          {
            id: "opus55-launch-promax-20260921",
            label: "Claude Opus 5.5 launch:\none usage-limit reset  for Pro and Max",
            resets_total: 2,
            resets_left: 2,
            starts_at: "2026-09-22T16:00:00+00:00",
            ends_at: "2026-10-22T16:00:00+00:00",
            clears: ["five_hour", "seven_day"],
            usable_now: true,
          },
          { id: "soon", resets_total: 1, resets_left: 1, ends_at: "2026-10-09T00:00:00+00:00" },
          { id: "spent", resets_total: 1, resets_left: 0 },
          { id: "lapsed", resets_total: 1, resets_left: 1, ends_at: "2026-10-01T00:00:00+00:00" },
          { id: "Not Valid!", resets_total: 1, resets_left: 1 },
          { id: "no-count" },
        ],
        next_grant_id: "opus55-launch-promax-20260921",
      },
    }
    const credits = listed(body, ts("2026-10-07T21:00:00Z"))
    expect(credits.map((c) => c.id)).toEqual([
      "opus55-launch-promax-20260921",
      "opus55-launch-promax-20260921",
      "soon",
      "late",
    ])
    const launch = credits[0]
    expect(launch?.title).toBe("Claude Opus 5.5 launch: one usage-limit reset for Pro and Max")
    expect(launch?.grantedAt).toBe(ts("2026-09-22T16:00:00Z"))
    expect(launch?.expiresAt).toBe(ts("2026-10-22T16:00:00Z"))
  })

  plain("a_refused_caller_or_an_account_without_any_lists_none", () => {
    const now = ts("2026-10-07T21:00:00Z")
    const refused = {
      five_hour: { utilization: 4.0 },
      cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
    }
    expect(listed(refused, now)).toEqual([])
    expect(refusedCaller(refused)).toBe("surface")
    const none = { cedar_ember: { eligible: false, ineligible_reason: "no_grant" } }
    expect(listed(none, now)).toEqual([])
    expect(refusedCaller(none)).toBeUndefined()
    expect(listed({ cedar_ember: null }, now)).toEqual([])
    expect(listed({ five_hour: {} }, now)).toEqual([])
    expect(Result.isFailure(available(["not", "usage"], now))).toBe(true)
    expect(Result.isFailure(available({ cedar_ember: "odd" }, now))).toBe(true)
  })

  plain("claims_answer_as_outcomes", () => {
    expect(outcome("reset")).toBe("reset")
    expect(outcome("not_limited", "not_limited")).toBe("nothing_to_reset")
    expect(outcome("already_used", "already_used")).toBe("already_redeemed")
    expect(outcome("ineligible", "expired")).toBe("no_credit")
    expect(outcome("cooldown", "cooldown")).toBe("declined")
    expect(outcome("unavailable", "paused")).toBe("declined")
    expect(outcome("something_new")).toBe("declined")
  })

  plain("only_a_uuid_names_the_organization", () => {
    expect(isUuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4")).toBe(true)
    expect(isUuid("org-claude0")).toBe(false)
    expect(isUuid("../../v1/messages?x=0b4e1f5a-9c2d-4e8f-a1")).toBe(false)
    expect(isUuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4/x")).toBe(false)
  })

  it.live("nothing_is_listed_or_spent_before_claude_code_is_seen", () =>
    Effect.gen(function* () {
      const http = yield* plainClient()
      const err = yield* Effect.flip(Credits.list(http, account(ORG), undefined))
      expect(err.message.startsWith("Claude answers limit resets to Claude Code alone")).toBe(true)
      const again = yield* Effect.flip(Credits.redeem(http, account(ORG), undefined, "g"))
      expect(again.message).toContain("none of its requests")
      expect(Credits.needsAgent).toBe(true)
      expect(Credits.counted).toBe(false)
    }),
  )

  it.live("failures_name_the_step_that_failed", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) => {
        if (Seen.route(seen) !== "/api/oauth/usage") return reply(500, "")
        return Seen.header(seen, "user-agent") === AGENT
          ? json(200, { cedar_ember: { eligible: true, grants: [] } })
          : reply(503, "")
      })
      const http = yield* mock.client([API])
      const err = yield* Effect.flip(Credits.list(http, account(ORG), "other"))
      expect(err.message).toBe("listing limit resets failed (503 Service Unavailable)")
      // Nothing listed: nothing to spend.
      expect(yield* Credits.redeem(http, account(ORG), AGENT, undefined)).toBe("no_credit")
      const failed = yield* Effect.flip(Credits.redeem(http, account(ORG), AGENT, "grant"))
      expect(failed.message).toBe("using a limit reset failed (500 Internal Server Error)")
      const unknown = yield* Effect.flip(Credits.redeem(http, account("not-a-uuid"), AGENT, "grant"))
      expect(unknown.message).toBe("the account's organization is unknown; sign in again")
    }),
  )

  it.live("unreachable_servers_fail_after_a_retry", () =>
    Effect.gen(function* () {
      const http = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([[API, "http://127.0.0.1:9"]]))
        .build()
        .pipe(Effect.provide(noEnv))
      const result = yield* Effect.result(Credits.redeem(http, account(ORG), AGENT, "grant"))
      expect(result._tag).toBe("Failure")
    }),
  )

  plain("odd_usage_replies_are_errors_or_empty", () => {
    const now = ts("2026-10-01T00:00:00Z")
    expect(Result.isFailure(available([], now))).toBe(true)
    expect(Result.isFailure(available({ cedar_ember: "yes" }, now))).toBe(true)
    expect(listed({ cedar_ember: null }, now)).toEqual([])
  })
})

describe("provider/claude/credits, beyond the Rust tests", () => {
  it.live("listing and spending go as Claude Code", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) => {
        if (Seen.route(seen) === "/api/oauth/usage") {
          return json(200, {
            cedar_ember: {
              eligible: true,
              grants: [{ id: "g-1", resets_left: 25, label: "  Launch\treset " }],
            },
          })
        }
        return json(200, { result: "cooldown" })
      })
      const http = yield* mock.client([API])
      const credits = yield* Credits.list(http, account(ORG), AGENT)
      // At most 20 per grant.
      expect(credits.length).toBe(20)
      expect(credits[0]?.title).toBe("Launch reset")
      const listing = mock.seenAt("/api/oauth/usage")[0]
      expect(listing?.path).toBe("/api/oauth/usage?cedar_ember=1&skip_spend=1")
      expect(listing && Seen.header(listing, "user-agent")).toBe(AGENT)
      expect(listing && Seen.header(listing, "anthropic-beta")).toBe("oauth-2025-04-20")
      expect(listing && Seen.header(listing, "authorization")).toBe("Bearer tok")

      expect(yield* Credits.redeem(http, account(ORG), AGENT, undefined)).toBe("declined")
      const spent = mock.seenAt(`/api/organizations/${ORG}/reset_rate_limits`)[0]
      const body = spent === undefined ? {} : (Seen.json(spent) as Record<string, unknown>)
      expect(body.program).toBe("cedar_ember")
      expect(body.grant_id).toBe("g-1")
      expect(typeof body.request_id).toBe("string")
      expect(spent && Seen.header(spent, "user-agent")).toBe(AGENT)
    }),
  )

  it.live("a lost connection is retried once with the same request id", () =>
    Effect.gen(function* () {
      // A server that drops its first connection once the request is in,
      // and answers the next.
      const bodies: Array<string> = []
      const server = yield* Effect.acquireRelease(
        Effect.callback<net.Server>((resume) => {
          const listener = net.createServer((socket) => {
            let data = ""
            socket.on("data", (chunk) => {
              data += chunk.toString()
              const end = data.indexOf("\r\n\r\n")
              const length = Number(/content-length: *(\d+)/i.exec(data)?.[1] ?? 0)
              if (end < 0 || data.length < end + 4 + length) return
              bodies.push(data.slice(end + 4, end + 4 + length))
              if (bodies.length === 1) {
                socket.destroy()
                return
              }
              const answer = '{"result":"reset"}'
              socket.end(
                `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${answer.length}\r\n\r\n${answer}`,
              )
            })
          })
          listener.listen(0, "127.0.0.1", () => resume(Effect.succeed(listener)))
        }),
        (listener) => Effect.sync(() => listener.close()),
      )
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      const http = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([[API, `http://127.0.0.1:${port}`]]))
        .build()
        .pipe(Effect.provide(noEnv))
      expect(yield* Credits.redeem(http, account(ORG), AGENT, "g-1")).toBe("reset")
      expect(bodies.length).toBe(2)
      const [first, second] = bodies.map((b) => JSON.parse(b) as Record<string, unknown>)
      expect(typeof first?.request_id).toBe("string")
      expect(second?.request_id).toBe(first?.request_id)
      expect(second?.grant_id).toBe("g-1")
    }),
  )

  it.live("only the reset calls carry Claude Code's agent; the rest say slopmax", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/api/oauth/usage" ? json(200, { cedar_ember: null }) : json(200, {}),
      )
      const http = yield* Client.builder()
        .plainHttp()
        .userAgent(USER_AGENT)
        .origins(new Origins([[API, mock.url]]))
        .build()
        .pipe(Effect.provide(noEnv))
      yield* profile(http, "tok")
      yield* Credits.list(http, account(ORG), AGENT)
      const [looked, listing] = mock.seen()
      expect(looked && Seen.header(looked, "user-agent")).toBe(USER_AGENT)
      expect(USER_AGENT.startsWith("slopmax/")).toBe(true)
      expect(listing && Seen.header(listing, "user-agent")).toBe(AGENT)
    }),
  )
})
