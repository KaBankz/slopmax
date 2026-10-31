// End-to-end tests: agent → slopmax → mock provider.
//
// The mock decides how to answer from the bearer token, so each account in
// the store can be made to succeed, hit its limit, or reject its token. It
// also serves ChatGPT's reset-credit endpoints.
// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import type { HttpServerRequest } from "effect/http"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { server, ws } from "@slopmax/net"
import type { Dialect } from "@slopmax/wire"

import { type Account, Store } from "../../src/account.ts"
import { Config, type ClientKey } from "../../src/config.ts"
import * as daemon from "../../src/daemon.ts"
import { Entry } from "../../src/ledger.ts"
import type { Limits, Window } from "../../src/limits.ts"
import { AccountState } from "../../src/pool.ts"
import type { ProviderId } from "../../src/provider/mod.ts"
import * as warm from "../../src/proxy/warm.ts"
import { VERSION } from "../../src/version.ts"
import * as waste from "../../src/waste.ts"
import {
  bytes,
  endpointAt,
  entries,
  eventually,
  type Harness,
  harness,
  KEY,
  key,
  type Log,
  oauth,
  parse,
  paths,
  pick,
  recording,
  reply,
  resetIn,
  type Seen,
  send,
  status as statusOf,
  text,
} from "./harness.ts"

/** Whether a reset credit has been redeemed so far. */
const redeemed = (log: Log): boolean => log.some((s) => s.path.endsWith("/consume"))

/** How many requests carrying `token` the mock has seen, this one included. */
const count = (log: Log, token: string): number => log.filter((s) => s.headers.get("authorization") === token).length

/** `answer` for requests carrying `authorization`, else a 401. */
const keyed = (headers: Headers, authorization: string, answer: HttpServerResponse.HttpServerResponse) =>
  headers.get("authorization") === authorization ? answer : reply(401, [], "")

const chatAnswer = () =>
  reply(
    200,
    [["content-type", "application/json"]],
    JSON.stringify({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }),
  )

const SSE: ReadonlyArray<readonly [string, string]> = [["content-type", "text/event-stream"]]

const mockClaude = (headers: Headers) => {
  switch (headers.get("authorization")) {
    case "Bearer tok-limited":
      return reply(
        429,
        [
          ["anthropic-ratelimit-unified-status", "rejected"],
          ["anthropic-ratelimit-unified-5h-status", "rejected"],
          ["anthropic-ratelimit-unified-5h-reset", String(resetIn(3600))],
          ["anthropic-ratelimit-unified-5h-utilization", "1.0"],
        ],
        `{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}`,
      )
    case "Bearer tok-ok":
      return reply(
        200,
        [
          ["content-type", "text/event-stream"],
          ["anthropic-ratelimit-unified-5h-utilization", "0.25"],
          ["anthropic-ratelimit-unified-5h-reset", String(resetIn(7200))],
        ],
        "event: message_start\n" +
          `data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}` +
          "\n\nevent: message_delta\n" +
          `data: {"type":"message_delta","usage":{"output_tokens":25}}` +
          "\n\n",
      )
    case "Bearer tok-fast":
      return reply(
        429,
        [["anthropic-ratelimit-unified-status", "allowed"]],
        `{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}`,
      )
    default:
      return reply(401, [], `{"type":"error","error":{"type":"authentication_error"}}`)
  }
}

const mockCodex = (log: Log, headers: Headers) => {
  const token = headers.get("authorization") ?? ""
  // `tok-credit` is spent until a reset credit is redeemed.
  const spent = token === "Bearer tok-limited" || (token === "Bearer tok-credit" && !redeemed(log))
  // Answers with reasoning, text, and a tool call.
  if (token === "Bearer tok-talk") {
    return reply(
      200,
      SSE,
      'data: {"type":"response.created","response":{"id":"r"}}\n\n' +
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[],"encrypted_content":"enc-1"}}\n\n' +
        'data: {"type":"response.output_text.delta","item_id":"m1","delta":"Hello"}\n\n' +
        'data: {"type":"response.output_item.done","item":{"type":"message","id":"m1","content":[{"type":"output_text","text":"Hello"}]}}\n\n' +
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}\n\n' +
        'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":10},"output_tokens":5,"total_tokens":35}}}\n\n',
    )
  }
  // Spent, but only says so inside a 200 stream.
  if (token === "Bearer tok-quiet") {
    return reply(
      200,
      SSE,
      'data: {"type":"response.created","response":{"id":"r"}}\n\n' +
        'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"limit"}}}\n\n',
    )
  }
  if (spent) {
    return reply(
      429,
      [],
      JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_at: resetIn(5400) } }),
    )
  }
  // Fails with a passing server error every other request.
  if (token === "Bearer tok-flaky" && count(log, token) % 2 === 1) {
    return reply(503, [], `{"error":{"message":"upstream connect error"}}`)
  }
  if (token === "Bearer tok-down") return reply(502, [], `{"error":{"message":"bad gateway"}}`)
  if (token === "Bearer tok-ok" || token === "Bearer tok-credit" || token === "Bearer tok-flaky") {
    return reply(
      200,
      [
        ["content-type", "text/event-stream"],
        ["x-codex-primary-used-percent", "40"],
        ["x-codex-primary-window-minutes", "10080"],
        ["x-codex-primary-reset-at", String(resetIn(86_400))],
      ],
      'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":7}}}\n\n',
    )
  }
  return reply(401, [], "")
}

const at = (hours: number): string => Timestamp.display(Timestamp.add(Date.now(), SignedDuration.fromHours(hours)))

/**
 * Claude's usage, with its limit resets: two grants for `tok-ok`, the one
 * expiring later named next, listed only to Claude Code, as Claude does.
 */
const mockClaudeResets = (headers: Headers) => {
  const claudeCode = headers.get("user-agent")?.startsWith("claude-cli/") === true
  const status = !claudeCode
    ? { eligible: false, ineligible_reason: "surface", grants: [] }
    : headers.get("authorization") === "Bearer tok-ok"
      ? {
          eligible: true,
          grants: [
            { id: "older", resets_total: 1, resets_left: 1, ends_at: at(30) },
            {
              id: "launch",
              label: "Model launch: one usage-limit reset",
              resets_total: 1,
              resets_left: 1,
              starts_at: at(-24 * 15),
              ends_at: at(24 * 15),
            },
          ],
          next_grant_id: "launch",
        }
      : { eligible: false, ineligible_reason: "no_grant" }
  const usage = { five_hour: { utilization: 25.0, resets_at: at(2) }, cedar_ember: status }
  return reply(200, [], JSON.stringify(usage))
}

/** `tok-expiring` holds a credit that lapses within the hour; every other account's credits last for days. */
const mockCredits = (headers: Headers) => {
  const credits: Array<unknown> = [{ id: "credit-later", status: "available", expires_at: at(48) }]
  if (headers.get("authorization") === "Bearer tok-expiring") {
    credits.push({ id: "credit-soon", status: "available", granted_at: at(-29 * 24), expires_at: at(1) })
    credits.push({ id: "credit-spent", status: "redeemed", expires_at: at(0) })
  }
  return reply(200, [], JSON.stringify({ credits }))
}

/**
 * ChatGPT's WebSocket endpoint: answers each `response.create` by the
 * account's token, as `mockCodex` does over HTTP.
 */
const mockSocket = (log: Log, request: HttpServerRequest.HttpServerRequest, headers: Headers) =>
  Effect.gen(function* () {
    log.push({ path: `ws ${request.url}`, headers, body: new Uint8Array(0) })
    const token = headers.get("authorization") ?? ""
    const socket = yield* server.upgrade().pipe(Effect.orDie)
    for (;;) {
      const message = yield* Effect.orElseSucceed(socket.message, () => undefined)
      if (message === undefined || message._tag !== "Text") break
      log.push({ path: "ws message", headers: new Headers(), body: bytes(message.text) })
      const events: Array<unknown> =
        token === "Bearer tok-limited"
          ? [
              { type: "response.created", response: { id: "r" } },
              {
                type: "error",
                status: 429,
                error: { type: "usage_limit_reached", message: "limit", resets_at: resetIn(5400) },
              },
            ]
          : [
              { type: "response.created", response: { id: "r" } },
              {
                type: "codex.rate_limits",
                rate_limits: { primary: { used_percent: 33, window_minutes: 300, reset_at: resetIn(3600) } },
              },
              { type: "response.output_text.delta", item_id: "m", delta: "Hi" },
              {
                type: "response.completed",
                response: {
                  id: "r",
                  usage: {
                    input_tokens: 50,
                    input_tokens_details: { cached_tokens: 20 },
                    output_tokens: 4,
                    total_tokens: 54,
                  },
                },
              },
            ]
      for (const event of events) {
        const sent = yield* Effect.result(socket.send(ws.Message.text(JSON.stringify(event))))
        if (sent._tag === "Failure") return HttpServerResponse.empty()
      }
    }
    yield* Effect.ignore(socket.send(ws.Message.closeBare))
    return HttpServerResponse.empty()
  })

/** The provider stand-in: records each request, then answers by route and bearer token. */
const mock = recording(
  (log, request, headers) =>
    Effect.sync(() => {
      const path = request.url.split("?")[0] ?? ""
      switch (`${request.method} ${path}`) {
        case "POST /v1/messages":
          return mockClaude(headers)
        case "POST /codex/responses":
          return mockCodex(log, headers)
        case "GET /wham/rate-limit-reset-credits":
          return mockCredits(headers)
        case "GET /wham/usage": {
          const usage = {
            plan_type: "pro",
            rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: resetIn(3600) } },
          }
          return keyed(headers, "Bearer tok-ok", reply(200, [], JSON.stringify(usage)))
        }
        case "POST /wham/rate-limit-reset-credits/consume":
          return reply(200, [], JSON.stringify({ code: "reset" }))
        case "GET /api/oauth/usage":
          return mockClaudeResets(headers)
        case "POST /xai/v1/chat/completions":
          return keyed(headers, "Bearer key-xai", chatAnswer())
        case "POST /local/v1/chat/completions":
          return chatAnswer()
        case "GET /xai/v1/models": {
          const list = { object: "list", data: [{ id: "grok-4" }, { id: "grok-code-fast-1" }] }
          return keyed(headers, "Bearer key-xai", reply(200, [], JSON.stringify(list)))
        }
        case "GET /codex/models": {
          const catalog = {
            models: [
              { slug: "gpt-6-sol", visibility: "list" },
              { slug: "gpt-internal", visibility: "hide" },
            ],
          }
          return keyed(headers, "Bearer tok-ok", reply(200, [], JSON.stringify(catalog)))
        }
        case "POST /openai/v1/responses":
          return keyed(
            headers,
            "Bearer key-openai",
            reply(
              200,
              SSE,
              'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
            ),
          )
        case "POST /kimi/v1/messages":
          return headers.get("x-api-key") === "key-kimi"
            ? reply(200, [], `{"type":"message","content":[],"usage":{"input_tokens":3,"output_tokens":1}}`)
            : reply(401, [], "")
        default:
          if (
            request.method === "POST" &&
            path.startsWith("/api/organizations/") &&
            path.endsWith("/reset_rate_limits")
          ) {
            const reset = { result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] }
            return reply(200, [], JSON.stringify(reset))
          }
          return reply(404, [], "")
      }
    }),
  mockSocket,
)

