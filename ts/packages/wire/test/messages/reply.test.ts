import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Usage } from "../../src/base.ts"
import { Answer, type Event } from "../../src/ir.ts"
import { Reply, whole } from "../../src/messages/reply.ts"
import { at, frames } from "../helpers.ts"

describe("messages::reply (Rust tests)", () => {
  it("streams_text_then_tool_use", () => {
    const reply = new Reply("gpt-6-sol")
    let out = ""
    const events: Array<Event> = [
      { _tag: "Reasoning", text: "thinking..." },
      { _tag: "Text", text: "Let me " },
      { _tag: "Text", text: "check." },
      { _tag: "Call", call: { id: "call_1", name: "Bash", input: '{"command":"ls"}', kind: "Function" } },
      {
        _tag: "Done",
        stop: "ToolUse",
        usage: { ...Usage.zero(), inputTokens: 40, cacheReadTokens: 60, outputTokens: 9 },
      },
    ]
    for (const event of events) out += reply.event(event)
    const all = frames(out)
    expect(all.map(([name]) => name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(at(all[0]?.[1], "message", "model")).toBe("gpt-6-sol")
    expect(at(all[5]?.[1], "index")).toBe(1)
    expect(at(all[5]?.[1], "content_block", "id")).toBe("call_1")
    expect(at(all[6]?.[1], "delta", "partial_json")).toBe('{"command":"ls"}')
    expect(at(all[8]?.[1], "delta", "stop_reason")).toBe("tool_use")
    expect(at(all[8]?.[1], "usage", "cache_read_input_tokens")).toBe(60)
  })

  it("failures_become_error_events", () => {
    const reply = new Reply("m")
    let out = reply.event({ _tag: "Text", text: "partial" })
    out += reply.event({ _tag: "Error", failure: { status: 529, message: "overloaded" } })
    const [name, error] = frames(out).at(-1) ?? ["", null]
    expect(name).toBe("error")
    expect(at(error, "error", "type")).toBe("overloaded_error")
  })

  it("whole_messages_carry_text_and_calls", () => {
    const answer = Answer.make({
      text: "Done.",
      calls: [{ id: "c", name: "apply_patch", input: "*** Begin Patch", kind: "Freeform" }],
    })
    const message = whole(answer, "m")
    expect(at(message, "content", 0, "text")).toBe("Done.")
    expect(at(message, "content", 1, "input", "input")).toBe("*** Begin Patch")
    expect(at(message, "stop_reason")).toBe("tool_use")
  })
})

describe("messages::reply (contract details)", () => {
  it("the stream opens with an empty message and every frame is named", () => {
    const out = new Reply("m").event({ _tag: "Done", stop: "End", usage: Usage.zero() })
    expect(out).toMatch(
      /^event: message_start\ndata: \{"type":"message_start","message":\{"id":"msg_[A-Za-z0-9_-]{43}","type":"message","role":"assistant","model":"m","content":\[\],"stop_reason":null,"stop_sequence":null,"usage":\{"input_tokens":0,"output_tokens":0\}\}\}\n\n/,
    )
    expect(out).toContain(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n\n',
    )
    expect(out.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true)
  })

  it("whole messages: unparsable input is an empty object, stops have Anthropic's names", () => {
    const answer = Answer.make({ calls: [{ id: "c", name: "f", input: "not json", kind: "Function" }], stop: "End" })
    expect(at(whole(answer, "m"), "content", 0, "input")).toEqual({})
    for (const [stop, name] of [
      ["End", "end_turn"],
      ["Length", "max_tokens"],
      ["Sequence", "stop_sequence"],
      ["Filtered", "refusal"],
    ] as const) {
      expect(at(whole(Answer.make({ stop }), "m"), "stop_reason")).toBe(name)
    }
  })
})
