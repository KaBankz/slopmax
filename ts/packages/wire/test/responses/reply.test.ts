import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Usage } from "../../src/base.ts"
import { Answer, type Event } from "../../src/ir.ts"
import { array, type Json, str, u64 } from "../../src/json.ts"
import { compacted, Reply, whole } from "../../src/responses/reply.ts"
import { at, datas, frames } from "../helpers.ts"

/** The clock, for the `created` fields. */
const NOW = 1_700_000_000_000

const code = (status: number): Json | undefined =>
  at(
    datas(new Reply("m", NOW).event({ _tag: "Error", failure: { status, message: "" } })).at(-1),
    "response",
    "error",
    "code",
  )

describe("responses::reply (Rust tests)", () => {
  it("streams_items_codex_can_rebuild", () => {
    const reply = new Reply("grok-4", NOW)
    let out = ""
    const script: Array<Event> = [
      { _tag: "Reasoning", text: "Thinking" },
      { _tag: "Text", text: "Patching." },
      { _tag: "Call", call: { id: "call_7", name: "apply_patch", input: "*** Begin Patch", kind: "Freeform" } },
      {
        _tag: "Done",
        stop: "ToolUse",
        usage: { ...Usage.zero(), inputTokens: 10, cacheReadTokens: 30, outputTokens: 5 },
      },
    ]
    for (const event of script) out += reply.event(event)
    const events = datas(out)
    const done: Array<Json | undefined> = events
      .filter((e) => at(e, "type") === "response.output_item.done")
      .map((e) => at(e, "item"))
    expect(done.map((i) => str(at(i, "type")))).toEqual(["reasoning", "message", "custom_tool_call"])
    expect(at(done[1], "content", 0, "text")).toBe("Patching.")
    expect(at(done[2], "input")).toBe("*** Begin Patch")
    expect(at(done[2], "call_id")).toBe("call_7")
    const completed = events.at(-1)
    expect(at(completed, "type")).toBe("response.completed")
    expect(at(completed, "response", "usage", "input_tokens")).toBe(40)
    expect(at(completed, "response", "usage", "total_tokens")).toBe(45)
    expect(array(at(completed, "response", "output"))?.length).toBe(3)
    // Sequence numbers count up from zero.
    expect(events.map((e) => u64(at(e, "sequence_number")))).toEqual(events.map((_, i) => i))
  })

  it("failures_fail_the_response", () => {
    const reply = new Reply("m", NOW)
    const out = reply.event({ _tag: "Error", failure: { status: 429, message: "slow down" } })
    const last = datas(out).at(-1)
    expect(at(last, "type")).toBe("response.failed")
    expect(at(last, "response", "error", "code")).toBe("rate_limit_exceeded")
  })

  it("whole_responses", () => {
    const response = whole(Answer.make({ text: "Hello" }), "m", NOW)
    expect(at(response, "object")).toBe("response")
    expect(at(response, "output", 0, "content", 0, "text")).toBe("Hello")
    expect(at(response, "status")).toBe("completed")
  })
})

describe("responses::reply (contract details)", () => {
  it("the stream opens with created and in_progress, every frame named, type and sequence after the payload", () => {
    const now = 1_700_000_000_999
    const out = new Reply("m", now).event({ _tag: "Text", text: "Hi" })
    const all = frames(out)
    expect(all.map(([name]) => name)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
    ])
    expect(out).toMatch(
      /^event: response\.created\ndata: \{"response":\{"id":"resp_[A-Za-z0-9_-]{43}","object":"response","created_at":1700000000,"status":"in_progress","model":"m","output":\[\]\},"type":"response\.created","sequence_number":0\}\n\n/,
    )
    expect(out).toMatch(
      /data: \{"item_id":"msg_[A-Za-z0-9_-]{43}","output_index":0,"content_index":0,"delta":"Hi","type":"response\.output_text\.delta","sequence_number":4\}\n\n$/,
    )
  })

  it("a length stop makes the response incomplete", () => {
    const reply = new Reply("m", NOW)
    const out = reply.event({ _tag: "Done", stop: "Length", usage: Usage.zero() })
    const last = datas(out).at(-1)
    expect(at(last, "type")).toBe("response.incomplete")
    expect(at(last, "response", "status")).toBe("incomplete")
    expect(at(last, "response", "incomplete_details", "reason")).toBe("max_output_tokens")
    const answer = Answer.make({ text: "x", stop: "Length" })
    expect(at(whole(answer, "m", NOW), "status")).toBe("incomplete")
  })

  it("compacting gathers the text into one sealed compaction item", () => {
    const reply = Reply.compacting("m", NOW)
    let out = ""
    for (const event of [
      { _tag: "Reasoning", text: "hidden" },
      { _tag: "Text", text: "Sum" },
      { _tag: "State", state: "s" },
      { _tag: "Call", call: { id: "c", name: "f", input: "{}", kind: "Function" } },
      { _tag: "Text", text: "mary" },
      { _tag: "Done", stop: "End", usage: Usage.zero() },
    ] satisfies Array<Event>) {
      out += reply.event(event)
    }
    const names = frames(out).map(([name]) => name)
    expect(names).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ])
    const item = at(datas(out)[3], "item")
    expect(str(at(item, "id"))).toMatch(/^cmp_[A-Za-z0-9_-]{43}$/)
    expect(at(item, "encrypted_content")).toBe(`slopmax1:${Buffer.from("Summary").toString("base64")}`)
    const failed = Reply.compacting("m", NOW).event({ _tag: "Error", failure: { status: 500, message: "x" } })
    expect(at(datas(failed).at(-1), "type")).toBe("response.failed")
    const one = compacted(Answer.make({ text: "Summary" }), "m", NOW)
    expect(array(at(one, "output"))?.length).toBe(1)
    expect(at(one, "status")).toBe("completed")
  })

  it("error codes by status", () => {
    expect([429, 503, 529, 400, 500, 401].map(code)).toEqual([
      "rate_limit_exceeded",
      "server_is_overloaded",
      "server_is_overloaded",
      "invalid_request_error",
      "server_error",
      "server_error",
    ])
  })
})