/** An OAuth account as these tests make them: `name`'s organization too. */
const account = (provider: ProviderId, name: string, token: string, added: number): Account =>
  oauth(provider, name, token, `refresh-${name}`, added, { orgId: `org-${name}` })

const baseConfig = (): Config => ({
  ...Config.default(),
  apiKey: KEY,
  strategy: "fill-first",
  refreshTokens: false,
})

/** A harness whose accounts `build` makes, given the mock's base URL (for compatible endpoints). */
const harnessOf = (
  build: (upstream: string) => ReadonlyArray<Account>,
  configure: (config: Config) => Config = (c) => c,
) =>
  harness({
    prefix: `slopmax-it-${process.pid}`,
    mock,
    accounts: build,
    config: configure(baseConfig()),
    origins: (upstream) => [
      ["https://api.anthropic.com", upstream],
      ["https://chatgpt.com/backend-api", upstream],
      ["https://api.x.ai", `${upstream}/xai`],
      ["https://api.openai.com", `${upstream}/openai`],
    ],
  })

/** Accounts are tried in the order given (fill-first by age). */
const harnessWith = (
  provider: ProviderId,
  tokens: ReadonlyArray<string>,
  configure: (config: Config) => Config = (c) => c,
) => harnessOf(() => tokens.map((token, i) => account(provider, `${provider}${i}`, token, 1000 + i)), configure)

const CLAUDE_BODY = `{"model":"claude-opus-5-5","metadata":{"user_id":"{\\"device_id\\":\\"client-device\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"sess-1\\"}"},"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=cli;"},{"type":"text","text":"You are Claude Code."}],"messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}`

const claudeRequest = (h: Harness) =>
  h.client
    .post(`${h.proxy}/v1/messages?beta=true`)
    .header("authorization", `Bearer ${KEY}`)
    .header("anthropic-beta", "claude-code-20250219,interleaved-thinking-2025-05-14")
    .header("x-claude-code-session-id", "sess-1")
    .header("user-agent", "claude-cli/2.1.287 (external, cli)")
    .header("accept-encoding", "gzip, br")
    .header("content-type", "application/json")
    .body(CLAUDE_BODY)

const codexRequest = (h: Harness) =>
  h.client
    .post(`${h.proxy}/codex/responses`)
    .header("authorization", `Bearer ${KEY}`)
    .header("content-type", "application/json")
    .body(`{"model":"gpt-6-sol","input":[],"stream":true}`)

/** Records a weekly window at `used` percent and two banked reset credits. */
const observeUsage = (h: Harness, id: string, used: number) =>
  Effect.gen(function* () {
    const now = yield* Timestamp.now
    const limits: Limits = {
      windows: [{ span: "7d", used, resetsAt: Timestamp.add(now, SignedDuration.fromHours(72)) }],
      observedAt: now,
      resetCredits: 2,
    }
    yield* h.app.pool.observe(id, limits, now)
  })

/** Records a reading for `id`: `used` percent of a `span` window. */
const observe = (h: Harness, id: string, span: string, used: number) =>
  Effect.gen(function* () {
    const now = yield* Timestamp.now
    const limits: Limits = {
      windows: [{ span, used, resetsAt: Timestamp.add(now, SignedDuration.fromHours(2)) }],
      observedAt: now,
    }
    yield* h.app.pool.observe(id, limits, now)
  })

const id = (h: Harness, i: number): string => h.ids[i] ?? ""

const state = (h: Harness, i: number | string) => h.app.pool.state(typeof i === "string" ? i : id(h, i))

/** A compatible endpoint under the mock at `base/<name>`. */
const endpoint = (
  base: string,
  name: string,
  dialect: Dialect,
  models: ReadonlyArray<string>,
  apiKey: string,
): Account => endpointAt(dialect === "messages" ? `${base}/${name}` : `${base}/${name}/v1`, dialect, models, apiKey)

const chatRequest = (h: Harness, model: string) =>
  h.client
    .post(`${h.proxy}/v1/chat/completions`)
    .header("authorization", `Bearer ${KEY}`)
    .header("user-agent", "OpenAI/Python 2.4.0")
    .header("content-type", "application/json")
    .body(`{"model":"${model}","messages":[{"role":"user","content":"hi"}]}`)

/** The last request the mock saw. */
const last = (h: Harness): Seen => {
  const seen = h.log.at(-1)
  if (seen === undefined) throw new Error("the mock saw nothing")
  return seen
}

/** The bearer token a request carried. */
const token = (s: Seen): string => s.headers.get("authorization") ?? ""

/** A spent ChatGPT account and an OpenAI key that backs it. */
const subscriptionAndKey = (): ReadonlyArray<Account> => [
  account("codex", "chatgpt", "tok-limited", 1000),
  key("openai", "key-openai"),
]

const minutes = (n: number): SignedDuration => SignedDuration.fromMins(n)

/** A WebSocket handshake to the proxy, as Codex sends it. Returns the status and, after a 101, the socket. */
const openSocket = (h: Harness, model: string) =>
  Effect.gen(function* () {
    const response = yield* h.client
      .get(`${h.proxy}/codex/responses`)
      .headers([
        ["upgrade", "websocket"],
        ["connection", "Upgrade"],
        ["sec-websocket-version", "13"],
        ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
        ["authorization", `Bearer ${KEY}`],
        ["user-agent", "codex_exec/0.159.3 (Linux; x86_64)"],
        ["session-id", "ws-session"],
        ["x-codex-routing-hint", `model=${model}`],
      ])
      .timeout("10 seconds")
      .send()
      .pipe(Effect.orDie)
    if (response.status !== 101) return { status: response.status, socket: undefined }
    expect(response.headers.get("sec-websocket-accept")).toBe(ws.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="))
    const upgraded = yield* response.upgrade().pipe(Effect.orDie)
    return {
      status: response.status,
      socket: { reader: new ws.Reader(upgraded), writer: ws.Writer.client(upgraded) },
    }
  })

const CREATE = JSON.stringify({ type: "response.create", model: "gpt-6-sol", input: [], stream: true })

/** A Codex request in `session`. */
const codexIn = (h: Harness, session: string) =>
  h.client
    .post(`${h.proxy}/codex/responses`)
    .header("authorization", `Bearer ${KEY}`)
    .header("session-id", session)
    .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64)")
    .header("content-type", "application/json")
    .body(`{"model":"gpt-6-sol","input":[],"stream":true}`)

/** The Codex requests the mock has seen, leaving out what slopmax asks for itself in the background. */
const responses = (h: Harness): Array<Seen> => h.log.filter((s) => s.path === "/codex/responses")

/** Sends `request` and returns the workspace of the account that answered. */
const servedBy = (h: Harness, request: ReturnType<typeof codexIn>) =>
  Effect.gen(function* () {
    const answer = yield* send(request)
    expect(answer.status).toBe(200)
    return responses(h).at(-1)?.headers.get("chatgpt-account-id") ?? ""
  })

/** One call to slopmax's own API. */
const admin = (h: Harness, method: "GET" | "POST", path: string, form: string) =>
  Effect.gen(function* () {
    const url = `${h.proxy}/slopmax/${path}`
    const request =
      method === "GET"
        ? h.client.get(url)
        : h.client.post(url).header("content-type", "application/x-www-form-urlencoded").body(form)
    const answer = yield* send(request.header("authorization", `Bearer ${KEY}`))
    let body: unknown = null
    try {
      body = JSON.parse(answer.body)
    } catch {
      // Not JSON: null, as the Rust reads it.
    }
    return [answer.status, body] as const
  })

/** The report's entry for account `id`. */
const accountIn = (report: unknown, accountId: string): unknown =>
  (pick(report, "accounts") as Array<unknown>).find((a) => pick(a, "id") === accountId)

