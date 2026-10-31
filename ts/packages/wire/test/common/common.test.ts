import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Option, Schema } from "effect"
import { common } from "../../src/index.ts"

describe("media", () => {
  it("writes inline media as a data URL and reads data URLs back as inline media", () => {
    const media = common.mediaFromUrl("data:image/png;base64,iVBOR")
    expect(media.mediaType).toBe("image/png")
    expect(media.source).toEqual({ _tag: "Inline", data: "iVBOR" })
    expect(common.mediaUrl(media)).toBe("data:image/png;base64,iVBOR")
  })

  it("keeps any other URL as a link with no known type", () => {
    const remote = common.mediaFromUrl("https://x.dev/a.png", "a.png")
    expect(remote).toEqual({ mediaType: "", source: { _tag: "Link", url: "https://x.dev/a.png" }, name: "a.png" })
    expect(common.mediaUrl(remote)).toBe("https://x.dev/a.png")
  })
})

describe("effort", () => {
  it("maps thinking budgets to efforts: under 4096 low, under 16384 medium, else high", () => {
    expect([0, 1_024, 4_095, 4_096, 10_000, 16_383, 16_384, 31_999].map(common.effortForBudget)).toEqual([
      "low",
      "low",
      "low",
      "medium",
      "medium",
      "medium",
      "high",
      "high",
    ])
  })

  it("reads each format's names for effort, none as the lightest and xhigh as the most", () => {
    expect(["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(common.effortNamed)).toEqual([
      "minimal",
      "minimal",
      "low",
      "medium",
      "high",
      "max",
      "max",
    ])
    expect(common.effortNamed("turbo")).toBeUndefined()
  })
})

const call = (input: string, kind: common.ToolKind): common.ToolCall => ({ id: "c", name: "t", input, kind })

describe("tool calls", () => {
  it("sends a freeform call's text as {input} and an empty function call as {}", () => {
    expect(common.callArguments(call("*** Begin Patch", "freeform"))).toBe('{"input":"*** Begin Patch"}')
    expect(common.callArguments(call("  ", "function"))).toBe("{}")
    expect(common.callArguments(call('{"a":1}', "function"))).toBe('{"a":1}')
  })

  it("unwraps a freeform call's text, and keeps arguments of any other shape as they are", () => {
    expect(common.unwrapFreeform('{"input":"*** Begin Patch"}')).toBe("*** Begin Patch")
    expect(common.unwrapFreeform('{"patch":"x"}')).toBe('{"patch":"x"}')
    expect(common.unwrapFreeform("raw text")).toBe("raw text")
  })

  it("joins a tool result's text one piece per line and marks errors that say something", () => {
    const result: common.ResultOf = {
      _tag: "Result",
      callId: "c",
      content: [
        { _tag: "Text", text: "a.rs" },
        { _tag: "Image", media: common.mediaFromUrl("data:image/png;base64,x") },
        { _tag: "Text", text: "b.rs" },
      ],
      isError: true,
    }
    expect(common.resultText(result)).toBe("a.rs\nb.rs")
    expect(common.resultOutput(result)).toBe("Error: a.rs\nb.rs")
    expect(common.resultOutput({ ...result, content: [] })).toBe("")
  })
})

describe("lenient reading", () => {
  const Shape = Schema.Struct({
    model: common.field(Schema.String),
    count: common.field(common.Count),
    items: common.field(common.listOf(Schema.Struct({ name: Schema.String }))),
  })
  const read = Schema.decodeUnknownSync(Shape)

  it("reads a field of the wrong kind, or null, as absent instead of failing", () => {
    expect(read({ model: 7, count: null })).toEqual({})
    expect(read({ model: "m", count: -1 })).toEqual({ model: "m" })
    expect(read({ count: 3, unknown: true })).toEqual({ count: 3 })
  })

  it("drops the items of a list that do not fit and keeps the rest", () => {
    expect(read({ items: [{ name: "a" }, 5, { other: 1 }, { name: "b" }] })).toEqual({
      items: [{ name: "a" }, { name: "b" }],
    })
  })
})

describe("randomToken", () => {
  it("makes 43-character URL-safe tokens that differ each time", () => {
    const one = common.randomToken()
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(common.randomToken()).not.toBe(one)
  })
})

describe("Event", () => {
  it("is a tagged value that compares by content", () => {
    const text = common.Event.Text({ text: "hi" })
    expect(text._tag).toBe("Text")
    expect(common.Event.$is("Text")(text)).toBe(true)
    expect(Option.some(text)).toEqual(Option.some(common.Event.Text({ text: "hi" })))
  })
})
