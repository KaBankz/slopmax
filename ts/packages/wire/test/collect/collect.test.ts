import { describe, expect } from "bun:test"
import { Usage } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { collect, common, onlyFailed, stopOf } from "../../src/index.ts"
import { answer } from "../common/fixtures.ts"

const { Event } = common

const call: common.ToolCall = { id: "c1", name: "Bash", input: "{}", kind: "function" }
const usage = new Usage({ requests: 1, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 })

describe("collect", () => {
  it("joins the text and reasoning, keeps every call, and infers tool use from the calls", () => {
    const gathered = collect([
      Event.Reasoning({ text: "Look " }),
      Event.Text({ text: "Let me " }),
      Event.State({ state: "gAAA" }),
      Event.Reasoning({ text: "around." }),
      Event.Text({ text: "look." }),
      Event.Call({ call }),
      Event.Done({ stop: "end", usage }),
    ])
    expect(gathered).toEqual({
      text: "Let me look.",
      reasoning: "Look around.",
      calls: [call],
      stop: "end",
      usage,
      failure: undefined,
    })
    expect(stopOf(gathered)).toBe("toolUse")
  })

  it("keeps the last end and the last failure it saw", () => {
    const gathered = collect([
      Event.Failed({ failure: { status: 500, message: "first" } }),
      Event.Done({ stop: "length", usage: Usage.zero }),
      Event.Done({ stop: "filtered", usage }),
      Event.Failed({ failure: { status: 529, message: "last" } }),
    ])
    expect(gathered.stop).toBe("filtered")
    expect(gathered.usage).toEqual(usage)
    expect(gathered.failure).toEqual({ status: 529, message: "last" })
  })

  it("says an answer ended when it never said why, unless it made calls", () => {
    expect(stopOf(answer({}))).toBe("end")
    expect(stopOf(answer({ calls: [call] }))).toBe("toolUse")
    expect(stopOf(answer({ calls: [call], stop: "length" }))).toBe("length")
  })

  it("counts an answer as only a failure when nothing was said before it", () => {
    const failure = { status: 502, message: "cut" }
    expect(onlyFailed(answer({ failure }))).toBe(true)
    expect(onlyFailed(answer({ failure, text: "partial" }))).toBe(false)
    expect(onlyFailed(answer({ failure, calls: [call] }))).toBe(false)
    expect(onlyFailed(answer({}))).toBe(false)
  })
})
