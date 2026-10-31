import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { common, Compaction } from "../../src/index.ts"

describe("Compaction", () => {
  it("seals a summary so it opens again, and opens nothing it did not seal", () => {
    const sealed = Compaction.seal("Fixed the bug in a.rs; tests pass. ✓")
    expect(sealed).toStartWith("slopmax1:")
    expect(sealed).toBe(`slopmax1:${btoa(unescape(encodeURIComponent("Fixed the bug in a.rs; tests pass. ✓")))}`)
    expect(Compaction.open(sealed)).toBe("Fixed the bug in a.rs; tests pass. ✓")
    expect(Compaction.open("gAAAAABencrypted")).toBeUndefined()
    expect(Compaction.open("slopmax1:!!!not base64")).toBeUndefined()
    expect(Compaction.open(`slopmax1:${btoa("\xff\xfe")}`)).toBeUndefined()
  })

  it("asks the model for the summary in plain words, and brings the summary back under a heading", () => {
    expect(Compaction.prompt).toBe(
      "Summarize this conversation so that another assistant can continue the task without it. Include the goal and the user's instructions, what has been done (files read or changed, commands run, and what they showed), decisions made, and what remains to do. Write only the summary.",
    )
    expect(Compaction.reopened("S.")).toBe(
      "The conversation so far was compacted into this summary. Continue the task from it:\n\nS.",
    )
  })

  it("asks for the summary as the last user turn, with no tools to call", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      compact: true,
      toolChoice: { _tag: "Required" },
      messages: [{ role: "user", parts: [{ _tag: "Text", text: "fix a.rs" }] }],
    }
    const summary = Compaction.summaryRequest(request)
    expect(summary.messages).toEqual([
      { role: "user", parts: [{ _tag: "Text", text: "fix a.rs" }] },
      { role: "user", parts: [{ _tag: "Text", text: Compaction.prompt }] },
    ])
    expect(summary.toolChoice).toEqual({ _tag: "None" })
    expect(request.messages).toHaveLength(1)
  })
})
