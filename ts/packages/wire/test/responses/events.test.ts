import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import type { Event } from "../../src/ir.ts"
import type { Json } from "../../src/json.ts"
import { Events, whole } from "../../src/responses/events.ts"

const read = (events: ReadonlyArray<Json>): Array<Event> => {
  const decoder = new Events()
  const out: Array<Event> = []
  for (const event of events) decoder.feed(event, out)
  decoder.finish(out)
  return out
}

describe("responses::events (Rust tests)", () => {
  it("reads_text_reasoning_state_and_calls", () => {
    const events = read([
      { type: "response.created", response: { id: "r" } },
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Plan A" },
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Plan B" },
      { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "gAAA" } },
      { type: "response.output_text.delta", item_id: "m1", delta: "Hi" },
      {
        type: "response.output_item.done",
        item: { type: "message", id: "m1", content: [{ type: "output_text", text: "Hi" }] },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 7,
            total_tokens: 107,
          },
        },
      },
    ])
    expect(events).toEqual([
      { _tag: "Reasoning", text: "Plan A" },
      { _tag: "Reasoning", text: "\n\n" },
      { _tag: "Reasoning", text: "Plan B" },
      { _tag: "State", state: "gAAA" },
      { _tag: "Text", text: "Hi" },
      { _tag: "Call", call: { id: "c1", name: "Bash", input: "{}", kind: "Function" } },
      {
        _tag: "Done",
        stop: "End",
        usage: { requests: 1, inputTokens: 20, cacheReadTokens: 80, outputTokens: 7, cacheWriteTokens: 0 },
      },
    ])
  })

  it("failures_and_cut_streams_are_errors", () => {
    const events = read([
      { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "busy" } } },
    ])
    expect(events).toEqual([{ _tag: "Error", failure: { status: 529, message: "busy" } }])
    const cut = read([{ type: "response.output_text.delta", delta: "Hi" }])
    const last = cut.at(-1)
    expect(last?._tag === "Error" && last.failure.status).toBe(502)
  })

  it("whole_responses_and_length_stops", () => {
    const events = whole({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", id: "m", content: [{ type: "output_text", text: "Partial" }] }],
      usage: { input_tokens: 5, output_tokens: 9 },
    })
    expect(events[0]).toEqual({ _tag: "Text", text: "Partial" })
    expect(events[1]?._tag === "Done" && events[1].stop).toBe("Length")
  })
})

describe("responses::events (contract details)", () => {
  it("failure statuses follow the code, then the type", () => {
    const status = (error: Json): number => {
      const [event] = read([{ type: "error", error }])
      return event?._tag === "Error" ? event.failure.status : 0
    }
    expect(status({ code: "rate_limit_exceeded" })).toBe(429)
    expect(status({ code: "usage_limit_exceeded" })).toBe(429)
    expect(status({ type: "slow_down" })).toBe(529)
    expect(status({ code: "invalid_prompt" })).toBe(400)
    expect(status({ code: "context_length_exceeded" })).toBe(400)
    expect(status({ code: "other" })).toBe(500)
    const [blank] = read([{ type: "error", error: { message: "" } }])
    expect(blank).toEqual({ _tag: "Error", failure: { status: 500, message: "the upstream response failed" } })
  })

  it("a whole response with an error is that error alone; content filters stop as filtered", () => {
    expect(whole({ error: { code: "invalid_prompt", message: "no" }, output: [{ type: "message" }] })).toEqual([
      { _tag: "Error", failure: { status: 400, message: "no" } },
    ])
    const [done] = whole({ error: null, incomplete_details: { reason: "content_filter" } })
    expect(done?._tag === "Done" && done.stop).toBe("Filtered")
  })
})
