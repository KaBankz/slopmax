import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Part, Request } from "../../src/ir.ts"
import { array, type Json, str } from "../../src/json.ts"
import { decode, encode } from "../../src/responses/request.ts"
import { at, ok } from "../helpers.ts"

const codexBody = (): Json => ({
  model: "gpt-6-sol",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Sandbox: workspace-write" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: "gAAA" },
    { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["ls"]}' },
    { type: "function_call_output", call_id: "c1", output: "a.rs" },
    { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** Begin Patch" },
    { type: "custom_tool_call_output", call_id: "c2", output: "Done" },
    { type: "web_search_call", id: "ws_1" },
  ],
  tools: [
    { type: "function", name: "shell", description: "Run", parameters: { type: "object" } },
    { type: "custom", name: "apply_patch", description: "Patch", format: { type: "grammar" } },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "high", summary: "auto" },
  store: false,
  stream: true,
  prompt_cache_key: "conv-1",
})

describe("responses::request (Rust tests)", () => {
  it("decodes_codex_items_into_turns", () => {
    const request = ok(decode(codexBody()))
    expect(request.system).toEqual(["You are Codex.", "Sandbox: workspace-write"])
    expect(request.effort).toBe("High")
    expect(request.cacheKey).toBe("conv-1")
    expect(request.parallelToolCalls).toBe(false)
    expect(request.tools.map((t) => t.kind)).toEqual(["Function", "Freeform"])
    expect(request.messages.map((m) => m.role)).toEqual(["User", "Assistant", "User", "Assistant", "User"])
    const reasoning = request.messages[1]?.parts[0]
    expect(reasoning?._tag === "Reasoning" && reasoning.reasoning.opaque).toBe("gAAA")
    const call = request.messages[3]?.parts[0]
    expect(call?._tag === "Call" && call.call.kind).toBe("Freeform")
  })

  it("encodes_turns_as_items", () => {
    const decoded = ok(decode(codexBody()))
    const [first, ...rest] = decoded.messages
    if (first === undefined) throw new Error("expected a first message")
    const request = Request.make({
      ...decoded,
      messages: [
        {
          ...first,
          parts: [
            ...first.parts,
            Part.Image({ mediaType: "image/png", source: { _tag: "Base64", data: "iVBOR" }, name: undefined }),
          ],
        },
        ...rest,
      ],
    })
    const body = encode(request)
    expect(at(body, "instructions")).toBe("You are Codex.\n\nSandbox: workspace-write")
    expect(at(body, "store")).toBe(false)
    expect(at(body, "stream")).toBe(true)
    expect(at(body, "reasoning", "effort")).toBe("high")
    expect(at(body, "prompt_cache_key")).toBe("conv-1")
    expect(array(at(body, "input"))?.map((i) => str(at(i, "type")))).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
    ])
    expect(at(body, "input", 0, "content", 1, "image_url")).toBe("data:image/png;base64,iVBOR")
    expect(at(body, "tools", 1, "parameters", "required", 0)).toBe("input")
    expect(at(body, "parallel_tool_calls")).toBe(false)
  })

  it("foreign_reasoning_is_not_replayed", () => {
    const request = Request.make({
      model: "m",
      messages: [
        {
          role: "Assistant",
          parts: [Part.Reasoning({ text: "summary only", opaque: undefined }), Part.Text("Hi")],
        },
      ],
    })
    const body = encode(request)
    expect(array(at(body, "input"))?.length).toBe(1)
    expect(at(body, "input", 0, "content", 0, "type")).toBe("output_text")
  })
})

