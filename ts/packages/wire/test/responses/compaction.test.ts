import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { open, PREFIX, PROMPT, seal } from "../../src/responses/compaction.ts"

describe("responses::compaction (Rust tests)", () => {
  it("seals_round_trip_and_ignore_openais", () => {
    const sealed = seal("Fixed the bug in a.rs; tests pass.")
    expect(sealed.startsWith("slopmax1:")).toBe(true)
    expect(open(sealed)).toBe("Fixed the bug in a.rs; tests pass.")
    expect(open("gAAAAABencrypted")).toBeUndefined()
  })
})

describe("responses::compaction (contract details)", () => {
  it("seals are standard padded base64, read as strictly as the Rust reads them", () => {
    expect(seal("é")).toBe("slopmax1:w6k=")
    expect(open("slopmax1:w6k=")).toBe("é")
    expect(open("slopmax1:")).toBe("")
    expect(open("slopmax1:w6k")).toBeUndefined() // padding required
    expect(open("slopmax1:w6l=")).toBeUndefined() // stray bits in the last symbol
    expect(open("slopmax1:w6k=\n")).toBeUndefined()
    expect(open("slopmax1:_-8=")).toBeUndefined() // URL-safe alphabet
    expect(open("slopmax1:/w==")).toBeUndefined() // not UTF-8
  })

  it("the prompt and the prefix read as the Rust's line continuations collapse them", () => {
    expect(PROMPT).toBe(
      "Summarize this conversation so that another assistant can continue the task without it. Include the goal and the user's instructions, what has been done (files read or changed, commands run, and what they showed), decisions made, and what remains to do. Write only the summary.",
    )
    expect(PREFIX).toBe("The conversation so far was compacted into this summary. Continue the task from it:")
  })
})
