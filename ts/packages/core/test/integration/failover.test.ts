// The failover loop's less traveled turns, end to end: a rejected token
// refreshed and retried, a refresh that is refused, an endpoint that does
// not answer, a throttled account, a stream that opens overloaded, and
// requests routing turns away.
//
// The mock answers by bearer token, as in `proxy.test.ts`, and also stands
// in for Anthropic's token endpoint.
import { createServer } from "node:net"

import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect } from "effect"

import type { Account } from "../../src/account.ts"
import { Config } from "../../src/config.ts"
import { AccountState } from "../../src/pool.ts"
import {
  endpointAt,
  type Harness,
  harness,
  KEY,
  oauth,
  parse,
  pick,
  recording,
  reply,
  type Seen,
  send,
} from "./harness.ts"

const CLAUDE_STREAM =
  "event: message_start\n" +
  `data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}` +
  "\n\n"

const CODEX_STREAM =
  'data: {"type":"response.created","response":{"id":"r"}}\n\n' +
  'data: {"type":"response.output_text.delta","item_id":"m1","delta":"hi"}\n\n' +
  'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'

const SSE = "text/event-stream"
const JSON_TYPE = "application/json"

const answer = (status: number, contentType: string, body: string) =>
  reply(status, [["content-type", contentType]], body)

