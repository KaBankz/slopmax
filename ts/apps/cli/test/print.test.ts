import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { bar, cut, ellipsis, padEnd, padStart, paint, plural, visibleWidth } from "../src/print.ts"

describe("print", () => {
  const colored = paint(true)
  const plain = paint(false)

  it("measures what the eye sees, ignoring color escapes and counting each character once", () => {
    expect(visibleWidth(colored.bold("hello"))).toBe(5)
    expect(visibleWidth(`${colored.red("a")}${colored.dim("bc")}`)).toBe(3)
    expect(visibleWidth("—█░")).toBe(3)
    expect(visibleWidth("👍")).toBe(1)
    expect(padEnd(colored.green("ok"), 5)).toBe(`${colored.green("ok")}   `)
    expect(padStart(colored.green("ok"), 4)).toBe(`  ${colored.green("ok")}`)
  })

  it("fills a bar in proportion to the percent, clamped to its width", () => {
    expect(bar(0, 10, "good", plain)).toBe("░░░░░░░░░░")
    expect(bar(50, 10, "good", plain)).toBe("█████░░░░░")
    expect(bar(100, 10, "bad", plain)).toBe("██████████")
    expect(bar(250, 4, "bad", plain)).toBe("████")
    expect(bar(-5, 4, "good", plain)).toBe("░░░░")
    expect(bar(50, 4, "warn", colored)).toBe("\x1b[33m██░░\x1b[0m")
  })

  it("writes styles only when colors are on", () => {
    expect(plain.bold("x")).toBe("x")
    expect(colored.bold("x")).toBe("\x1b[1mx\x1b[0m")
    expect(colored.dim("x")).toBe("\x1b[2mx\x1b[0m")
    expect(colored.tone("accent", "x")).toBe("\x1b[36mx\x1b[0m")
    expect(colored.tone("muted", "x")).toBe(colored.dim("x"))
  })

  it("cuts text by character, marking a cut with an ellipsis when asked", () => {
    expect(cut("héllo wörld", 5)).toBe("héllo")
    expect(cut("short", 10)).toBe("short")
    expect(ellipsis("gpt-*, codex-*, o1*", 10)).toBe("gpt-*, co…")
    expect(ellipsis("gpt-*", 10)).toBe("gpt-*")
  })

  it("says counts in words", () => {
    expect(plural(1, "account")).toBe("1 account")
    expect(plural(3, "account")).toBe("3 accounts")
  })
})
