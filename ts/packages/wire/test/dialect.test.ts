// lib.rs's tests: `Dialect`, `Usage`, and frames.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Timestamp } from "@slopmax/common"

import { frame, Opening, Outcome, Usage, UsageSchema } from "../src/base.ts"
import { Dialect, DialectSchema } from "../src/dialect.ts"
import { get, type Json, stringify } from "../src/json.ts"
import { Schema } from "effect"

const at = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0
const path = (v: Json | undefined, ...keys: ReadonlyArray<string>): Json | undefined =>
  keys.reduce<Json | undefined>((acc, key) => get(acc, key), v)

describe("lib (Rust tests)", () => {
  it("each_format_names_its_errors_its_own_way", () => {
    const messages = Dialect.error("messages", "rate_limit_error", "slow")
    expect(path(messages, "type")).toBe("error")
    expect(path(messages, "error", "type")).toBe("rate_limit_error")
    expect(path(messages, "error", "message")).toBe("slow")
    for (const dialect of ["responses", "chat"] as const) {
      const body = Dialect.error(dialect, "rate_limit_error", "slow")
      expect(path(body, "error", "message")).toBe("slow")
      expect(path(body, "error", "type")).toBe("rate_limit_error")
    }
  })

  it("spent_pools_answer_with_each_clients_own_limit_error", () => {
    const [now, until] = [at(1_000), at(4_600)]
    const [body, headers] = Dialect.limitReached("chat", "all spent", until, now)
    expect(path(body, "error", "code")).toBe("rate_limit_exceeded")
    expect(path(body, "error", "message")).toBe("all spent")
    expect(headers).toEqual([])

    const [messages] = Dialect.limitReached("messages", "all spent", until, now)
    expect(path(messages, "error", "type")).toBe("rate_limit_error")
    const [responses] = Dialect.limitReached("responses", "all spent", until, now)
    expect(stringify(responses)).toContain("usage_limit_reached")
  })

  it("only_codex_streams_are_held_until_they_open", () => {
    expect(Dialect.holdsStart("responses")).toBe(true)
    expect(Dialect.holdsStart("messages")).toBe(false)
    expect(Dialect.holdsStart("chat")).toBe(false)
    const failed: Json = { type: "error", error: { code: "usage_limit_reached" } }
    expect(Dialect.opening("responses", failed)).toEqual(Opening.Refused(true))
    // Claude and chat refuse before streaming: anything is content.
    expect(Dialect.opening("messages", failed)).toEqual(Opening.Content)
    expect(Dialect.opening("chat", failed)).toEqual(Opening.Content)
  })

  it("usage_is_read_from_each_formats_events", () => {
    let outcome = Outcome.make()
    Dialect.observe("chat", { usage: { prompt_tokens: 7, completion_tokens: 2 } }, outcome)
    expect([outcome.usage.inputTokens, outcome.usage.outputTokens]).toEqual([7, 2])
    outcome = Outcome.make()
    Dialect.observe(
      "responses",
      { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } },
      outcome,
    )
    expect([outcome.usage.inputTokens, outcome.usage.outputTokens]).toEqual([9, 3])
    outcome = Outcome.make()
    Dialect.observe("messages", { type: "message_delta", usage: { output_tokens: 4 } }, outcome)
    expect(outcome.usage.outputTokens).toBe(4)
  })

  it("formats_have_stable_names", () => {
    expect(Dialect.asStr("messages")).toBe("messages")
    expect(Dialect.asStr("responses")).toBe("responses")
    expect(Dialect.asStr("chat")).toBe("chat")
  })

  it("usage_adds_up_and_totals_every_kind_of_token", () => {
    let total = Usage.zero()
    const one: Usage = { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 }
    total = Usage.add(total, one)
    total = Usage.add(total, one)
    expect(total.requests).toBe(2)
    expect(Usage.totalTokens(total)).toBe(270)
  })

  it("frames_are_server_sent_events", () => {
    const out = frame("ping", { a: 1 }) + frame(undefined, 2)
    expect(out).toBe('event: ping\ndata: {"a":1}\n\ndata: 2\n\n')
  })
})

describe("lib (contract details)", () => {
  it("dialects serialize as their lowercase names", () => {
    expect(Schema.decodeUnknownSync(DialectSchema)("responses")).toBe("responses")
    expect(() => Schema.decodeUnknownSync(DialectSchema)("Responses")).toThrow()
    expect(Dialect.all).toEqual(["messages", "responses", "chat"])
  })

  it("usage is stored with snake_case keys, every one required", () => {
    const usage: Usage = { requests: 2, inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }
    const encoded = Schema.encodeSync(UsageSchema)(usage)
    expect(JSON.stringify(encoded)).toBe(
      '{"requests":2,"input_tokens":3,"output_tokens":4,"cache_read_tokens":5,"cache_write_tokens":6}',
    )
    expect(Schema.decodeUnknownSync(UsageSchema)(encoded)).toEqual(usage)
    expect(() => Schema.decodeUnknownSync(UsageSchema)({ requests: 1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(UsageSchema)({ ...encoded, requests: -1 })).toThrow()
  })

  it("the limit headers carry the reset in epoch seconds, and Codex waits at least a second", () => {
    const now = 1_000_500
    const [, headers] = Dialect.limitReached("messages", "spent", 4_600_999, now)
    expect(headers).toEqual([
      ["anthropic-ratelimit-unified-status", "rejected"],
      ["anthropic-ratelimit-unified-reset", "4600"],
    ])
    const [body] = Dialect.limitReached("responses", "spent", now, now)
    expect(stringify(body)).toBe(
      '{"error":{"type":"usage_limit_reached","message":"spent","resets_at":1000,"resets_in_seconds":1}}',
    )
  })

  it("an in-stream rate limit marks a Claude account spent; zeros leave counts as they were", () => {
    const outcome = Outcome.make()
    Dialect.observe("messages", { type: "message_start", message: { usage: { input_tokens: 10 } } }, outcome)
    Dialect.observe("messages", { type: "message_delta", usage: { input_tokens: 0, output_tokens: 3 } }, outcome)
    expect(outcome.usage.inputTokens).toBe(10)
    expect(outcome.usage.outputTokens).toBe(3)
    Dialect.observe("messages", { type: "error", error: { type: "rate_limit_error" } }, outcome)
    expect(outcome.exhausted).toBe(true)
  })
})
