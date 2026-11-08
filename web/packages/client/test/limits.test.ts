import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Option, Schema } from "effect"
import { longWindow, scopedWindows, upcomingReset, usedAt, Window, windowLabel, windowOf } from "../src/index.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
describe("Window", () => {
  it("clamps a provider's reading to 0–100 and starts over once its reset passes", () => {
    expect(Window.of("5h", 140).used).toBe(100)
    expect(Window.of("5h", -3).used).toBe(0)
    const window = Window.of("5h", 40, ts(500))
    expect(usedAt(window, ts(499))).toBe(40)
    expect(usedAt(window, ts(500))).toBe(0)
    expect(upcomingReset(window, ts(499))).toEqual(Option.some(ts(500)))
    expect(upcomingReset(window, ts(500))).toEqual(Option.none())
  })

  it("is labelled by its span, and its model when it covers one", () => {
    expect(windowLabel(Window.of("5h", 1))).toBe("5h")
    expect(windowLabel(Window.of("7d", 1, undefined, "Fable"))).toBe("7d Fable")
  })

  it("hands out the window it made before for the same reading, and a new one when anything differs", () => {
    const first = Window.of("5h", 21, ts(9000))
    expect(Window.of("5h", 21, ts(9000))).toBe(first)
    expect(Window.of("5h", 21.5, ts(9000))).not.toBe(first)
    expect(Window.of("5h", 21, ts(9001))).not.toBe(first)
    expect(Window.of("5h", 21, ts(9000), "opus")).not.toBe(first)
    expect(Window.of("7d", 21, ts(9000))).not.toBe(first)
  })

  it("refuses a reading over 100 percent in a file", () => {
    expect(() => Schema.decodeUnknownSync(Window)({ span: "5h", used: 101 })).toThrow()
  })
})

describe("Limits", () => {
  it("finds windows by span and scope", () => {
    const windows = [Window.of("5h", 10), Window.of("7d", 80, undefined, "opus"), Window.of("30d", 30)]
    expect(windowOf(windows, "5h")?.used).toBe(10)
    // The model's own weekly window is not the shared one.
    expect(windowOf(windows, "7d")).toBeUndefined()
    expect(longWindow(windows)?.span).toBe("30d")
    expect(scopedWindows(windows).map((w) => w.model)).toEqual(["opus"])
  })
})

describe("pooled", () => {})
