import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Usage } from "../src/base.ts"
import { Answer, type Call, Effort, Event, Failure, Media, Source, textOf, ToolResult, Part } from "../src/ir.ts"

describe("ir (Rust tests)", () => {
  it("data_urls_round_trip", () => {
    const media = Media.fromUrl("data:image/png;base64,iVBOR")
    expect(media.mediaType).toBe("image/png")
    expect(media.source).toEqual(Source.Base64("iVBOR"))
    expect(Media.url(media)).toBe("data:image/png;base64,iVBOR")
    const remote = Media.fromUrl("https://x.dev/a.png")
    expect(remote.source).toEqual(Source.Url("https://x.dev/a.png"))
  })

  it("answers_collect_and_infer_tool_use", () => {
    const call: Call = { id: "c1", name: "Bash", input: "{}", kind: "Function" }
    const answer = Answer.collect([
      Event.Text("Let me "),
      Event.Text("look."),
      Event.Call(call),
      Event.Done("End", Usage.zero()),
    ])
    expect(answer.text).toBe("Let me look.")
    expect(answer.calls).toEqual([call])
    expect(Answer.stop(answer)).toBe("ToolUse")
  })

  it("budgets_map_to_efforts", () => {
    expect(Effort.fromBudget(1_024)).toBe("Low")
    expect(Effort.fromBudget(10_000)).toBe("Medium")
    expect(Effort.fromBudget(31_999)).toBe("High")
    expect(Effort.parse("xhigh")).toBe("Max")
    expect(Effort.parse("turbo")).toBeUndefined()
  })
})

describe("ir (contract details)", () => {
  it("effort names and budget edges", () => {
    expect(["minimal", "none", "low", "medium", "high", "xhigh", "max"].map(Effort.parse)).toEqual([
      "Minimal",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Max",
      "Max",
    ])
    expect([0, 4_095, 4_096, 16_383, 16_384].map(Effort.fromBudget)).toEqual(["Low", "Low", "Medium", "Medium", "High"])
  })

  it("failure kinds by status", () => {
    const kinds = [400, 401, 403, 404, 413, 429, 503, 529, 500, 502].map((status) =>
      Failure.kind({ status, message: "" }),
    )
    expect(kinds).toEqual([
      "invalid_request_error",
      "authentication_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "rate_limit_error",
      "overloaded_error",
      "overloaded_error",
      "api_error",
      "api_error",
    ])
  })

  it("answers keep the last end and the last error, and infer tool use only when ending normally", () => {
    const call: Call = { id: "c", name: "f", input: "", kind: "Freeform" }
    const usage: Usage = { requests: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const answer = Answer.collect([
      Event.Reasoning("a"),
      Event.State("opaque"),
      Event.Reasoning("b"),
      Event.Call(call),
      Event.Error({ status: 500, message: "first" }),
      Event.Error({ status: 502, message: "last" }),
      Event.Done("End", Usage.zero()),
      Event.Done("Length", usage),
    ])
    expect(answer.reasoning).toBe("ab")
    expect(answer.error).toEqual({ status: 502, message: "last" })
    expect(answer.usage).toEqual(usage)
    expect(Answer.stop(answer)).toBe("Length")
    expect(Answer.stop(Answer.collect([Event.Call(call)]))).toBe("ToolUse")
    expect(Answer.stop(Answer.collect([]))).toBe("End")
  })

  it("text_of reads strings and the text of each part", () => {
    expect(textOf("plain")).toBe("plain")
    expect(textOf([{ type: "text", text: "a" }, { type: "image" }, { text: "b" }, { text: 3 }])).toBe("a\nb")
    expect(textOf(null)).toBe("")
    expect(textOf(undefined)).toBe("")
    expect(ToolResult.text({ id: "r", content: [Part.Text("x"), Part.Text("y")], isError: false })).toBe("x\ny")
  })

  it("only data URLs with base64 are read as inline media", () => {
    expect(Media.fromUrl("data:text/plain,hi").source).toEqual(Source.Url("data:text/plain,hi"))
    expect(Media.fromUrl("data:;base64,AA")).toEqual({ mediaType: "", source: Source.Base64("AA"), name: undefined })
  })
})
