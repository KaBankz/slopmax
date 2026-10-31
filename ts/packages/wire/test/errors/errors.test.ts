import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Schema } from "effect"
import { type ErrorBody, errorBody, errorMessage, failureKind, limitReached, retell } from "../../src/index.ts"
// The bodies' shapes are checked against the schemas that document them.
import { MessagesError, OpenAiError } from "../../src/errors.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

const messageOf = (body: ErrorBody): string => body.error.message

describe("failureKind", () => {
  it("names each status's kind of error the way every format does", () => {
    const kinds = [400, 401, 403, 404, 413, 429, 503, 529, 500, 502, 418].map(failureKind)
    expect(kinds).toEqual([
      "invalid_request_error",
      "authentication_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "rate_limit_error",
      "overloaded_error",
      "overloaded_error",
      "api_error",
      "api_error",
      "api_error",
    ])
  })
})

describe("errorBody", () => {
  it("names errors in each format's own way", () => {
    const messages = errorBody("messages", "rate_limit_error", "slow")
    expect(messages).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow" } })
    expect(Schema.is(MessagesError)(messages)).toBe(true)
    for (const dialect of ["responses", "chat"] as const) {
      const body = errorBody(dialect, "rate_limit_error", "slow")
      expect(body).toEqual({ error: { type: "rate_limit_error", message: "slow" } })
      expect(Schema.is(OpenAiError)(body)).toBe(true)
    }
  })
})

describe("limitReached", () => {
  const now = at(1_000)
  const until = at(4_600)

  it("answers Claude Code with a rejected unified limit and its reset in headers", () => {
    const reply = limitReached("messages", "all spent", until, now)
    expect(reply.status).toBe(429)
    expect(reply.body).toEqual({ type: "error", error: { type: "rate_limit_error", message: "all spent" } })
    expect(reply.headers).toEqual({
      "retry-after": "3600",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "4600",
    })
  })

  it("answers Codex with its usage-limit error and when it resets", () => {
    const reply = limitReached("responses", "all spent", until, now)
    expect(reply.body).toEqual({
      error: { type: "usage_limit_reached", message: "all spent", resets_at: 4600, resets_in_seconds: 3600 },
    })
    expect(reply.headers).toEqual({ "retry-after": "3600" })
  })

  it("answers OpenAI-style clients with rate_limit_exceeded and nothing but retry-after", () => {
    const reply = limitReached("chat", "all spent", until, now)
    expect(reply.body).toEqual({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "all spent" },
    })
    expect(reply.headers).toEqual({ "retry-after": "3600" })
  })

  it("tells clients to wait at least a second, even for a reset that already passed", () => {
    expect(limitReached("responses", "soon", at(1_000), at(1_000)).body.error).toMatchObject({ resets_in_seconds: 1 })
    expect(limitReached("chat", "soon", DateTime.makeUnsafe(1_000_400), at(1_000)).headers["retry-after"]).toBe("1")
    expect(limitReached("messages", "late", at(900), at(1_000)).headers["retry-after"]).toBe("1")
  })
})

describe("retell", () => {
  it("keeps an upstream error's status and finds its message wherever the provider put it", () => {
    const bodies = [
      '{"error":{"message":"from error.message"}}',
      '{"response":{"error":{"message":"from response.error"}}}',
      '{"error":"a bare error string"}',
      '{"detail":"a detail"}',
      '{"message":"a message"}',
    ]
    const told = bodies.map((body) => retell("chat", 400, bytes(body)))
    expect(told.map((reply) => reply.status)).toEqual([400, 400, 400, 400, 400])
    expect(told.map((reply) => messageOf(reply.body))).toEqual([
      "from error.message",
      "from response.error",
      "a bare error string",
      "a detail",
      "a message",
    ])
    expect(told[0]?.body).toEqual({ error: { type: "invalid_request_error", message: "from error.message" } })
  })

  it("finds the failure event inside a stream that opened with one", () => {
    const stream = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.failed","response":{"error":{"message":"overloaded now"}}}\n\n',
    ].join("")
    const reply = retell("chat", 200, bytes(stream))
    expect(reply.status).toBe(200)
    expect(messageOf(reply.body)).toBe("overloaded now")
    expect(errorMessage(bytes('data: {"error":{"message":"last line, no newline"}}'))).toBe("last line, no newline")
  })

  it("passes on the first 500 bytes of an error it cannot read", () => {
    expect(messageOf(retell("chat", 502, bytes("x".repeat(800))).body)).toHaveLength(500)
    expect(errorMessage(bytes("<html>bad gateway</html>"))).toBe("<html>bad gateway</html>")
  })

  it("tells Claude Code every server error as overloaded, which it retries", () => {
    const body = bytes('{"error":{"message":"upstream broke"}}')
    const claude = retell("messages", 502, body)
    expect(claude.status).toBe(529)
    expect(claude.body).toEqual({ type: "error", error: { type: "overloaded_error", message: "upstream broke" } })
    // Other formats keep the status, as do client errors.
    expect(retell("chat", 502, body).status).toBe(502)
    expect(retell("responses", 500, body).status).toBe(500)
    expect(retell("messages", 404, body).status).toBe(404)
  })
})