describe("tests/proxy", () => {
  it.live("claude_fails_over_and_forwards_the_request_unchanged", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-limited", "tok-ok"])
      const response = yield* send(claudeRequest(h))
      expect(response.status).toBe(200)
      expect(response.body).toContain("message_delta")

      const seen = [...h.log]
      expect(seen.length).toBe(2)
      const served = seen[1] as Seen
      expect(served.path).toBe("/v1/messages?beta=true")
      // Only the credential changes: the account's token and the OAuth beta
      // flag it requires. Everything else arrives as Claude Code sent it.
      expect(served.headers.get("authorization")).toBe("Bearer tok-ok")
      expect(served.headers.get("anthropic-beta")).toBe(
        "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
      )
      expect(served.headers.get("user-agent")).toBe("claude-cli/2.1.287 (external, cli)")
      expect(served.headers.get("accept-encoding")).toBe("gzip, br")
      expect(served.headers.get("x-claude-code-session-id")).toBe("sess-1")
      expect(served.headers.has("x-client-request-id")).toBe(false)
      expect(text(served.body)).toBe(CLAUDE_BODY)

      // The limited account is blocked until its reset; the other is in use.
      const until = (yield* state(h, 0)).blockedUntil ?? 0
      expect(until).toBeGreaterThan(Timestamp.add(Date.now(), minutes(59)))
      yield* eventually(Effect.map(state(h, 1), (s) => s.usage.requests === 1))
      const usage = (yield* state(h, 1)).usage
      expect([usage.inputTokens, usage.cacheReadTokens, usage.outputTokens]).toEqual([10, 90, 25])
      expect((yield* state(h, 1)).limits.windows[0]?.used).toBe(25.0)

      // The answered request is in the usage ledger.
      const since = Timestamp.sub(Date.now(), minutes(1))
      yield* eventually(Effect.map(entries(h, since), (e) => e.length > 0))
      const found = yield* entries(h, since)
      expect(found.length).toBe(1)
      const entry = found[0] as Entry
      expect(entry.account).toBe(id(h, 1))
      expect(entry.model).toBe("claude-opus-5-5")
      expect([entry.input, entry.output, entry.cacheRead]).toEqual([10, 25, 90])
      expect(entry.attempts).toBe(2)
      expect(entry.firstByteMs).toBeDefined()
      expect(entry.agent).toBe("claude")
      expect(entry.session).toBe("sess-1")

      // The session is now pinned to the serving account; no retry on the
      // limited one.
      yield* send(claudeRequest(h))
      expect(h.log.length).toBe(3)
      expect(h.log[2]?.headers.get("authorization")).toBe("Bearer tok-ok")
    }),
  )

  it.live("every_account_spent_returns_the_agents_own_limit_error", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-limited", "tok-limited"])
      const response = yield* send(claudeRequest(h))
      expect(response.status).toBe(429)
      const retryAfter = Number(response.headers.get("retry-after"))
      expect(retryAfter).toBeGreaterThanOrEqual(3500)
      expect(retryAfter).toBeLessThanOrEqual(3600)
      expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
      expect(pick(parse(response.body), "error", "type")).toBe("rate_limit_error")

      // Both are known to be blocked now, so the next request is answered
      // without touching the provider.
      const before = h.log.length
      expect((yield* send(claudeRequest(h))).status).toBe(429)
      expect(h.log.length).toBe(before)

      // The ledger counts both as failures: the first after trying both
      // accounts, the second without trying any.
      yield* eventually(Effect.map(entries(h, 0), (e) => e.length === 2))
      const found = yield* entries(h, 0)
      expect(found.length).toBe(2)
      expect(found.every((e) => e.status === 429 && Entry.tokens(e) === 0)).toBe(true)
      expect(found.every((e) => Entry.failed(e) && !Entry.answered(e))).toBe(true)
      expect(found[0]?.attempts).toBe(2)
      expect(h.ids).toContain(found[0]?.account ?? "")
      expect(found[0]?.agent).toBe("claude")
      expect([found[1]?.attempts, found[1]?.account]).toEqual([0, ""])
    }),
  )

  it.live("codex_fails_over_with_workspace_and_version_headers", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-limited", "tok-ok"])
      const response = yield* send(
        h.client
          .post(`${h.proxy}/codex/responses`)
          .header("authorization", `Bearer ${KEY}`)
          .header("session-id", "codex-session")
          .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64) unknown (codex_exec; 0.159.3)")
          .header("content-type", "application/json")
          .body(`{"model":"gpt-6-sol","input":[],"stream":true,"store":false,"prompt_cache_key":"codex-session"}`),
      )
      expect(response.status).toBe(200)

      expect(h.log.length).toBe(2)
      const served = h.log[1] as Seen
      expect(served.path).toBe("/codex/responses")
      expect(served.headers.get("authorization")).toBe("Bearer tok-ok")
      expect(served.headers.get("chatgpt-account-id")).toBe("acct-codex1")
      expect(served.headers.get("version")).toBe("0.159.3")
      expect(served.headers.get("session-id")).toBe("codex-session")

      const blocked = (yield* state(h, 0)).blockedUntil ?? 0
      expect(blocked).toBeGreaterThan(Timestamp.add(Date.now(), minutes(89)))
      yield* eventually(Effect.map(state(h, 1), (s) => s.usage.requests === 1))
      const usage = (yield* state(h, 1)).usage
      expect([usage.inputTokens, usage.cacheReadTokens, usage.outputTokens]).toEqual([40, 60, 7])
      expect((yield* state(h, 1)).limits.windows[0]?.span).toBe("7d")
    }),
  )

  it.live("codex_exhaustion_uses_usage_limit_shape", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-limited"])
      const response = yield* send(
        h.client
          .post(`${h.proxy}/v1/responses`)
          .header("authorization", `Bearer ${KEY}`)
          .body(`{"model":"gpt-6-sol","input":[]}`),
      )
      expect(response.status).toBe(429)
      const body = parse(response.body)
      expect(pick(body, "error", "type")).toBe("usage_limit_reached")
      expect(Number(pick(body, "error", "resets_at"))).toBeGreaterThan(Timestamp.asSecond(Date.now()))
    }),
  )

  it.live("rejects_requests_without_the_slopmax_key", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-ok"])
      const response = yield* send(h.client.post(`${h.proxy}/v1/messages`).header("x-api-key", "wrong").body("{}"))
      expect(response.status).toBe(401)
      expect(h.log.length).toBe(0)

      // Health and Claude Code's connectivity check need no key.
      expect((yield* send(h.client.get(`${h.proxy}/healthz`))).status).toBe(200)
      expect(yield* statusOf(h.client.request("HEAD", `${h.proxy}/api/hello`))).toBe(200)
    }),
  )

  it.live("revoked_tokens_move_to_the_next_account", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-revoked", "tok-ok"])
      expect((yield* send(claudeRequest(h))).status).toBe(200)
      expect(h.log.length).toBe(2)
      expect(h.log[1]?.headers.get("authorization")).toBe("Bearer tok-ok")
      expect((yield* state(h, 0)).blockedUntil).toBeDefined()
    }),
  )

  it.live("spent_codex_pool_redeems_a_credit_when_allowed", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-credit"], (c) => ({ ...c, redeemWhenExhausted: true }))
      yield* observeUsage(h, id(h, 0), 90.0)
      expect((yield* send(codexRequest(h))).status).toBe(200)

      expect(paths(h)).toEqual(["/codex/responses", "/wham/rate-limit-reset-credits/consume", "/codex/responses"])
      const consume = h.log[1] as Seen
      expect(consume.headers.get("authorization")).toBe("Bearer tok-credit")
      expect(consume.headers.get("chatgpt-account-id")).toBe("acct-codex0")
      expect(typeof pick(parse(consume.body), "redeem_request_id")).toBe("string")

      const after = yield* state(h, 0)
      expect(after.blockedUntil).toBeUndefined()
      expect(after.limits.resetCredits).toBe(1)
    }),
  )

  it.live("spent_codex_pool_keeps_its_credits_by_default", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-credit"])
      yield* observeUsage(h, id(h, 0), 90.0)
      expect((yield* send(codexRequest(h))).status).toBe(429)
      expect(paths(h)).toEqual(["/codex/responses"])
      expect((yield* state(h, 0)).limits.resetCredits).toBe(2)
    }),
  )

  it.live("credits_about_to_expire_are_redeemed_on_used_accounts", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-expiring", "tok-later", "tok-idle"])
      for (const [i, used] of [30.0, 30.0, 0.0].entries()) yield* observeUsage(h, id(h, i), used)
      yield* daemon.redeemExpiring(h.app)

      const listed = h.log
        .filter((s) => s.path === "/wham/rate-limit-reset-credits")
        .map(token)
        .toSorted()
      // An account with nothing to reset is left alone.
      expect(listed).toEqual(["Bearer tok-expiring", "Bearer tok-later"])
      const consumed = h.log.filter((s) => s.path.endsWith("/consume"))
      expect(consumed.length).toBe(1)
      expect(token(consumed[0] as Seen)).toBe("Bearer tok-expiring")
      expect(pick(parse((consumed[0] as Seen).body), "credit_id")).toBe("credit-soon")

      const reset = (yield* state(h, 0)).limits
      expect(reset.resetCredits).toBe(1)
      expect(reset.windows[0]?.used).toBe(0.0)
      expect((yield* state(h, 1)).limits.resetCredits).toBe(2)
    }),
  )

  it.live("claude_limit_resets_are_listed_and_spent_as_claude_code", () =>
    Effect.gen(function* () {
      const ORG = "0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4"
      const AGENT = "claude-cli/2.1.287 (external, cli)"
      const h = yield* harnessOf(() => [oauth("claude", "claude0", "tok-ok", "refresh-claude0", 1000, { orgId: ORG })])
      const listings = (): Array<Seen> => h.log.filter((s) => s.path.startsWith("/api/oauth/usage"))

      // Claude answers Claude Code alone, so nothing is asked before slopmax
      // has seen it.
      yield* daemon.listCredits(h.app, false)
      expect(listings()).toEqual([])
      expect((yield* send(claudeRequest(h))).status).toBe(200)
      expect(yield* h.app.pool.agent("claude")).toBe(AGENT)
      const [saved] = yield* h.app.pool.snapshot(yield* Timestamp.now)
      expect(saved.agents.claude).toBe(AGENT)

      // Listed with the usage, as Claude Code lists them: the next grant first.
      yield* daemon.listCredits(h.app, false)
      const listed = listings()
      expect(listed.length).toBe(1)
      expect(listed[0]?.path).toBe("/api/oauth/usage?cedar_ember=1&skip_spend=1")
      expect(listed[0]?.headers.get("user-agent")).toBe(AGENT)
      expect(listed[0]?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
      const credits = AccountState.unexpiredCredits(yield* state(h, 0), Date.now())
      expect(credits.map((c) => c.id)).toEqual(["launch", "older"])
      expect(credits[0]?.title).toBe("Model launch: one usage-limit reset")
      // Not again within the hour.
      yield* daemon.listCredits(h.app, false)
      expect(listings().length).toBe(1)

      // Redeeming without naming one spends the grant Claude names next.
      const [, redeemedNow] = yield* admin(h, "POST", `accounts/${id(h, 0)}/redeem`, "")
      expect(pick(redeemedNow, "outcome")).toBe("reset")
      const claim = last(h)
      expect(claim.path).toBe(`/api/organizations/${ORG}/reset_rate_limits`)
      expect(claim.headers.get("user-agent")).toBe(AGENT)
      expect(claim.headers.get("authorization")).toBe("Bearer tok-ok")
      const body = parse(claim.body)
      expect(pick(body, "program")).toBe("cedar_ember")
      expect(pick(body, "grant_id")).toBe("launch")
      expect(typeof pick(body, "request_id")).toBe("string")
      const left = AccountState.unexpiredCredits(yield* state(h, 0), Date.now()).map((c) => c.id)
      expect(left).toEqual(["older"])
    }),
  )

  it.live("credits_are_listed_kept_and_redeemed_soonest_first", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-expiring", "tok-ok"])
      yield* observeUsage(h, id(h, 0), 30.0)
      const listings = (): number => paths(h).filter((p) => p === "/wham/rate-limit-reset-credits").length

      // Each credit with its dates, soonest to expire first; an account
      // whose usage counts none is not asked.
      yield* daemon.listCredits(h.app, false)
      expect(listings()).toBe(1)
      const now = Date.now()
      const listed = AccountState.unexpiredCredits(yield* state(h, 0), now)
      expect(listed[0]?.id).toBe("credit-soon")
      expect(listed[1]?.id).toBe("credit-later")
      expect((listed[0]?.grantedAt ?? now) < now).toBe(true)
      // Not again until the list is due.
      yield* daemon.listCredits(h.app, false)
      expect(listings()).toBe(1)

      // Redeeming without naming a credit spends the soonest to expire.
      const [, redeemedNow] = yield* admin(h, "POST", `accounts/${id(h, 0)}/redeem`, "")
      expect(pick(redeemedNow, "outcome")).toBe("reset")
      expect(pick(parse(last(h).body), "credit_id")).toBe("credit-soon")
      const left = pick(
        accountIn(pick(redeemedNow, "report"), id(h, 0)),
        "state",
        "credits",
        "credits",
      ) as Array<unknown>
      expect(left.length).toBe(1)
      expect(pick(left[0], "id")).toBe("credit-later")
    }),
  )

  it.live("websockets_off_or_for_other_models_send_codex_to_http", () =>
    Effect.gen(function* () {
      const off = yield* harnessWith("codex", ["tok-ok"], (c) => ({ ...c, websockets: false }))
      expect((yield* openSocket(off, "gpt-6-sol")).status).toBe(426)
      expect(off.log.length).toBe(0)

      const xai = yield* harnessOf(() => [key("xai", "key-xai")])
      // Translated models stream over HTTP.
      expect((yield* openSocket(xai, "grok-4")).status).toBe(426)
    }),
  )

  it.live("codex_websockets_are_relayed_to_chatgpt", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok"])
      const { status, socket } = yield* openSocket(h, "gpt-6-sol")
      expect(status).toBe(101)
      if (socket === undefined) throw new Error("no socket")
      yield* socket.writer.send(ws.Message.text(CREATE))
      const types: Array<string> = []
      for (;;) {
        const message = yield* socket.reader.message
        if (message?._tag !== "Text") break
        const type = String(pick(parse(message.text), "type"))
        types.push(type)
        if (type === "response.completed") break
      }
      expect(types).toEqual([
        "response.created",
        "codex.rate_limits",
        "response.output_text.delta",
        "response.completed",
      ])
      const upstream = h.log[0] as Seen
      expect(upstream.path).toBe("ws /codex/responses")
      expect(upstream.headers.get("authorization")).toBe("Bearer tok-ok")
      expect(upstream.headers.get("openai-beta")).toBe("responses_websockets=2026-02-06")
      expect(upstream.headers.get("chatgpt-account-id")).toBe("acct-codex0")
      // The upstream handshake has its own key.
      expect(upstream.headers.get("sec-websocket-key")).not.toBe("dGhlIHNhbXBsZSBub25jZQ==")
      // The rate-limit event updated the account's windows, and the turn
      // reached the ledger.
      const served = id(h, 0)
      yield* eventually(
        Effect.map(entries(h, 0), (found) =>
          found.some((e) => e.account === served && e.input === 30 && e.cacheRead === 20 && e.output === 4),
        ),
      )
      expect((yield* state(h, 0)).limits.windows[0]?.used).toBe(33.0)
    }),
  )

  it.live("spent_accounts_close_the_socket_so_codex_reconnects_elsewhere", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-limited", "tok-ok"])
      const first = (yield* openSocket(h, "gpt-6-sol")).socket
      if (first === undefined) throw new Error("no socket")
      yield* first.writer.send(ws.Message.text(CREATE))
      let closed: number | undefined
      for (;;) {
        const message = yield* first.reader.message
        if (message === undefined) break
        if (message._tag === "Close") {
          closed = message.close?.code
          break
        }
      }
      expect(closed).toBe(1012)
      expect(AccountState.isBlocked(yield* state(h, 0), Date.now())).toBe(true)

      // Codex's retry opens a new socket, which lands on the other account.
      const second = (yield* openSocket(h, "gpt-6-sol")).socket
      if (second === undefined) throw new Error("no socket")
      yield* second.writer.send(ws.Message.text(CREATE))
      let completed = false
      for (;;) {
        const message = yield* second.reader.message
        if (message?._tag !== "Text") break
        if (message.text.includes("response.completed")) {
          completed = true
          break
        }
      }
      expect(completed).toBe(true)
      const tokens = h.log.filter((s) => s.path.startsWith("ws /")).map((s) => s.headers.get("authorization"))
      expect(tokens).toEqual(["Bearer tok-limited", "Bearer tok-ok"])
    }),
  )

  it.live("fast_mode_refusals_reach_claude_code_without_benching_accounts", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-fast", "tok-ok"])
      const response = yield* send(claudeRequest(h))
      expect(response.status).toBe(429)
      expect(String(pick(parse(response.body), "error", "message"))).toContain("fast mode")
      // No other account is tried.
      expect(h.log.length).toBe(1)
      const first = yield* state(h, 0)
      expect(first.blockedUntil).toBeUndefined()
      expect(first.throttledUntil).toBeUndefined()
    }),
  )

  it.live("codex_streams_that_open_spent_move_to_the_next_account", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-quiet", "tok-ok"])
      const response = yield* send(codexRequest(h))
      expect(response.status).toBe(200)
      // Served by the next account.
      expect(response.body).toContain("response.completed")
      // The agent never saw the refusal.
      expect(response.body).not.toContain("usage_limit_reached")
      expect((yield* state(h, 0)).blockedUntil).toBeDefined()

      // With every account spent that way, Codex gets its own usage-limit error.
      const alone = yield* harnessWith("codex", ["tok-quiet"])
      const refused = yield* send(codexRequest(alone))
      expect(refused.status).toBe(429)
      expect(pick(parse(refused.body), "error", "type")).toBe("usage_limit_reached")
    }),
  )

  it.live("claude_accounts_serve_claude_code_only", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-ok"])
      const response = yield* send(
        h.client
          .post(`${h.proxy}/v1/messages`)
          .header("authorization", `Bearer ${KEY}`)
          .header("user-agent", "OpenAI/Python 2.4.0")
          .header("content-type", "application/json")
          .body(CLAUDE_BODY),
      )
      expect(response.status).toBe(403)
      const message = String(pick(parse(response.body), "error", "message"))
      expect(message).toContain("Claude Code only")
      expect(message).toContain("OpenAI/Python")
      // Nothing reached Anthropic.
      expect(h.log.length).toBe(0)
    }),
  )

  it.live("chat_clients_reach_keys_and_endpoints_by_model", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf((base) => [
        account("codex", "chatgpt", "tok-ok", 1000),
        key("xai", "key-xai"),
        endpoint(base, "local", "chat", ["qwen3-*"], ""),
      ])

      expect((yield* send(chatRequest(h, "grok-4"))).status).toBe(200)
      let seen = last(h)
      expect(seen.path).toBe("/xai/v1/chat/completions")
      expect(seen.headers.get("authorization")).toBe("Bearer key-xai")
      expect(seen.headers.get("user-agent")).toBe("OpenAI/Python 2.4.0")
      expect(text(seen.body)).toContain(`"model":"grok-4"`)

      expect((yield* send(chatRequest(h, "qwen3-coder"))).status).toBe(200)
      seen = last(h)
      expect(seen.path).toBe("/local/v1/chat/completions")
      // No key, no credential.
      expect(seen.headers.has("authorization")).toBe(false)

      // ChatGPT accounts speak Responses, so a Chat request for a GPT model
      // is translated for them, and the answer back.
      const translated = yield* send(chatRequest(h, "gpt-6-sol"))
      expect(translated.status).toBe(200)
      seen = last(h)
      expect(seen.path).toBe("/codex/responses")
      const sent = parse(seen.body)
      expect(pick(sent, "input", 0, "content", 0, "text")).toBe("hi")
      expect(pick(sent, "store")).toBe(false)
      expect(seen.headers.get("user-agent")?.startsWith("slopmax/")).toBe(true)
      expect(seen.headers.get("authorization")).toBe("Bearer tok-ok")
      const body = parse(translated.body)
      expect(pick(body, "object")).toBe("chat.completion")
      expect(pick(body, "model")).toBe("gpt-6-sol")
      expect(pick(body, "usage", "prompt_tokens")).toBe(100)

      const unknown = yield* send(chatRequest(h, "nope"))
      expect(unknown.status).toBe(404)
      expect(String(pick(parse(unknown.body), "error", "message"))).toContain("nope")

      const xai = id(h, 1)
      yield* eventually(
        Effect.map(entries(h, 0), (found) => found.some((e) => e.account === xai && e.input === 12 && e.output === 3)),
      )
    }),
  )

  it.live("keys_serve_subscription_models_only_as_paid_overflow", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(subscriptionAndKey)
      expect((yield* send(codexRequest(h))).status).toBe(429)
      expect(paths(h).every((p) => !p.startsWith("/openai/"))).toBe(true)

      // Asking for the key by name opts in for one request.
      const named = yield* send(
        h.client
          .post(`${h.proxy}/codex/responses`)
          .header("authorization", `Bearer ${KEY}`)
          .body(`{"model":"openai/gpt-6-sol","input":[],"stream":true}`),
      )
      expect(named.status).toBe(200)
      const seen = last(h)
      expect(seen.path).toBe("/openai/v1/responses")
      expect(seen.headers.get("authorization")).toBe("Bearer key-openai")
      expect(text(seen.body)).toBe(`{"model":"gpt-6-sol","input":[],"stream":true}`)

      const overflow = yield* harnessOf(subscriptionAndKey, (c) => ({ ...c, paidOverflow: true }))
      expect((yield* send(codexRequest(overflow))).status).toBe(200)
      expect(paths(overflow)).toEqual(["/codex/responses", "/openai/v1/responses"])
    }),
  )

  it.live("claude_code_may_use_other_vendors_messages_endpoints", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf((base) => [
        account("claude", "max", "tok-ok", 1000),
        endpoint(base, "kimi", "messages", ["kimi-*"], "key-kimi"),
      ])
      const kimi = yield* send(claudeRequest(h).body(CLAUDE_BODY.replace("claude-opus-5-5", "kimi-k2")))
      expect(kimi.status).toBe(200)
      const seen = last(h)
      expect(seen.path).toBe("/kimi/v1/messages?beta=true")
      expect(seen.headers.get("x-api-key")).toBe("key-kimi")
      expect(seen.headers.has("authorization")).toBe(false)
      // Claude models still go to the Claude account.
      expect((yield* send(claudeRequest(h))).status).toBe(200)
      expect(paths(h).at(-1)).toBe("/v1/messages?beta=true")
    }),
  )

  it.live("claude_code_runs_gpt_models_on_chatgpt_accounts", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(() => [
        account("claude", "max", "tok-ok", 1000),
        account("codex", "chatgpt", "tok-talk", 1001),
      ])
      const turn = (messages: string) =>
        claudeRequest(h).body(
          `{"model":"gpt-6-sol","max_tokens":1000,"stream":true,"system":"You are Claude Code.","messages":${messages},"tools":[{"name":"Bash","description":"Run","input_schema":{"type":"object"}}]}`,
        )
      const response = yield* send(turn(`[{"role":"user","content":"list files"}]`))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const stream = response.body
      for (const expected of [
        `"model":"gpt-6-sol"`,
        `"text":"Hello"`,
        `"type":"tool_use","id":"call_1","name":"Bash"`,
        `"partial_json":"{\\"command\\":\\"ls\\"}"`,
        `"stop_reason":"tool_use"`,
        "message_stop",
      ]) {
        expect(stream).toContain(expected)
      }
      // Opaque reasoning stays with slopmax.
      expect(stream).not.toContain("enc-1")
      let seen = last(h)
      expect(seen.path).toBe("/codex/responses")
      let sent = parse(seen.body)
      expect(pick(sent, "instructions")).toBe("You are Claude Code.")
      // The Claude Code session keys ChatGPT's prompt cache.
      expect(pick(sent, "prompt_cache_key")).toBe("sess-1")

      // The next turn carries the call's result; the reasoning that led to
      // the call goes back to the account that issued it.
      const next = yield* send(
        turn(`[{"role":"user","content":"list files"},
            {"role":"assistant","content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"ls"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"a.rs"}]}]`),
      )
      expect(next.status).toBe(200)
      seen = last(h)
      sent = parse(seen.body)
      const types = (pick(sent, "input") as Array<unknown>).map((i) => pick(i, "type"))
      expect(types).toEqual(["message", "message", "reasoning", "function_call", "function_call_output"])
      expect(pick(sent, "input", 2, "encrypted_content")).toBe("enc-1")
      expect(pick(sent, "input", 4, "output")).toBe("a.rs")

      // Usage lands in the ledger under the ChatGPT account and GPT model.
      const codex = id(h, 1)
      yield* eventually(
        Effect.map(entries(h, 0), (found) =>
          found.some((e) => e.account === codex && e.model === "gpt-6-sol" && e.input === 20),
        ),
      )

      // Claude's own models still go to the Claude account, untranslated.
      expect((yield* send(claudeRequest(h))).status).toBe(200)
      expect(paths(h).at(-1)).toBe("/v1/messages?beta=true")
    }),
  )

  it.live("translated_failures_reach_the_client_in_its_format", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(() => [account("codex", "chatgpt", "tok-limited", 1000)])
      // Every ChatGPT account is spent: Claude Code hears its own limit error.
      const response = yield* send(claudeRequest(h).body(CLAUDE_BODY.replace("claude-opus-5-5", "gpt-6-sol")))
      expect(response.status).toBe(429)
      expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
      const error = parse(response.body)
      expect(pick(error, "type")).toBe("error")
      expect(pick(error, "error", "type")).toBe("rate_limit_error")

      // Counting tokens for a GPT model is estimated locally.
      const counted = yield* send(
        h.client
          .post(`${h.proxy}/v1/messages/count_tokens`)
          .header("authorization", `Bearer ${KEY}`)
          .header("user-agent", "claude-cli/2.1.287 (external, cli)")
          .body(`{"model":"gpt-6-sol","messages":[{"role":"user","content":"hello there"}]}`),
      )
      expect(counted.status).toBe(200)
      expect(Number(pick(parse(counted.body), "input_tokens"))).toBeGreaterThan(0)
    }),
  )

  it.live("openai_clients_list_every_model_they_can_use", () =>
    Effect.gen(function* () {
      const h = yield* harnessOf(
        (base) => [
          account("claude", "max", "tok-ok", 1000),
          account("codex", "chatgpt", "tok-ok", 1001),
          key("xai", "key-xai"),
          endpoint(base, "local", "chat", ["qwen3-*", "llama4"], ""),
        ],
        (c) => ({ ...c, aliases: { ...c.aliases, fast: "gpt-6-sol-mini" } }),
      )
      const list = () => h.client.get(`${h.proxy}/v1/models`).header("authorization", `Bearer ${KEY}`)
      const response = yield* send(list())
      expect(response.status).toBe(200)
      const body = parse(response.body)
      const ids = (pick(body, "data") as Array<unknown>).map((m) => pick(m, "id"))
      expect(ids).toEqual(["fast", "gpt-6-sol", "grok-4", "grok-code-fast-1", "llama4"])
      expect(pick(body, "data", 1, "owned_by")).toBe("codex")
      expect(paths(h).some((p) => p.startsWith("/codex/models?client_version="))).toBe(true)

      // Lists are reused for a while.
      const before = paths(h).length
      yield* send(list())
      expect(paths(h).length).toBe(before)

      // Claude Code still gets Anthropic's own list.
      yield* send(
        h.client
          .get(`${h.proxy}/v1/models?limit=1000`)
          .header("authorization", `Bearer ${KEY}`)
          .header("anthropic-version", "2023-06-01")
          .header("user-agent", "claude-cli/2.1.287 (external, cli)"),
      )
      expect(paths(h).at(-1)).toBe("/v1/models?limit=1000")
    }),
  )

  it.live("the_dashboard_api_reports_acts_and_streams", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok"])
      const call = (method: string, path: string) =>
        h.client.request(method, `${h.proxy}${path}`).header("authorization", `Bearer ${KEY}`)

      // The page itself is public and inert; the data behind it is not.
      const page = yield* send(h.client.get(`${h.proxy}/slopmax/dashboard`))
      expect(page.status).toBe(200)
      expect(page.headers.get("content-security-policy")?.startsWith("default-src 'none'")).toBe(true)
      expect((yield* send(h.client.get(`${h.proxy}/slopmax/status`))).status).toBe(401)

      const [first, second] = [id(h, 0), id(h, 1)]
      const act = (accountId: string, action: string) =>
        Effect.map(send(call("POST", `/slopmax/accounts/${accountId}/${action}`)), (a) => parse(a.body))
      expect(pick(accountIn(yield* act(first, "disable"), first), "disabled")).toBe(true)
      expect(pick(accountIn(yield* act(first, "enable"), first), "disabled")).toBe(false)
      expect(pick(accountIn(yield* act(first, "priority?value=3"), first), "priority")).toBe(3)
      expect(pick(accountIn(yield* act(second, "use"), second), "pinned")).toBe(true)
      // Pins live in this proxy's own home, not the user's.
      expect(existsSync(join(h.dir, "pins.json"))).toBe(true)
      const auto = parse((yield* send(call("POST", "/slopmax/use/auto"))).body)
      expect(pick(accountIn(auto, second), "pinned")).toBe(false)
      expect((yield* send(call("POST", "/slopmax/accounts/codex-nope/disable"))).status).toBe(404)
      expect(pick(accountIn(yield* act(first, "label?value=work%20laptop"), first), "name")).toBe("work laptop")
      expect(pick(accountIn(yield* act(first, "label?value="), first), "name")).not.toBe("work laptop")

      // Removing an account takes its pin with it, as `slopmax remove` does.
      yield* send(call("POST", `/slopmax/accounts/${second}/use`))
      const removed = yield* act(second, "remove")
      expect((pick(removed, "accounts") as Array<unknown>).map((a) => pick(a, "id"))).toEqual([first])
      expect(JSON.parse(readFileSync(join(h.dir, "pins.json"), "utf8"))).toEqual({})

      // A change the CLI or app makes on disk shows as soon as the proxy syncs.
      yield* Store.at(join(h.dir, "accounts"))
        .update(first, (a) => ({ ...a, priority: 7 }))
        .pipe(Effect.orDie)
      const synced = parse((yield* send(call("POST", "/slopmax/sync"))).body)
      expect(pick(accountIn(synced, first), "priority")).toBe(7)

      // The live feed sees each answered request.
      const feed = yield* call("GET", "/slopmax/events").send().pipe(Effect.orDie)
      expect(feed.headers.get("content-type")).toBe("text/event-stream")
      const pull = yield* Stream.toPull(feed.intoBody())
      const firstFrame = yield* pull.pipe(Effect.orDie)
      expect(text(firstFrame[0] ?? new Uint8Array(0)).startsWith(": connected")).toBe(true)
      expect((yield* send(codexRequest(h))).status).toBe(200)
      const event = yield* Effect.gen(function* () {
        for (;;) {
          for (const chunk of yield* pull.pipe(Effect.orDie)) {
            const frame = text(chunk)
            if (frame.startsWith("data: ")) return parse(frame.slice(6).trim())
          }
        }
      }).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      expect(pick(event, "model")).toBe("gpt-6-sol")
      expect(pick(event, "input")).toBe(40)

      yield* eventually(Effect.map(entries(h, 0), (found) => found.length === 1))
      const usage = parse((yield* send(call("GET", "/slopmax/usage?range=today&by=model"))).body)
      expect(pick(usage, "rows", "gpt-6-sol", "requests")).toBe(1)
      expect(pick(usage, "total", "output")).toBe(7)
    }),
  )

  it.live("client_keys_are_held_to_their_models", () =>
    Effect.gen(function* () {
      const laptop: ClientKey = { name: "laptop", key: "sm-laptop", models: ["gpt-6-*"] }
      // An alias that leads outside what the key may use.
      const h = yield* harnessWith("codex", ["tok-ok"], (c) => ({
        ...c,
        keys: [...c.keys, laptop],
        aliases: { ...c.aliases, "gpt-6-cheap": "gpt-5-mini" },
      }))
      const asLaptop = (body: string) =>
        h.client.post(`${h.proxy}/codex/responses`).header("authorization", "Bearer sm-laptop").body(body)
      const withModel = (model: string) => asLaptop(`{"model":"${model}","input":[],"stream":true}`)
      // Routed past the key.
      expect((yield* send(withModel("gpt-6-cheap"))).status).toBe(403)
      expect((yield* send(withModel("gpt-6-sol"))).status).toBe(200)
      const refused = yield* send(withModel("gpt-5-mini"))
      expect(refused.status).toBe(403)
      expect(String(pick(parse(refused.body), "error", "message"))).toContain("laptop")
      // Naming the model twice can't slip another past the check.
      expect(
        (yield* send(asLaptop(`{"model":"gpt-6-sol","model":"gpt-5-mini","input":[],"stream":true}`))).status,
      ).toBe(403)
      // Listing the models is fine: it spends nothing.
      const listed = yield* send(
        h.client.get(`${h.proxy}/codex/models?client_version=0.165.0`).header("authorization", "Bearer sm-laptop"),
      )
      expect(listed.status).toBe(200)
      // A body slopmax cannot read could name any model, so it is refused.
      const packed = yield* send(asLaptop("(compressed)").header("content-encoding", "zstd"))
      expect(packed.status).toBe(403)
      // A socket would carry requests for any model: Codex is sent to HTTP,
      // where each is checked.
      const socket = yield* send(
        h.client
          .get(`${h.proxy}/codex/responses`)
          .header("authorization", "Bearer sm-laptop")
          .header("upgrade", "websocket")
          .header("connection", "Upgrade")
          .header("sec-websocket-version", "13")
          .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
          .header("x-codex-routing-hint", "model=gpt-6-sol"),
      )
      expect(socket.status).toBe(426)
      expect(paths(h).some((p) => p.startsWith("ws "))).toBe(false)
      // Client keys never reach slopmax's own API.
      const own = yield* send(h.client.get(`${h.proxy}/slopmax/status`).header("authorization", "Bearer sm-laptop"))
      expect(own.status).toBe(401)
    }),
  )

  it.live("idle_chatgpt_windows_are_warmed_once", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok"])
      // Warmups use the model Codex last asked for; there is none yet.
      yield* warm.idleAccounts(h.app)
      expect(paths(h)).toEqual([])

      yield* send(codexRequest(h))
      // The model reaches the app when the answer's ledger entry does.
      yield* eventually(Effect.sync(() => h.app.lastCodexModel() !== undefined))
      const now = yield* Timestamp.now
      const reset: Window = { span: "5h", used: 64.0, resetsAt: Timestamp.sub(now, minutes(1)) }
      yield* h.app.pool.observe(id(h, 0), { windows: [reset], observedAt: now }, now)

      yield* warm.idleAccounts(h.app)
      const warmups = h.log.slice(1).map((s) => parse(s.body))
      expect(warmups.length).toBe(1)
      expect(pick(warmups[0], "model")).toBe("gpt-6-sol")
      expect(pick(warmups[0], "instructions")).toBe("Reply with OK.")
      // Once per window.
      yield* warm.idleAccounts(h.app)
      expect(paths(h).length).toBe(2)
    }),
  )

  it.live("agents_see_the_pool_not_the_serving_account", () =>
    Effect.gen(function* () {
      // Codex: the serving account reports 40% of its week; the other has
      // used 10%, so the pool has used 25%.
      const codex = yield* harnessWith("codex", ["tok-ok", "tok-ok"])
      yield* observe(codex, id(codex, 1), "7d", 10.0)
      const response = yield* send(codexRequest(codex))
      expect(response.status).toBe(200)
      expect(response.headers.get("x-codex-primary-used-percent")).toBe("25.0")
      expect(response.headers.get("x-codex-primary-window-minutes")).toBe("10080")

      // Claude: 25% here and 75% on the other account read as 50%.
      const claude = yield* harnessWith("claude", ["tok-ok", "tok-ok"])
      yield* observe(claude, id(claude, 1), "5h", 75.0)
      const answer = yield* send(claudeRequest(claude))
      expect(answer.status).toBe(200)
      expect(answer.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.50")
      expect(answer.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed")
      expect(answer.headers.has("anthropic-ratelimit-unified-representative-claim")).toBe(false)
    }),
  )

  it.live("codex_sockets_report_the_pool_too", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok"])
      yield* observe(h, id(h, 1), "5h", 0.0)
      const socket = (yield* openSocket(h, "gpt-6-sol")).socket
      if (socket === undefined) throw new Error("no socket")
      yield* socket.writer.send(ws.Message.text(CREATE))
      let seen: unknown
      for (;;) {
        const message = yield* socket.reader.message
        if (message?._tag !== "Text") break
        const event = parse(message.text)
        if (pick(event, "type") === "codex.rate_limits") seen = event
        if (message.text.includes("response.completed")) break
      }
      // The serving account sent 33% of its 5-hour window; the other is idle.
      expect(pick(seen, "rate_limits", "primary", "used_percent")).toBe(16.5)
      expect(pick(seen, "rate_limits", "primary", "window_minutes")).toBe(300)
      expect(pick(seen, "rate_limits", "limit_reached")).toBe(false)
    }),
  )

  it.live("hub_clients_read_usage_and_redeem_credits_without_a_relay", () =>
    Effect.gen(function* () {
      const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage"
      const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage"
      const CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
      const CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"

      const h = yield* harnessOf(() => [
        account("claude", "claude0", "tok-ok", 1000),
        account("codex", "codex0", "tok-ok", 1001),
      ])
      const [claude, codex] = [id(h, 0), id(h, 1)]
      const management = (path: string) =>
        h.client.post(`${h.proxy}/v0/management/${path}`).header("authorization", `Bearer ${KEY}`)
      /** One `api-call` as T3 Code sends it to a CLIProxyAPI hub: the status the provider answered with, and its body. */
      const apiCall = (authIndex: string, method: string, url: string, data?: unknown) =>
        Effect.gen(function* () {
          const call: Record<string, unknown> = {
            auth_index: authIndex,
            method,
            url,
            header: { Authorization: "Bearer $TOKEN$" },
          }
          if (data !== undefined) call.data = JSON.stringify(data)
          const answer = yield* send(management("api-call").json(call))
          expect(answer.status).toBe(200)
          const relayed = parse(answer.body)
          return [Number(pick(relayed, "status_code")), parse(String(pick(relayed, "body")))] as const
        })

      // The management key is slopmax's own, as a bearer token or in
      // CLIProxyAPI's header.
      const files = (name: string, value: string) =>
        send(h.client.get(`${h.proxy}/v0/management/auth-files`).header(name, value))
      expect((yield* files("authorization", "Bearer wrong")).status).toBe(401)
      expect((yield* files("x-management-key", KEY)).status).toBe(200)
      const listed = parse((yield* files("authorization", `Bearer ${KEY}`)).body)
      const file = (accountId: string) =>
        (pick(listed, "files") as Array<unknown>).find((f) => pick(f, "auth_index") === accountId)
      expect(pick(file(claude), "provider")).toBe("claude")
      expect(pick(file(claude), "email")).toBe("claude0@example.com")
      expect(pick(file(codex), "provider")).toBe("codex")
      expect(pick(file(codex), "disabled")).toBe(false)
      expect(pick(file(codex), "id_token", "chatgpt_account_id")).toBe("acct-codex0")
      // T3 rejects a null where it reads a string, so unknowns are left out.
      expect(pick(file(codex), "id_token", "chatgpt_plan_type")).toBeUndefined()

      // Usage comes from slopmax's own readings, so there is none before one.
      expect((yield* apiCall(claude, "GET", CLAUDE_USAGE))[0]).toBe(503)
      const now = yield* Timestamp.now
      const resets = Timestamp.add(now, SignedDuration.fromHours(2))
      yield* h.app.pool.observe(
        claude,
        {
          windows: [
            { span: "5h", used: 30.0, resetsAt: resets },
            { span: "7d", model: "Fable", used: 58.0, resetsAt: resets },
          ],
          observedAt: now,
        },
        now,
      )
      const [claudeStatus, claudeUsage] = yield* apiCall(claude, "GET", CLAUDE_USAGE)
      expect(claudeStatus).toBe(200)
      expect(pick(claudeUsage, "five_hour", "utilization")).toBe(30.0)
      expect(pick(claudeUsage, "five_hour", "resets_at")).toBe(Timestamp.display(resets))
      expect(pick(claudeUsage, "seven_day")).toBeNull()
      expect(pick(claudeUsage, "limits", 0, "kind")).toBe("weekly_scoped")
      expect(pick(claudeUsage, "limits", 0, "percent")).toBe(58.0)
      expect(pick(claudeUsage, "limits", 0, "scope", "model", "display_name")).toBe("Fable")

      yield* observe(h, codex, "5h", 40.0)
      const [codexStatus, codexUsage] = yield* apiCall(codex, "GET", CODEX_USAGE)
      expect(codexStatus).toBe(200)
      expect(pick(codexUsage, "rate_limit", "primary_window", "used_percent")).toBe(40.0)
      expect(pick(codexUsage, "rate_limit", "primary_window", "limit_window_seconds")).toBe(18_000)
      expect(Number.isInteger(pick(codexUsage, "rate_limit", "primary_window", "reset_at"))).toBe(true)
      expect(pick(codexUsage, "rate_limit", "secondary_window")).toBeNull()
      // Usage reads stay inside slopmax.
      expect(paths(h)).toEqual([])

      // Reset credits are listed by ChatGPT, then reused for a few minutes,
      // since tools ask on every refresh.
      const [listStatus, list] = yield* apiCall(codex, "GET", CREDITS)
      expect(listStatus).toBe(200)
      expect(pick(list, "credits", 0, "id")).toBe("credit-later")
      expect(pick(list, "credits", 0, "status")).toBe("available")
      expect(pick(list, "credits", 0, "reset_type")).toBe("codex_rate_limits")
      expect(typeof pick(list, "credits", 0, "expires_at")).toBe("string")
      yield* apiCall(codex, "GET", CREDITS)
      expect(paths(h)).toEqual(["/wham/rate-limit-reset-credits"])

      const data = { redeem_request_id: "0b1c2d3e-0000-5000-8000-000000000000", credit_id: "credit-later" }
      const [consumeStatus, consumed] = yield* apiCall(codex, "POST", CONSUME, data)
      expect(consumeStatus).toBe(200)
      expect(pick(consumed, "code")).toBe("reset")
      const sent = last(h)
      expect(sent.path).toBe("/wham/rate-limit-reset-credits/consume")
      expect(pick(parse(sent.body), "credit_id")).toBe("credit-later")

      // reset-quota lifts slopmax's blocks and reads the usage again.
      yield* h.app.pool.block(codex, Timestamp.add(Date.now(), SignedDuration.fromHours(1)), undefined, "spent")
      const reset = parse((yield* send(management("reset-quota").json({ auth_index: codex }))).body)
      expect(pick(reset, "status")).toBe("ok")
      expect(pick(reset, "auth_index")).toBe(codex)
      expect((yield* state(h, codex)).blockedUntil).toBeUndefined()
      yield* eventually(Effect.map(state(h, codex), (s) => s.limits.windows.some((w) => w.used === 5.0)))

      // Nothing else goes out with an account's token.
      for (const [index, url] of [
        [codex, "https://example.com/collect"],
        [codex, CLAUDE_USAGE],
        [claude, CODEX_USAGE],
        [claude, "https://api.anthropic.com/v1/messages"],
      ] as const) {
        const call = { auth_index: index, method: "GET", url, header: { Authorization: "Bearer $TOKEN$" } }
        expect((yield* send(management("api-call").json(call))).status).toBe(403)
      }
      const unknown = yield* send(
        management("api-call").json({ auth_index: "codex-nope", method: "GET", url: CODEX_USAGE }),
      )
      expect(unknown.status).toBe(400)
      expect(paths(h).every((p) => p.startsWith("/wham/"))).toBe(true)

      // slopmax's own status carries the same pool view in one call.
      const report = parse(
        (yield* send(h.client.get(`${h.proxy}/slopmax/status`).header("authorization", `Bearer ${KEY}`))).body,
      )
      const pool = (provider: string) =>
        (pick(report, "pools") as Array<unknown>).find((p) => pick(p, "provider") === provider)
      expect(pick(pool("claude"), "accounts")).toBe(1)
      expect(pick(pool("claude"), "windows", 0, "span")).toBe("5h")
      expect(pick(pool("claude"), "windows", 0, "used")).toBe(30.0)
      expect(pick(pool("codex"), "accounts")).toBe(1)
    }),
  )

  it.live("sessions_keep_their_account_so_the_prompt_cache_stays_warm", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok", "tok-ok"], (c) => ({ ...c, strategy: "round-robin" }))
      // New sessions take turns; each then keeps its account.
      const a = yield* servedBy(h, codexIn(h, "a"))
      const b = yield* servedBy(h, codexIn(h, "b"))
      const c = yield* servedBy(h, codexIn(h, "c"))
      expect([a, b, c]).toEqual(["acct-codex0", "acct-codex1", "acct-codex2"])
      for (let i = 0; i < 3; i++) {
        expect(yield* servedBy(h, codexIn(h, "b"))).toBe("acct-codex1")
        expect(yield* servedBy(h, codexIn(h, "a"))).toBe("acct-codex0")
      }
      // A fourth session goes to the account handed a request longest ago.
      expect(yield* servedBy(h, codexIn(h, "d"))).toBe("acct-codex2")

      // Once its account is limited the session moves, and it stays on its
      // new account after the old one recovers, rather than lose its cache
      // a second time.
      yield* h.app.pool.block(id(h, 1), Timestamp.add(Date.now(), minutes(5)), undefined, "usage limit reached")
      const moved = yield* servedBy(h, codexIn(h, "b"))
      expect(moved).not.toBe("acct-codex1")
      yield* h.app.pool.clearBlocks(id(h, 1))
      for (let i = 0; i < 3; i++) expect(yield* servedBy(h, codexIn(h, "b"))).toBe(moved)
    }),
  )

  it.live("affinity_can_be_turned_off_for_the_proxy_or_one_request", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok"], (c) => ({
        ...c,
        strategy: "round-robin",
        sessionAffinity: false,
      }))
      // Off in the config: one session's requests take turns.
      const turns: Array<string> = []
      for (let i = 0; i < 4; i++) turns.push(yield* servedBy(h, codexIn(h, "s")))
      expect(turns).toEqual(["acct-codex0", "acct-codex1", "acct-codex0", "acct-codex1"])
      // A request may ask to keep its session's account anyway.
      const sticky = () => codexIn(h, "s").header("x-slopmax-affinity", "on")
      const first = yield* servedBy(h, sticky())
      expect(yield* servedBy(h, sticky())).toBe(first)
      expect(yield* servedBy(h, sticky())).toBe(first)

      // On in the config, a request may still opt out.
      yield* h.app.setConfig({ ...(yield* h.app.config), sessionAffinity: true })
      const kept = yield* servedBy(h, codexIn(h, "t"))
      expect(yield* servedBy(h, codexIn(h, "t"))).toBe(kept)
      const loose = () => codexIn(h, "t").header("x-slopmax-affinity", "off")
      const spread = [yield* servedBy(h, loose()), yield* servedBy(h, loose())]
      // Placed afresh each time.
      expect(spread[0]).not.toBe(spread[1])

      // slopmax's own headers never reach the provider.
      expect(responses(h).every((s) => !s.headers.has("x-slopmax-affinity"))).toBe(true)
    }),
  )

  it.live("moving_without_affinity_still_drops_another_accounts_state", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok"], (c) => ({
        ...c,
        strategy: "round-robin",
        sessionAffinity: false,
      }))
      const body = `{"model":"gpt-6-sol","previous_response_id":"resp-1","input":[],"stream":true}`
      yield* servedBy(h, codexIn(h, "s").body(body))
      yield* servedBy(h, codexIn(h, "s").body(body))
      const seen = responses(h)
      // The first request had no account before it, so went as sent; the
      // second landed on another account, so lost what the first minted.
      expect(text((seen[0] as Seen).body)).toContain("previous_response_id")
      expect(text((seen[1] as Seen).body)).not.toContain("previous_response_id")
    }),
  )

  it.live("passing_server_errors_are_retried_once_on_the_same_account", () =>
    Effect.gen(function* () {
      const flaky = yield* harnessWith("codex", ["tok-flaky", "tok-ok"])
      // The first try fails with a 503; the second, on the same account,
      // answers. The session's account never changes.
      expect(yield* servedBy(flaky, codexIn(flaky, "s"))).toBe("acct-codex0")
      expect(responses(flaky).map((s) => s.headers.get("authorization"))).toEqual([
        "Bearer tok-flaky",
        "Bearer tok-flaky",
      ])
      expect((yield* state(flaky, 0)).blockedUntil).toBeUndefined()

      // An error that persists moves the request to the next account,
      // which is not set aside for it.
      const down = yield* harnessWith("codex", ["tok-down", "tok-ok"])
      expect(yield* servedBy(down, codexIn(down, "s"))).toBe("acct-codex1")
      // Twice on the first, once on the next.
      expect(responses(down).length).toBe(3)
      expect(AccountState.isBlocked(yield* state(down, 0), Date.now())).toBe(false)
      expect((yield* state(down, 0)).throttledUntil).toBeUndefined()

      // When every account answers so, the client gets the error.
      const both = yield* harnessWith("codex", ["tok-down", "tok-down"])
      const response = yield* send(codexIn(both, "s"))
      expect(response.status).toBe(502)
      expect(response.body).toContain("bad gateway")
      expect(responses(both).length).toBe(4)
    }),
  )

  it.live("settings_change_through_the_api_and_apply_at_once", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok", "tok-ok"])
      const file = join(h.dir, "config.toml")
      writeFileSync(file, `# mine\napi_key = "sm-test-key"\nrefresh_tokens = false\nstrategy = "fill-first" # keep\n`)

      let [status, settings] = yield* admin(h, "GET", "settings", "")
      expect(status).toBe(200)
      expect(pick(settings, "strategy")).toBe("fill-first")
      expect(pick(settings, "session_affinity")).toBe(true)
      expect((pick(settings, "strategies") as Array<unknown>).map((s) => pick(s, "id"))).toEqual([
        "reset-first",
        "fill-first",
        "least-used",
        "round-robin",
      ])

      ;[status, settings] = yield* admin(
        h,
        "POST",
        "settings",
        "strategy=round-robin&session_affinity=false&redeem_when_exhausted=true",
      )
      expect(status).toBe(200)
      expect(pick(settings, "strategy")).toBe("round-robin")
      expect(pick(settings, "session_affinity")).toBe(false)
      // Applied to the next request, without a restart.
      const routing = yield* h.app.pool.routing
      expect(routing.strategy).toBe("round-robin")
      expect(routing.affinity).toBe(false)
      expect((yield* h.app.config).redeemWhenExhausted).toBe(true)
      const first = yield* servedBy(h, codexIn(h, "s"))
      expect(yield* servedBy(h, codexIn(h, "s"))).not.toBe(first)
      // Written to config.toml, comments kept.
      const written = readFileSync(file, "utf8")
      expect(written.startsWith("# mine\n")).toBe(true)
      expect(written).toContain(`strategy = "round-robin" # keep`)
      expect(written).toContain("session_affinity = false")

      // Nonsense is refused and changes nothing.
      for (const bad of ["strategy=fastest", "session_affinity=maybe", "listen=0.0.0.0:1", "session_ttl_mins=-5", ""]) {
        expect((yield* admin(h, "POST", "settings", bad))[0]).toBe(400)
      }
      expect(readFileSync(file, "utf8")).toBe(written)
      expect((yield* h.app.pool.routing).strategy).toBe("round-robin")

      ;[status, settings] = yield* admin(h, "POST", "settings?session_ttl_mins=15", "")
      expect([status, pick(settings, "session_ttl_mins")]).toEqual([200, 15])
      expect((yield* h.app.pool.routing).sessionTtl).toBe(minutes(15))
    }),
  )

  it.live("a_changed_config_file_applies_without_a_restart", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok"])
      const file = join(h.dir, "config.toml")
      writeFileSync(
        file,
        `api_key = "sm-other"\nrefresh_tokens = false\nstrategy = "least-used"\nsession_affinity = false\nlisten = "0.0.0.0:1"\n`,
      )
      yield* h.app.reloadConfig
      const config = yield* h.app.config
      expect(config.strategy).toBe("least-used")
      expect((yield* h.app.pool.routing).affinity).toBe(false)
      // A new key applies too.
      expect(config.apiKey).toBe("sm-other")
      // The address is bound at start.
      expect(config.listen.port).not.toBe(1)

      // A broken file leaves the last good config in place.
      writeFileSync(file, `strategy = "warp-speed"\n`)
      yield* h.app.reloadConfig
      expect((yield* h.app.config).strategy).toBe("least-used")
    }),
  )

  it.live("the_history_api_charts_what_went_through", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-limited", "tok-ok"])
      yield* servedBy(h, codexIn(h, "s"))
      yield* servedBy(h, codexIn(h, "s"))
      // Both answers reach the ledger before it is read.
      const since = Timestamp.sub(Date.now(), minutes(1))
      yield* eventually(Effect.map(entries(h, since), (found) => found.length === 2))

      const [status, history] = yield* admin(h, "GET", "history?range=today", "")
      expect(status).toBe(200)
      expect(pick(history, "range")).toBe("today")
      expect(pick(history, "total", "requests")).toBe(2)
      // The first answer needed failover.
      expect(pick(history, "rescued")).toBe(1)
      // An hour each, from midnight to now.
      expect((pick(history, "buckets") as Array<unknown>).length).toBeGreaterThan(0)
      const accounts = pick(history, "accounts") as Array<unknown>
      expect(accounts.length).toBe(1)
      expect(pick(accounts[0], "name")).toBe("codex1@example.com")
      expect(pick(accounts[0], "totals", "requests")).toBe(2)
      // GPT-6 Sol has a list price: 2 answers of 40 fresh, 60 cached, 7 out.
      const cost = Number(pick(history, "total", "cost"))
      const expected = (2.0 * (40.0 * 2.0 + 60.0 * 0.2 + 7.0 * 10.0)) / 1e6
      expect(Math.abs(cost - expected)).toBeLessThan(1e-9)

      expect((yield* admin(h, "GET", "history?range=forever", ""))[0]).toBe(400)
    }),
  )

  it.live("history_says_what_resets_left_on_the_table", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok"])
      const ended = Timestamp.sub(Date.now(), SignedDuration.fromHours(1))
      const record = (span: string, used: number): waste.Record => ({
        endedAt: ended,
        account: id(h, 0),
        provider: "codex",
        plan: "pro",
        span,
        used,
      })
      yield* waste.append(join(h.dir, "windows.jsonl"), [record("7d", 25.0), record("5h", 0.0)]).pipe(Effect.orDie)

      const [status, history] = yield* admin(h, "GET", "history?range=7d", "")
      expect(status).toBe(200)
      // The weeks alone.
      expect(pick(history, "left", "windows")).toBe(1)
      expect(pick(history, "left", "unused")).toBe(75.0)
      // ChatGPT Pro at $200 a month: three quarters of a week's share.
      const dollars = Number(pick(history, "left", "dollars"))
      expect(Math.abs(dollars - ((200.0 * 12.0) / 52.0) * 0.75)).toBeLessThan(1e-6)
      expect(pick(history, "left", "accounts", 0, "name")).toBe("codex0@example.com")
    }),
  )

  it.live("the_api_does_what_the_cli_does_for_keys_endpoints_and_the_doctor", () =>
    Effect.gen(function* () {
      let base = ""
      const h = yield* harnessOf((url) => {
        base = url
        return [account("codex", "codex0", "tok-ok", 1000)]
      })
      writeFileSync(join(h.dir, "config.toml"), `api_key = "${KEY}"\nrefresh_tokens = false\n`)

      // A key for another machine, held to some models: shown once, then
      // listed by name, and it works at once.
      const [status, made] = yield* admin(h, "POST", "keys", "name=laptop&models=gpt-6-*")
      expect(status).toBe(200)
      const madeKey = String(pick(made, "key"))
      expect(madeKey.startsWith("sm-")).toBe(true)
      const [, listed] = yield* admin(h, "GET", "keys", "")
      expect(pick(listed, "keys", 0, "name")).toBe("laptop")
      expect(pick(listed, "keys", 0, "models", 0)).toBe("gpt-6-*")
      expect(pick(listed, "key") === undefined && pick(listed, "keys", 0, "key") === undefined).toBe(true)
      const used = yield* send(
        h.client
          .post(`${h.proxy}/codex/responses`)
          .header("authorization", `Bearer ${madeKey}`)
          .body(`{"model":"gpt-6-sol","input":[],"stream":true}`),
      )
      expect(used.status).toBe(200)
      // Names are unique.
      expect((yield* admin(h, "POST", "keys", "name=laptop"))[0]).toBe(400)
      const [removedStatus, afterRemove] = yield* admin(h, "POST", "keys/laptop/remove", "")
      expect(removedStatus).toBe(200)
      expect((pick(afterRemove, "keys") as Array<unknown>).length).toBe(0)
      expect((yield* admin(h, "POST", "keys/laptop/remove", ""))[0]).toBe(404)
      // A name with spaces or slashes is revoked by its encoded name.
      expect((yield* admin(h, "POST", "keys", "name=work%20laptop%2F2"))[0]).toBe(200)
      expect((yield* admin(h, "POST", "keys/work%20laptop%2F2/remove", ""))[0]).toBe(200)

      // A compatible endpoint, as `slopmax login compat --url` adds it.
      const [addedStatus, report] = yield* admin(
        h,
        "POST",
        "accounts",
        `provider=compat&url=${base}/local/v1&models=qwen3-*&label=box`,
      )
      expect(addedStatus).toBe(200)
      const added = (pick(report, "accounts") as Array<unknown>).find((a) => pick(a, "provider") === "compat")
      expect(pick(added, "name")).toBe("box")
      expect((yield* send(chatRequest(h, "qwen3-coder"))).status).toBe(200)
      // Subscriptions sign in with a browser, not through the API.
      const [refusedStatus, refused] = yield* admin(h, "POST", "accounts", "provider=claude")
      expect(refusedStatus).toBe(400)
      expect(String(pick(refused, "error", "message"))).toContain("browser")
      // An endpoint needs its url.
      expect((yield* admin(h, "POST", "accounts", "provider=compat"))[0]).toBe(400)

      // An imported account can be made to refresh here.
      yield* h.app.store
        .update(id(h, 0), (a) => ({ ...a, link: { tool: "CLIProxyAPI", path: join(h.dir, "elsewhere.json") } }))
        .pipe(Effect.orDie)
      expect((yield* admin(h, "POST", `accounts/${id(h, 0)}/own`, ""))[0]).toBe(200)
      expect((yield* h.app.store.get(id(h, 0)).pipe(Effect.orDie))?.link).toBeUndefined()

      // The doctor's findings, as `slopmax doctor` prints them.
      const [doctorStatus, sections] = yield* admin(h, "GET", "doctor", "")
      expect(doctorStatus).toBe(200)
      const titles = (sections as Array<unknown>).map((s) => pick(s, "title"))
      expect(titles).toContain("Accounts")
      expect(typeof pick(sections, 0, "findings", 0, "level")).toBe("string")
    }),
  )
})

