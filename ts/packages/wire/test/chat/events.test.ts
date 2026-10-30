import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Events, whole } from "../../src/chat/events.ts"
import type { Event } from "../../src/ir.ts"
import type { Json } from "../../src/json.ts"

const chunk = (delta: Json, finish: string | null): Json => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const stop = (reason: string): string => {
  const [done] = whole({ choices: [{ delta: {}, finish_reason: reason }] })
  return done?._tag === "Done" ? done.stop : "none"
}

const failure = (error: Json): Event | undefined => whole({ error })[0]

describe("chat::events (Rust tests)", () => {
  it("gathers_interleaved_tool_calls", () => {
    const events = new Events(new Set(["apply_patch"]))
    const out: Array<Event> = []
    for (const c of [
      chunk({ role: "assistant", content: "On it." }, null),
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: '{"cmd"' } }] }, null),
      chunk(
        { tool_calls: [{ index: 1, id: "call_b", function: { name: "apply_patch", arguments: '{"input":' } }] },
        null,
      ),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, null),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"*** Begin"}' } }] }, null),
      chunk({}, "tool_calls"),
      {
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      },
    ] satisfies Array<Json>) {
      events.feed(c, out)
    }
    events.finish(out)
    expect(out[0]).toEqual({ _tag: "Text", text: "On it." })
    expect(out[1]).toEqual({
      _tag: "Call",
      call: { id: "call_a", name: "shell", input: '{"cmd":"ls"}', kind: "Function" },
    })
    expect(out[2]).toEqual({
      _tag: "Call",
      call: { id: "call_b", name: "apply_patch", input: "*** Begin", kind: "Freeform" },
    })
    const done = out[3]
    if (done?._tag !== "Done") throw new Error(`expected the end, got ${JSON.stringify(done)}`)
    expect(done.stop).toBe("ToolUse")
    expect([done.usage.inputTokens, done.usage.cacheReadTokens]).toEqual([10, 40])
  })

  it("reasoning_and_whole_completions", () => {
    const completion: Json = {
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "42", reasoning_content: "Think" },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }
    const out = whole(completion, new Set())
    expect(out[0]).toEqual({ _tag: "Reasoning", text: "Think" })
    expect(out[1]).toEqual({ _tag: "Text", text: "42" })
    expect(out[2]?._tag === "Done" && out[2].stop).toBe("Length")
  })

  it("errors_and_cut_streams", () => {
    const events = new Events(new Set())
    let out: Array<Event> = []
    events.feed({ error: { message: "overloaded", code: 503 } }, out)
    expect(out).toEqual([{ _tag: "Error", failure: { status: 503, message: "overloaded" } }])
    const cut = new Events(new Set())
    out = []
    cut.feed(chunk({ content: "Hi" }, null), out)
    cut.finish(out)
    const last = out.at(-1)
    expect(last?._tag === "Error" && last.failure.status).toBe(502)
  })
})

describe("chat::events (contract details)", () => {
  it("finish reasons, a missing usage, and ids made up for calls without one", () => {
    expect(["length", "tool_calls", "function_call", "content_filter", "stop", "eos"].map(stop)).toEqual([
      "Length",
      "ToolUse",
      "ToolUse",
      "Filtered",
      "End",
      "End",
    ])
    const out = whole({ choices: [{ delta: { tool_calls: [{ function: { name: "f" } }] }, finish_reason: "stop" }] })
    expect(out[0]?._tag === "Call" && out[0].call.id).toMatch(/^call_[A-Za-z0-9_-]{43}$/)
    expect(out[0]?._tag === "Call" && out[0].call.input).toBe("")
    expect(out[1]).toEqual({
      _tag: "Done",
      stop: "End",
      usage: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it("error statuses outside 400-599 read as 500, and a missing message has a default", () => {
    expect(failure({ code: 302 })).toEqual({
      _tag: "Error",
      failure: { status: 500, message: "the upstream answer failed" },
    })
    expect(failure({ code: "429", message: "m" })).toEqual({ _tag: "Error", failure: { status: 500, message: "m" } })
    expect(failure({ code: 599, message: "m" })).toEqual({ _tag: "Error", failure: { status: 599, message: "m" } })
  })

  it("freeform calls whose arguments are not the wrapper pass through raw", () => {
    const out = whole(
      {
        choices: [
          { delta: { tool_calls: [{ id: "c", function: { name: "p", arguments: "raw" } }] }, finish_reason: "stop" },
        ],
      },
      new Set(["p"]),
    )
    expect(out[0]).toEqual({ _tag: "Call", call: { id: "c", name: "p", input: "raw", kind: "Freeform" } })
  })
})
