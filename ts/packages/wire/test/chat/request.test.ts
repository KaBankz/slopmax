import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { decode, encode } from "../../src/chat/request.ts"
import { Part, Request } from "../../src/ir.ts"
import { array, get, type Json, parse, str } from "../../src/json.ts"
import { at, ok } from "../helpers.ts"

describe("chat::request (Rust tests)", () => {
  it("decodes_and_encodes_a_tool_loop", () => {
    const body: Json = {
      model: "grok-4",
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "weather?" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Oslo"}' } },
            { id: "call_2", type: "function", function: { name: "weather", arguments: '{"city":"Rome"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "rain" },
        { role: "tool", tool_call_id: "call_2", content: "sun" },
      ],
      tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
      tool_choice: "required",
      reasoning_effort: "low",
      stop: "END",
      stream: true,
      stream_options: { include_usage: true },
    }
    const request = ok(decode(body))
    expect(request.system).toEqual(["Be brief."])
    expect(request.toolChoice).toEqual({ _tag: "Required" })
    expect(request.effort).toBe("Low")
    expect(request.stop).toEqual(["END"])
    expect(request.messages.length).toBe(3)
    expect(request.messages[2]?.parts.length).toBe(2) // results answer one turn

    const out = encode(request)
    expect(array(at(out, "messages"))?.map((m) => str(at(m, "role")))).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
    ])
    expect(at(out, "messages", 2, "tool_calls", 1, "id")).toBe("call_2")
    expect(at(out, "messages", 2, "content")).toBeNull()
    expect(at(out, "stream_options", "include_usage")).toBe(true)
    expect(at(out, "tool_choice")).toBe("required")
    expect(get(out, "reasoning_effort")).toBeUndefined() // not every Chat API takes it
  })

  it("freeform_calls_travel_as_functions", () => {
    const request = Request.make({
      model: "m",
      tools: [{ name: "apply_patch", description: "Patch files", schema: null, kind: "Freeform" }],
      messages: [
        {
          role: "Assistant",
          parts: [Part.Call({ id: "c", name: "apply_patch", input: "*** Begin Patch", kind: "Freeform" })],
        },
      ],
    })
    const out = encode(request)
    expect(at(out, "tools", 0, "function", "parameters", "required", 0)).toBe("input")
    const args = str(at(out, "messages", 0, "tool_calls", 0, "function", "arguments")) ?? ""
    expect(at(parse(args), "input")).toBe("*** Begin Patch")
  })
})

describe("chat::request (contract details)", () => {
  it("encodes keys in the Rust's order, floats as serde_json writes them", () => {
    const request = Request.make({
      model: "m",
      tools: [{ name: "f", description: "d", schema: { type: "object" }, kind: "Function" }],
      toolChoice: { _tag: "Named", name: "f" },
      parallelToolCalls: false,
      maxTokens: 10,
      temperature: 1,
      topP: 0.5,
      stop: ["x"],
      format: { name: "out", schema: { type: "object" }, strict: false },
      effort: "High",
      cacheKey: "k",
    })
    expect(JSON.stringify(encode(request))).toBe(
      '{"model":"m","messages":[],"stream":true,"stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object"}}}],"tool_choice":{"type":"function","function":{"name":"f"}},"parallel_tool_calls":false,"max_tokens":10,"temperature":1.0,"top_p":0.5,"stop":["x"],"response_format":{"type":"json_schema","json_schema":{"name":"out","schema":{"type":"object"},"strict":false}}}',
    )
  })

  it("max_completion_tokens wins, even when it is null", () => {
    expect(ok(decode({ model: "m", max_completion_tokens: 5, max_tokens: 9 })).maxTokens).toBe(5)
    expect(ok(decode({ model: "m", max_tokens: 9 })).maxTokens).toBe(9)
    expect(ok(decode({ model: "m", max_completion_tokens: null, max_tokens: 9 })).maxTokens).toBeUndefined()
  })

  it("a user turn sends results first, then one message with images before its own parts", () => {
    const request = Request.make({
      model: "m",
      system: ["a", "b"],
      messages: [
        {
          role: "User",
          parts: [
            Part.Text("look"),
            Part.Result({
              id: "r",
              content: [
                Part.Text("out"),
                Part.Image({ mediaType: "image/png", source: { _tag: "Base64", data: "AA" }, name: undefined }),
              ],
              isError: true,
            }),
          ],
        },
        { role: "User", parts: [Part.Text("only")] },
        { role: "Assistant", parts: [Part.Reasoning({ text: "r", opaque: "o" })] },
        { role: "Assistant", parts: [Part.Text("x"), Part.Text("y")] },
      ],
    })
    expect(JSON.stringify(at(encode(request), "messages"))).toBe(
      '[{"role":"system","content":"a\\n\\nb"},{"role":"tool","tool_call_id":"r","content":"Error: out"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}},{"type":"text","text":"look"}]},{"role":"user","content":"only"},{"role":"assistant","content":"x\\n\\ny"}]',
    )
  })
})