const mock = recording((_log, request, headers, body) =>
  Effect.sync(() => {
    const path = request.url.split("?")[0] ?? ""
    const authorization = headers.get("authorization") ?? ""
    const route = `${request.method} ${path}`
    if (route === "POST /v1/oauth/token") {
      return pick(parse(body), "refresh_token") === "refresh-good"
        ? answer(
            200,
            JSON_TYPE,
            JSON.stringify({ access_token: "tok-renewed", refresh_token: "refresh-next", expires_in: 3600 }),
          )
        : answer(400, JSON_TYPE, `{"error":"invalid_grant","error_description":"refresh token revoked"}`)
    }
    if (route === "GET /api/oauth/profile") return answer(200, JSON_TYPE, "{}")
    if (route === "POST /v1/messages") {
      if (authorization === "Bearer tok-ok" || authorization === "Bearer tok-renewed") {
        return answer(200, SSE, CLAUDE_STREAM)
      }
      // Briefly held back: a 429 that names no spent window.
      if (authorization === "Bearer tok-busy") {
        return answer(429, JSON_TYPE, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`)
      }
      return answer(
        401,
        JSON_TYPE,
        `{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}`,
      )
    }
    if (route === "POST /backend-api/codex/responses" && authorization === "Bearer tok-ok") {
      return answer(200, SSE, CODEX_STREAM)
    }
    // Opens a 200 stream, then says the server is overloaded.
    if (route === "POST /backend-api/codex/responses" && authorization === "Bearer tok-overloaded") {
      return answer(
        200,
        SSE,
        'data: {"type":"response.created","response":{"id":"r"}}\n\n' +
          'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"try later"}}}\n\n',
      )
    }
    if (route === "POST /local/v1/chat/completions") {
      return answer(
        200,
        JSON_TYPE,
        JSON.stringify({
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        }),
      )
    }
    return answer(404, JSON_TYPE, "{}")
  }),
)

/** Requests to `path` (without query) the mock saw. */
const seen = (h: Harness, path: string): Array<Seen> => h.log.filter((s) => (s.path.split("?")[0] ?? "") === path)

const stored = (h: Harness, id: string) =>
  Effect.map(h.app.store.get(id).pipe(Effect.orDie), (account) => {
    if (account === undefined) throw new Error(`${id} is not stored`)
    return account
  })

const endpoint = (base: string, added: number): Account => endpointAt(base, "chat", ["local-model"], "key-local", added)

const harnessOf = (build: (upstream: string) => ReadonlyArray<Account>, refreshTokens: boolean) =>
  harness({
    prefix: "slopmax-failover",
    mock,
    accounts: build,
    config: { ...Config.default(), apiKey: KEY, strategy: "fill-first", refreshTokens },
    origins: (upstream) => [
      ["https://api.anthropic.com", upstream],
      ["https://platform.claude.com", upstream],
      ["https://chatgpt.com", upstream],
    ],
  })

const CLAUDE_BODY = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}`

const claude = (h: Harness, path: string, userAgent: string) =>
  send(
    h.client
      .post(`${h.proxy}${path}`)
      .header("authorization", `Bearer ${KEY}`)
      .header("user-agent", userAgent)
      .header("content-type", "application/json")
      .body(CLAUDE_BODY),
  )

const claudeCode = (h: Harness) => claude(h, "/v1/messages", "claude-cli/2.1.287 (external, cli)")

const post = (h: Harness, path: string, body: string) =>
  send(
    h.client
      .post(`${h.proxy}${path}`)
      .header("authorization", `Bearer ${KEY}`)
      .header("content-type", "application/json")
      .body(body),
  )

const id = (h: Harness, i: number): string => h.ids[i] ?? ""

describe("tests/failover", () => {
  it.live("a_rejected_token_is_refreshed_and_the_request_retried", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(() => [oauth("claude", "a", "tok-stale", "refresh-good", 1000)], true)
      const response = yield* claudeCode(h)
      expect(response.status).toBe(200)
      expect(response.body).toContain("message_start")

      expect(seen(h, "/v1/messages").map((s) => s.headers.get("authorization"))).toEqual([
        "Bearer tok-stale",
        "Bearer tok-renewed",
      ])
      const refresh = seen(h, "/v1/oauth/token")
      expect(refresh.length).toBe(1)
      expect(pick(parse((refresh[0] as Seen).body), "grant_type")).toBe("refresh_token")

      // The rotated tokens are saved for next time.
      const saved = yield* stored(h, id(h, 0))
      expect(saved.tokens.accessToken).toBe("tok-renewed")
      expect(saved.tokens.refreshToken).toBe("refresh-next")
      expect(saved.authError).toBeUndefined()
    }),
  )

  it.live("a_refused_refresh_moves_on_to_the_next_account", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(
        () => [
          oauth("claude", "a", "tok-stale", "refresh-revoked", 1000),
          oauth("claude", "b", "tok-ok", "refresh-b", 1001),
        ],
        true,
      )
      expect((yield* claudeCode(h)).status).toBe(200)
      expect(seen(h, "/v1/messages").map((s) => s.headers.get("authorization"))).toEqual([
        "Bearer tok-stale",
        "Bearer tok-ok",
      ])
      // The first account is marked as needing a new login, and benched.
      expect((yield* stored(h, id(h, 0))).authError).toBeDefined()
      expect((yield* h.app.pool.state(id(h, 0))).lastError).toBeDefined()

      // A request placed afresh (its session would keep it on the second
      // anyway) skips the first without trying it or refreshing it again,
      // even before the pool reloads the accounts from disk.
      h.log.length = 0
      const response = yield* send(
        h.client
          .post(`${h.proxy}/v1/messages`)
          .header("authorization", `Bearer ${KEY}`)
          .header("user-agent", "claude-cli/2.1.287 (external, cli)")
          .header("x-slopmax-affinity", "off")
          .header("content-type", "application/json")
          .body(CLAUDE_BODY),
      )
      // No second refresh.
      expect(seen(h, "/v1/oauth/token")).toEqual([])
      expect(response.status).toBe(200)
      expect(seen(h, "/v1/messages").map((s) => s.headers.get("authorization"))).toEqual(["Bearer tok-ok"])
    }),
  )

  it.live("without_refreshing_a_rejected_token_benches_the_account", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(
        () => [
          oauth("claude", "a", "tok-stale", "refresh-good", 1000),
          oauth("claude", "b", "tok-ok", "refresh-b", 1001),
        ],
        false,
      )
      expect((yield* claudeCode(h)).status).toBe(200)
      expect(seen(h, "/v1/oauth/token")).toEqual([])
      expect(AccountState.isBlocked(yield* h.app.pool.state(id(h, 0)), Date.now())).toBe(true)
    }),
  )

  it.live("a_throttled_account_is_set_aside_briefly_not_blocked", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(
        () => [oauth("claude", "a", "tok-busy", "refresh-a", 1000), oauth("claude", "b", "tok-ok", "refresh-b", 1001)],
        false,
      )
      expect((yield* claudeCode(h)).status).toBe(200)
      const now = Date.now()
      const busy = yield* h.app.pool.state(id(h, 0))
      expect((busy.throttledUntil ?? 0) > now).toBe(true)
      expect(AccountState.isBlocked(busy, now)).toBe(false)
    }),
  )

  it.live("only_throttled_accounts_pass_the_refusal_back", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(() => [oauth("claude", "a", "tok-busy", "refresh-a", 1000)], false)
      const response = yield* claudeCode(h)
      expect(response.status).toBe(429)
      expect(response.body.includes("rate_limit_error") || response.body.includes("slow down")).toBe(true)
    }),
  )

  it.live("an_unreachable_endpoint_fails_over_and_records_why", () =>
    Effect.gen(function* () {
      // A port that was free a moment ago, with nothing listening on it.
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const probe = createServer()
            probe.listen(0, "127.0.0.1", () => {
              const address = probe.address()
              const free = typeof address === "object" && address !== null ? address.port : 0
              probe.close(() => resolve(free))
            })
          }),
      )
      const closed = `http://127.0.0.1:${port}/v1`
      const h = yield* harnessOf((upstream) => [endpoint(closed, 1000), endpoint(`${upstream}/local/v1`, 1001)], false)
      const response = yield* post(
        h,
        "/v1/chat/completions",
        `{"model":"local-model","messages":[{"role":"user","content":"hi"}]}`,
      )
      expect(response.status).toBe(200)
      expect(response.body).toContain("chat.completion")
      const down = yield* h.app.pool.state(id(h, 0))
      expect(down.lastError?.startsWith("network error")).toBe(true)
    }),
  )

  it.live("codex_streams_that_open_overloaded_move_on_without_benching", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(
        () => [
          oauth("codex", "a", "tok-overloaded", "refresh-a", 1000),
          oauth("codex", "b", "tok-ok", "refresh-b", 1001),
        ],
        false,
      )
      const response = yield* post(h, "/codex/responses", `{"model":"gpt-6-sol","input":[],"stream":true}`)
      expect(response.status).toBe(200)
      expect(response.body).toContain("response.completed")
      expect(response.body).not.toContain("server_is_overloaded")
      const now = Date.now()
      const first = yield* h.app.pool.state(id(h, 0))
      expect((first.throttledUntil ?? 0) > now).toBe(true)
      expect(AccountState.isBlocked(first, now)).toBe(false)
    }),
  )

  it.live("requests_without_a_model_are_turned_away", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf((upstream) => [endpoint(`${upstream}/local/v1`, 1000)], false)
      const response = yield* post(h, "/v1/chat/completions", `{"messages":[]}`)
      expect(response.status).toBe(400)
      expect(response.body).toContain("the request names no model")
      expect(seen(h, "/local/v1/chat/completions")).toEqual([])
    }),
  )

  it.live("claude_paths_refuse_other_clients_before_routing", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(() => [oauth("claude", "a", "tok-ok", "refresh-a", 1000)], false)
      // A path routed by where it goes rather than by model.
      const response = yield* claude(h, "/claude/v1/messages/count_tokens", "curl/8.7.1")
      expect(response.status).toBe(403)
      expect(response.body).toContain("to Claude Code only")
      expect(response.body).toContain("this request came from curl/8.7.1")
      expect(seen(h, "/v1/messages/count_tokens")).toEqual([])
    }),
  )
})
