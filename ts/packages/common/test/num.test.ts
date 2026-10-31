import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { round, totalCmp } from "../src/num.ts"

describe("num, beyond the Rust tests", () => {
  it("round sends halves away from zero", () => {
    expect(round(2.5)).toBe(3)
    expect(round(-2.5)).toBe(-3)
    expect(round(0.49999999999999994)).toBe(0)
    expect(round(-0.4)).toBe(-0)
  })

  it("totalCmp orders NaN last and -0 before +0", () => {
    expect([1, Number.NaN, -0, 0, -1].toSorted(totalCmp)).toEqual([-1, -0, 0, 1, Number.NaN])
    expect(Object.is([0, -0].toSorted(totalCmp)[0], -0)).toBe(true)
    expect(totalCmp(Number.NaN, Number.NaN)).toBe(0)
  })
})