describe("tests/proxy, beyond the Rust tests", () => {
  it.live("health, HEAD probes, and unknown paths are answered before the key is asked for", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("claude", ["tok-ok"])
      const health = yield* send(h.client.get(`${h.proxy}/healthz`))
      expect(health.headers.get("content-type")).toBe("application/json")
      expect(parse(health.body)).toEqual({ status: "ok", service: "slopmax", version: VERSION })
      // HEAD is answered before slopmax's own API, so no key is needed.
      expect(yield* statusOf(h.client.request("HEAD", `${h.proxy}/slopmax/status`))).toBe(200)
      const unknown = yield* send(h.client.get(`${h.proxy}/other`))
      expect(unknown.status).toBe(404)
      expect(parse(unknown.body)).toEqual({
        type: "error",
        error: {
          type: "not_found_error",
          message: "unknown path; slopmax serves /v1/*, /claude/*, and /codex/*",
        },
      })
      const keyless = yield* send(h.client.post(`${h.proxy}/v1/chat/completions`).body("{}"))
      expect(keyless.status).toBe(401)
      expect(pick(parse(keyless.body), "error", "message")).toBe("missing or invalid slopmax key; see `slopmax env`")
      expect(h.log.length).toBe(0)
    }),
  )

  it.live("a handshake without a key or with another version is turned away", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith("codex", ["tok-ok"])
      const handshake = (headers: ReadonlyArray<readonly [string, string]>) =>
        send(
          h.client
            .get(`${h.proxy}/codex/responses`)
            .headers([
              ["authorization", `Bearer ${KEY}`],
              ["upgrade", "websocket"],
              ["connection", "Upgrade"],
              ...headers,
            ]),
        )
      const keyless = yield* handshake([["sec-websocket-version", "13"]])
      expect(keyless.status).toBe(400)
      expect(pick(parse(keyless.body), "error", "message")).toBe("missing Sec-WebSocket-Key")
      const old = yield* handshake([
        ["sec-websocket-version", "8"],
        ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
      ])
      expect(old.status).toBe(426)
      expect(old.headers.get("sec-websocket-version")).toBe("13")
      expect(pick(parse(old.body), "error", "message")).toBe("slopmax relays this over HTTP streaming")
      expect(h.log.length).toBe(0)
    }),
  )
})