describe("responses::request (contract details)", () => {
  it("encodes keys in the Rust's order, and Max as xhigh", () => {
    const request = Request.make({
      model: "m",
      system: ["a", "b"],
      tools: [{ name: "f", description: "d", schema: { type: "object" }, kind: "Function" }],
      toolChoice: { _tag: "Named", name: "f" },
      effort: "Max",
      cacheKey: "k",
      format: { name: "out", schema: { type: "object" }, strict: true },
      maxTokens: 10,
      temperature: 0.5,
      topP: 0.9,
      stop: ["x"],
    })
    expect(JSON.stringify(encode(request))).toBe(
      '{"model":"m","instructions":"a\\n\\nb","input":[],"tools":[{"type":"function","name":"f","description":"d","parameters":{"type":"object"},"strict":false}],"tool_choice":{"type":"function","name":"f"},"parallel_tool_calls":true,"reasoning":{"effort":"xhigh","summary":"auto"},"store":false,"stream":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"k","text":{"format":{"type":"json_schema","name":"out","schema":{"type":"object"},"strict":true}},"max_output_tokens":10}',
    )
    expect(JSON.stringify(encode(Request.make({ model: "m" })))).toBe(
      '{"model":"m","instructions":"","input":[],"store":false,"stream":true,"include":["reasoning.encrypted_content"]}',
    )
  })

  it("results follow their call's kind, errors say so, and returned images follow as a user message", () => {
    const request = Request.make({
      model: "m",
      messages: [
        { role: "Assistant", parts: [Part.Call({ id: "p", name: "apply_patch", input: "x", kind: "Freeform" })] },
        {
          role: "User",
          parts: [
            Part.Result({
              id: "p",
              content: [
                Part.Text("bad"),
                Part.Image({ mediaType: "", source: { _tag: "Url", url: "https://x/i.png" }, name: undefined }),
              ],
              isError: true,
            }),
            Part.Result({ id: "q", content: [], isError: true }),
            Part.File({ mediaType: "application/pdf", source: { _tag: "Base64", data: "JV" }, name: undefined }),
          ],
        },
      ],
    })
    expect(JSON.stringify(at(encode(request), "input"))).toBe(
      '[{"type":"custom_tool_call","call_id":"p","name":"apply_patch","input":"x"},{"type":"custom_tool_call_output","call_id":"p","output":"Error: bad"},{"type":"function_call_output","call_id":"q","output":""},{"type":"message","role":"user","content":[{"type":"input_file","filename":"document.pdf","file_data":"data:application/pdf;base64,JV"}]},{"type":"message","role":"user","content":[{"type":"input_image","image_url":"https://x/i.png"}]}]',
    )
  })

  it("text does not join a turn that holds calls or results", () => {
    const request = ok(
      decode({
        model: "m",
        input: [
          { type: "function_call_output", call_id: "x", output: "r" },
          { role: "user", content: "after" },
          { type: "function_call", call_id: "y", name: "n", arguments: "{}" },
          { type: "reasoning", summary: [] },
          { role: "assistant", content: [{ type: "output_text", text: "said" }] },
        ],
      }),
    )
    expect(request.messages.map((m) => [m.role, m.parts.map((p) => p._tag)])).toEqual([
      ["User", ["Result"]],
      ["User", ["Text"]],
      ["Assistant", ["Call", "Reasoning"]],
      ["Assistant", ["Text"]],
    ])
  })

  it("tool choices, input text, and the default schema", () => {
    const request = ok(
      decode({ model: "m", input: "hi", tool_choice: "required", tools: [{ type: "function", name: "f" }] }),
    )
    expect(request.messages).toEqual([{ role: "User", parts: [Part.Text("hi")] }])
    expect(request.toolChoice).toEqual({ _tag: "Required" })
    expect(request.tools[0]?.schema).toEqual({ type: "object", properties: {} })
    expect(ok(decode({ model: "m", tool_choice: "none" })).toolChoice).toEqual({ _tag: "None" })
    expect(ok(decode({ model: "m", tool_choice: "other" })).toolChoice).toEqual({ _tag: "Auto" })
    expect(ok(decode({ model: "m", tool_choice: { type: "function" } })).toolChoice).toEqual({ _tag: "Auto" })
  })
})
