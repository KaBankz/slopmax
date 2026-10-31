import { describe, expect } from "bun:test"
import { Usage } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Result } from "effect"
import { common, messages } from "../../src/index.ts"
import { answer, context, framesOf, ok, written } from "../common/fixtures.ts"

const { Event } = common

const claudeCodeTurn = {
  model: "gpt-6-sol",
  max_tokens: 32000,
  stream: true,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287; cc_entrypoint=cli;" },
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "   " },
  ],
  messages: [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "Running ls." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.rs" }] },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      ],
    },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
  ],
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ],
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  thinking: { type: "enabled", budget_tokens: 31999 },
}

describe("Messages requests", () => {
  it("reads a Claude Code turn: system text without the billing line, calls, results and images", () => {
    const request = ok(messages.decodeRequest(claudeCodeTurn))
    expect(request.model).toBe("gpt-6-sol")
    expect(request.system).toEqual(["You are Claude Code."])
    expect(request.maxTokens).toBe(32000)
    expect(request.stream).toBe(true)
    expect(request.effort).toBe("high")
    expect(request.parallelToolCalls).toBe(false)
    expect(request.tools).toEqual([
      { name: "Bash", description: "Run a command", schema: { type: "object" }, kind: "function" },
    ])
    // The turn holding only thinking had nothing another model can read, so it is gone.
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(request.messages[1]?.parts).toEqual([
      { _tag: "Text", text: "Running ls." },
      { _tag: "Call", id: "toolu_1", name: "Bash", input: '{"command":"ls"}', kind: "function" },
    ])
    expect(request.messages[2]?.parts).toEqual([
      { _tag: "Result", callId: "toolu_1", content: [{ _tag: "Text", text: "a.rs" }], isError: false },
      {
        _tag: "Image",
        media: { mediaType: "image/png", source: { _tag: "Inline", data: "iVBOR" }, name: undefined },
      },
    ])
  })

  it("lets a named effort win over a thinking budget, and reads disabled thinking as low effort", () => {
    const named = { model: "m", messages: [], thinking: { type: "adaptive" }, output_config: { effort: "max" } }
    expect(ok(messages.decodeRequest(named)).effort).toBe("max")
    expect(ok(messages.decodeRequest({ model: "m", thinking: { type: "adaptive" } })).effort).toBeUndefined()
    expect(ok(messages.decodeRequest({ model: "m", thinking: { type: "disabled" } })).effort).toBe("low")
  })

  it("refuses a request that names no model", () => {
    const refused = messages.decodeRequest({ messages: [] })
    expect(Result.isFailure(refused) && refused.failure.message).toBe("the request names no model")
    expect(Result.isFailure(messages.decodeRequest([1, 2]))).toBe(true)
  })

  it("reads documents, linked images, error results and tool choices", () => {
    const request = ok(
      messages.decodeRequest({
        model: "m",
        stop_sequences: ["END", 3],
        tool_choice: { type: "tool", name: "Bash" },
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "text", media_type: "text/plain", data: "notes" } },
              {
                type: "document",
                title: "spec.pdf",
                source: { type: "base64", media_type: "application/pdf", data: "JVBE" },
              },
              { type: "image", source: { type: "url", url: "https://x.dev/a.png" } },
              { type: "text", text: "" },
              { type: "tool_result", tool_use_id: "t", content: "boom", is_error: true },
              { type: "tool_use", id: "t2", name: "Bash" },
              { type: "tool_use", id: "t3", name: "Bash", input: null },
            ],
          },
        ],
      }),
    )
    expect(request.stop).toEqual(["END"])
    expect(request.toolChoice).toEqual({ _tag: "Named", name: "Bash" })
    expect(request.messages[0]?.parts).toEqual([
      { _tag: "Text", text: "notes" },
      {
        _tag: "File",
        media: { mediaType: "application/pdf", source: { _tag: "Inline", data: "JVBE" }, name: "spec.pdf" },
      },
      {
        _tag: "Image",
        media: { mediaType: "", source: { _tag: "Link", url: "https://x.dev/a.png" }, name: undefined },
      },
      { _tag: "Result", callId: "t", content: [{ _tag: "Text", text: "boom" }], isError: true },
      { _tag: "Call", id: "t2", name: "Bash", input: "{}", kind: "function" },
      { _tag: "Call", id: "t3", name: "Bash", input: "{}", kind: "function" },
    ])
    expect(ok(messages.decodeRequest({ model: "m", tool_choice: { type: "any" } })).toolChoice._tag).toBe("Required")
    expect(ok(messages.decodeRequest({ model: "m", tool_choice: { type: "none" } })).toolChoice._tag).toBe("None")
  })
})

