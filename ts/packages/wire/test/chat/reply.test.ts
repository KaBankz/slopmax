import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Usage } from "../../src/base.ts"
import { Reply, whole } from "../../src/chat/reply.ts"
import { Answer, type Event } from "../../src/ir.ts"
import { array, type Json, parse } from "../../src/json.ts"
import { at } from "../helpers.ts"

/** The clock, for the `created` fields. */
const NOW = 1_700_000_000_000

const chunks = (out: string): Array<string> =>
  out
    .split("\n\n")
    .filter((f) => f !== "")
    .map((f) => f.replace(/^data: /, ""))

describe("chat::reply (Rust tests)", () => {
  it("streams_chunks_then_usage_and_done", () => {
    const reply = new Reply("gpt-6-sol", true, NOW)
    let out = ""
    for (const event of [
      { _tag: "Text", text: "Hi" },
      { _tag: "Call", call: { id: "call_1", name: "f", input: "{}", kind: "Function" } },
      { _tag: "Done", stop: "End", usage: { ...Usage.zero(), inputTokens: 2, cacheReadTokens: 8, outputTokens: 3 } },
    ] satisfies Array<Event>) {
      out += reply.event(event)
    }
    const all = chunks(out)
    expect(all.at(-1)).toBe("[DONE]")
    const parsed: Array<Json> = all.slice(0, -1).map((c) => parse(c) ?? null)
    expect(at(parsed[0], "choices", 0, "delta", "role")).toBe("assistant")
    expect(at(parsed[1], "choices", 0, "delta", "content")).toBe("Hi")
    expect(at(parsed[2], "choices", 0, "delta", "tool_calls", 0, "index")).toBe(0)
    expect(at(parsed[3], "choices", 0, "finish_reason")).toBe("tool_calls")
    expect(at(parsed[4], "usage", "prompt_tokens")).toBe(10)
    expect(array(at(parsed[4], "choices"))?.length).toBe(0)
  })

  it("usage_chunks_only_when_asked", () => {
    const reply = new Reply("m", false, NOW)
    const out = reply.event({ _tag: "Done", stop: "End", usage: Usage.zero() })
    expect(out).not.toContain("usage")
  })

  it("whole_completions", () => {
    const completion = whole(Answer.make({ text: "Hello", reasoning: "Greet" }), "m", NOW)
    expect(at(completion, "choices", 0, "message", "content")).toBe("Hello")
    expect(at(completion, "choices", 0, "message", "reasoning_content")).toBe("Greet")
    expect(at(completion, "choices", 0, "finish_reason")).toBe("stop")
  })
})

describe("chat::reply (contract details)", () => {
  it("chunks carry the id, object, creation time, and model; errors end with [DONE]", () => {
    const reply = new Reply("m", false, 1_700_000_000_500)
    const out = reply.event({ _tag: "Error", failure: { status: 429, message: "slow" } })
    expect(out).toMatch(
      /^data: \{"id":"chatcmpl-[A-Za-z0-9_-]{43}","object":"chat\.completion\.chunk","created":1700000000,"model":"m","choices":\[\{"index":0,"delta":\{"role":"assistant","content":""\},"finish_reason":null\}\]\}\n\n/,
    )
    expect(
      out.endsWith('data: {"error":{"message":"slow","type":"rate_limit_error","code":429}}\n\ndata: [DONE]\n\n'),
    ).toBe(true)
  })

  it("whole completions: null content, freeform calls wrapped, finish reasons, usage", () => {
    const answer = Answer.make({
      calls: [{ id: "c", name: "p", input: "raw", kind: "Freeform" }],
      usage: { requests: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    })
    const completion = whole(answer, "m", 5_000)
    expect(JSON.stringify(at(completion, "choices"))).toBe(
      '[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c","type":"function","function":{"name":"p","arguments":"{\\"input\\":\\"raw\\"}"}}]},"finish_reason":"tool_calls"}]',
    )
    expect(JSON.stringify(at(completion, "usage"))).toBe(
      '{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":3}}',
    )
    expect(at(completion, "created")).toBe(5)
    for (const [stop, reason] of [
      ["Sequence", "stop"],
      ["Length", "length"],
      ["Filtered", "content_filter"],
    ] as const) {
      expect(at(whole(Answer.make({ stop }), "m", NOW), "choices", 0, "finish_reason")).toBe(reason)
    }
  })
})
