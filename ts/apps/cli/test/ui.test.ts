import { describe, expect, it } from "bun:test"

import { bar, pad, setColor, visibleWidth } from "../src/ui.ts"

describe("ui", () => {
  it("visible_width_ignores_escapes", () => {
    expect(visibleWidth("\x1b[31mabc\x1b[0m")).toBe(3)
    expect(pad("\x1b[1mab\x1b[0m", 4)).toBe("\x1b[1mab\x1b[0m  ")
  })

  it("bar_fills_proportionally", () => {
    expect(visibleWidth(bar(50.0, 10))).toBe(10)
    expect(bar(50.0, 10)).toContain("█████░░░░░")
    expect(bar(250.0, 4)).toContain("████")
  })
})

describe("ui, beyond the Rust tests", () => {
  it("colors only when told to, with the Rust's codes", () => {
    expect(bar(95, 2)).toBe("██")
    setColor(true)
    try {
      expect(bar(95, 2)).toBe("\x1b[31m██\x1b[0m")
      expect(bar(75, 2)).toBe("\x1b[33m██\x1b[0m")
      expect(bar(10, 2)).toBe("\x1b[32m░░\x1b[0m")
    } finally {
      setColor(false)
    }
  })

  it("counts characters, not UTF-16 units", () => {
    expect(visibleWidth("😀é")).toBe(2)
    expect(pad("😀", 3)).toBe("😀  ")
    // Half rounds away from zero, as `f64::round` does.
    expect(bar(25, 2)).toBe("█░")
    expect(bar(Number.NaN, 3)).toBe("░░░")
  })
})