const call: common.ToolCall = { id: "call_1", name: "Bash", input: '{"command":"ls"}', kind: "function" }
const usage = new Usage({ requests: 1, input: 40, output: 9, cacheRead: 60, cacheWrite: 0 })

describe("MessagesWriter", () => {
  it("streams text, then a tool_use block, then the stop and usage, every frame named", () => {
    const out = written(new messages.MessagesWriter(context()), [
      Event.Reasoning({ text: "thinking..." }),
      Event.State({ state: "gAAA" }),
      Event.Text({ text: "Let me " }),
      Event.Text({ text: "check." }),
      Event.Call({ call }),
      Event.Done({ stop: "toolUse", usage }),
    ])
    const frames = framesOf(out)
    expect(frames.map((frame) => frame.event)).toEqual([
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
    expect(frames[0]?.data).toEqual({
      type: "message_start",
      message: {
        id: "msg_t1",
        type: "message",
        role: "assistant",
        model: "gpt-6-sol",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    expect(frames[5]?.data).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_1", name: "Bash", input: {} },
    })
    expect(frames[6]?.data).toEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
    })
    expect(frames[8]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 },
    })
    expect(out).not.toContain("thinking...")
  })

  it("says tool_use when an answer that made calls only says it ended", () => {
    const out = written(new messages.MessagesWriter(context()), [
      Event.Call({ call }),
      Event.Done({ stop: "end", usage }),
    ])
    expect(out).toContain('"stop_reason":"tool_use"')
  })

  it("turns a failure into an error event in Messages' own shape, and writes nothing after it", () => {
    const writer = new messages.MessagesWriter(context("m"))
    const out = written(writer, [
      Event.Text({ text: "partial" }),
      Event.Failed({ failure: { status: 529, message: "overloaded" } }),
    ])
    const frames = framesOf(out)
    expect(frames.at(-2)?.event).toBe("content_block_stop")
    expect(frames.at(-1)).toEqual({
      event: "error",
      data: { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
    })
    expect(writer.write(Event.Text({ text: "more" }))).toBe("")
  })
})

describe("whole Messages answers", () => {
  it("carry the text, then each call with its input as JSON, freeform input wrapped", () => {
    const message = messages.whole(
      answer({
        text: "Done.",
        calls: [
          { id: "c", name: "apply_patch", input: "*** Begin Patch", kind: "freeform" },
          { id: "d", name: "Bash", input: "not json", kind: "function" },
          { id: "e", name: "Bash", input: "[1]", kind: "function" },
        ],
      }),
      context("m"),
    )
    expect(message).toEqual({
      id: "msg_t1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id: "c", name: "apply_patch", input: { input: "*** Begin Patch" } },
        { type: "tool_use", id: "d", name: "Bash", input: {} },
        { type: "tool_use", id: "e", name: "Bash", input: {} },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
  })

  it("name each stop the Messages way", () => {
    const reasons = (["end", "length", "sequence", "filtered"] as const).map(
      (stop) => messages.whole(answer({ text: "x", stop }), context()).stop_reason,
    )
    expect(reasons).toEqual(["end_turn", "max_tokens", "stop_sequence", "refusal"])
  })
})
