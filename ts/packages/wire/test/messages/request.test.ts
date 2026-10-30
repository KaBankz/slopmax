import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Result } from "effect"

import { Media, Part } from "../../src/ir.ts"
import { ToolResult } from "../../src/ir.ts"
import { decode } from "../../src/messages/request.ts"
import { ok } from "../helpers.ts"

describe("messages::request (Rust tests)", () => {
  it("decodes_a_claude_code_turn", () => {
    const body = {
      model: "gpt-6-sol",
      max_tokens: 32000,
      stream: true,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287; cc_entrypoint=cli;" },
        { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
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
      ],
      tools: [
        { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "enabled", budget_tokens: 31999 },
    }
    const request = ok(decode(body))
    expect(request.model).toBe("gpt-6-sol")
    expect(request.system).toEqual(["You are Claude Code."])
    expect(request.maxTokens).toBe(32000)
    expect(request.stream).toBe(true)
    expect(request.effort).toBe("High")
    expect(request.parallelToolCalls).toBe(false)
    expect(request.tools.length).toBe(1) // server tools stay behind
    expect(request.messages.length).toBe(3)
    expect(request.messages[1]?.parts).toEqual([
      Part.Text("Running ls."),
      Part.Call({ id: "toolu_1", name: "Bash", input: '{"command":"ls"}', kind: "Function" }),
    ])
    const result = request.messages[2]?.parts[0]
    if (result?._tag !== "Result") throw new Error("expected a tool result")
    expect([result.result.id, ToolResult.text(result.result)]).toEqual(["toolu_1", "a.rs"])
    const image = request.messages[2]?.parts[1]
    expect(image?._tag === "Image" && Media.url(image.media)).toBe("data:image/png;base64,iVBOR")
  })

  it("named_effort_wins_over_a_budget", () => {
    const body = { model: "m", messages: [], thinking: { type: "adaptive" }, output_config: { effort: "max" } }
    expect(ok(decode(body)).effort).toBe("Max")
    const adaptive = { model: "m", messages: [], thinking: { type: "adaptive" } }
    expect(ok(decode(adaptive)).effort).toBeUndefined()
    expect(Result.isFailure(decode({ messages: [] }))).toBe(true)
  })
})

describe("messages::request (contract details)", () => {
  it("tool choices, documents, and results", () => {
    const request = ok(
      decode({
        model: "m",
        system: "  \n ",
        tool_choice: { type: "any" },
        stop_sequences: ["END", 3],
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "text", data: "plain" } },
              {
                type: "document",
                title: "a.pdf",
                source: { type: "base64", media_type: "application/pdf", data: "JV" },
              },
              { type: "document", source: { type: "file", file_id: "f" } },
              { type: "tool_result", tool_use_id: "t", content: "failed", is_error: true },
              { type: "tool_use", id: "u", name: "n" },
              { type: "text", text: "" },
              { type: "server_tool_use", id: "s" },
            ],
          },
          { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
        ],
      }),
    )
    expect(request.system).toEqual([])
    expect(request.toolChoice).toEqual({ _tag: "Required" })
    expect(request.stop).toEqual(["END"])
    expect(request.effort).toBe("Low")
    expect(request.messages.length).toBe(1)
    expect(request.messages[0]?.parts).toEqual([
      Part.Text("plain"),
      Part.File({ mediaType: "application/pdf", source: { _tag: "Base64", data: "JV" }, name: "a.pdf" }),
      Part.Result({ id: "t", content: [Part.Text("failed")], isError: true }),
      Part.Call({ id: "u", name: "n", input: "{}", kind: "Function" }),
    ])
    expect(ok(decode({ model: "m", tool_choice: { type: "none" } })).toolChoice).toEqual({ _tag: "None" })
    expect(ok(decode({ model: "m", tool_choice: { type: "tool", name: "Bash" } })).toolChoice).toEqual({
      _tag: "Named",
      name: "Bash",
    })
  })
})
