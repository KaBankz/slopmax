import { describe, expect, test } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Effect } from "effect"
import {
  claimReset,
  claudeResets,
  consumeCredit,
  creditList,
  deltas,
  deltaText,
  launchGrant,
  makeMock,
  type MockState,
  serveMock,
} from "../src/mock.ts"

const startedAt = DateTime.makeUnsafe("2026-11-01T00:00:00Z")
const fresh = (): MockState => ({ startedAt, redeemed: new Set() })
const now = 1_793_500_000

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://mock${path}`, { method: "POST", body: JSON.stringify(body), headers })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://mock${path}`, { headers })

const events = (text: string) =>
  text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => frame.split("\n")[0]?.slice("event: ".length))

describe("the mock provider", () => {
  test("streams Claude's answer with usage and its rate-limit headers", async () => {
    const mock = makeMock(fresh(), () => now)
    const answer = await mock.handle(post("/v1/messages", { model: "claude-opus-5-5" }))
    expect(answer.status).toBe(200)
    expect(answer.headers.get("content-type")).toBe("text/event-stream")
    expect(answer.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed")
    expect(answer.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.21")
    expect(answer.headers.get("anthropic-ratelimit-unified-5h-reset")).toBe(String(now + 3 * 3600))
    expect(answer.headers.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.43")
    expect(answer.headers.get("anthropic-ratelimit-unified-7d-reset")).toBe(String(now + 3 * 3600 + 86_400))
    expect(answer.headers.get("request-id")).toBe("req_bench")
    const text = await answer.text()
    const kinds = events(text)
    expect(kinds[0]).toBe("message_start")
    expect(kinds.filter((kind) => kind === "content_block_delta")).toHaveLength(deltas)
    expect(kinds.slice(-3)).toEqual(["content_block_stop", "message_delta", "message_stop"])
    expect(text).toContain('"input_tokens":1200,"cache_read_input_tokens":48000,"cache_creation_input_tokens":900')
    expect(text).toContain('"usage":{"output_tokens":620}')
    expect(text).toContain(deltaText)
  })

  test("streams ChatGPT's answer with usage and its rate-limit headers", async () => {
    const mock = makeMock(fresh(), () => now)
    const answer = await mock.handle(post("/codex/responses", {}))
    expect(answer.headers.get("x-codex-primary-used-percent")).toBe("21.0")
    expect(answer.headers.get("x-codex-primary-window-minutes")).toBe("300")
    expect(answer.headers.get("x-codex-primary-reset-at")).toBe(String(now + 3 * 3600))
    expect(answer.headers.get("x-codex-secondary-used-percent")).toBe("43.0")
    expect(answer.headers.get("x-codex-secondary-window-minutes")).toBe("10080")
    const kinds = events(await answer.text())
    expect(kinds[0]).toBe("response.created")
    expect(kinds.filter((kind) => kind === "response.output_text.delta")).toHaveLength(deltas)
    expect(kinds.at(-1)).toBe("response.completed")
  })

  test("answers any other path 404", async () => {
    const mock = makeMock(fresh())
    expect((await mock.handle(get("/"))).status).toBe(404)
    expect((await mock.handle(get("/v1/messages"))).status).toBe(404)
    expect((await mock.handle(post("/v1/chat/completions", {}))).status).toBe(404)
  })

  test("lists two reset credits for each bench ChatGPT account, dated from its start", () => {
    const listed = creditList(fresh(), "bench-codex-0")
    expect(listed.available_count).toBe(2)
    expect(listed.credits.map((credit) => credit.id)).toEqual(["bench-codex-0-credit-0", "bench-codex-0-credit-1"])
    expect(listed.credits[0]?.expires_at).toBe("2026-11-01T19:00:00.000Z")
    expect(creditList(fresh(), "bench-codex-1").available_count).toBe(2)
    expect(creditList(fresh(), "someone-else").available_count).toBe(0)
  })

  test("spends a reset credit once, and lists it no more", () => {
    const state = fresh()
    expect(consumeCredit(state, "bench-codex-0-credit-0")).toEqual({ code: "reset", windows_reset: 2 })
    expect(consumeCredit(state, "bench-codex-0-credit-0")).toEqual({ code: "already_redeemed", windows_reset: 2 })
    expect(creditList(state, "bench-codex-0").credits.map((credit) => credit.id)).toEqual(["bench-codex-0-credit-1"])
  })

  test("lists Claude's launch reset to Claude Code alone, for the first account only", () => {
    const state = fresh()
    const refused = claudeResets(state, "bench-claude-0", "curl/8")
    expect(refused).toEqual({ cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } })
    const listed = claudeResets(state, "bench-claude-0", "claude-cli/2.1.291 (external, cli)")
    expect(listed.cedar_ember.eligible).toBe(true)
    expect(listed.cedar_ember.next_grant_id).toBe(launchGrant)
    expect(listed.cedar_ember.grants).toHaveLength(1)
    expect(claudeResets(state, "bench-claude-1", "claude-cli/2.1.291").cedar_ember.grants).toEqual([])
  })

  test("spends Claude's launch reset once, and refuses grants it never gave", () => {
    const state = fresh()
    expect(claimReset(state, "bench-claude-0", launchGrant).result).toBe("reset")
    expect(claimReset(state, "bench-claude-0", launchGrant).result).toBe("already_used")
    expect(claimReset(state, "bench-claude-1", launchGrant)).toEqual({ result: "ineligible", reason: "unknown_grant" })
    expect(claudeResets(state, "bench-claude-0", "claude-cli/2.1.291").cedar_ember.grants).toEqual([])
  })

  test("routes the limit-reset calls slopmax makes", async () => {
    const mock = makeMock(fresh())
    const credits = await (await mock.handle(get("/wham/rate-limit-reset-credits", bearer("bench-codex-1")))).json()
    expect(credits).toMatchObject({ available_count: 2 })
    const consumed = await mock.handle(
      post("/wham/rate-limit-reset-credits/consume", { credit_id: "bench-codex-1-credit-1" }, bearer("bench-codex-1")),
    )
    expect(await consumed.json()).toEqual({ code: "reset", windows_reset: 2 })
    const usage = await mock.handle(
      get("/api/oauth/usage?cedar_ember=1", { ...bearer("bench-claude-0"), "user-agent": "claude-cli/2.1.291" }),
    )
    expect(await usage.json()).toMatchObject({ cedar_ember: { next_grant_id: launchGrant } })
    const claimed = await mock.handle(
      post(
        "/api/organizations/00000000-0000-4000-8000-000000000000/reset_rate_limits",
        { grant_id: launchGrant },
        bearer("bench-claude-0"),
      ),
    )
    expect(await claimed.json()).toMatchObject({ result: "reset" })
  })

  it.live("listens on a real port until its scope closes", () =>
    Effect.gen(function* () {
      const url = yield* Effect.scoped(
        Effect.gen(function* () {
          const listening = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
          const answer = yield* Effect.promise(() => fetch(`${listening}/v1/messages`, { method: "POST", body: "{}" }))
          expect(answer.status).toBe(200)
          // Streamed as providers stream: chunked, with no length up front.
          expect(answer.headers.get("content-length")).toBeNull()
          expect(answer.headers.get("transfer-encoding")).toBe("chunked")
          expect(yield* Effect.promise(() => answer.text())).toContain("message_stop")
          return listening
        }),
      )
      const after = yield* Effect.promise(() =>
        fetch(`${url}/v1/messages`, { method: "POST", body: "{}" }).then(
          () => "answered",
          () => "refused",
        ),
      )
      expect(after).toBe("refused")
    }),
  )

  it.live("fails with MockCannotListen on a port that is taken", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const taken = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
        const port = Number(new URL(taken).port)
        const error = yield* Effect.flip(serveMock({ hostname: "127.0.0.1", port }))
        expect(error._tag).toBe("MockCannotListen")
        expect(error.message).toBe(
          `the mock provider cannot listen on 127.0.0.1:${port}; is something else using that port?`,
        )
      }),
    ),
  )
})
