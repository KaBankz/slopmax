import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@slopmax/test"

import {
  debug,
  debug32,
  debugDuration,
  display,
  display32,
  fixed,
  json,
  json32,
  lowerExp,
  zeroPad,
} from "../src/fmt.ts"

// Every expected string below was printed by rustc 1.99 and serde_json 1.0.151.
describe("fmt", () => {
  it("debugDuration prints {:?} of a Duration", () => {
    expect(debugDuration(0n)).toBe("0ns")
    expect(debugDuration(999n)).toBe("999ns")
    expect(debugDuration(10_000n)).toBe("10µs")
    expect(debugDuration(1_500n)).toBe("1.5µs")
    expect(debugDuration(100_000_000n)).toBe("100ms")
    expect(debugDuration(1_000_001n)).toBe("1.000001ms")
    expect(debugDuration(600_000_000_000n)).toBe("600s")
    expect(debugDuration(1_500_000_000n)).toBe("1.5s")
    expect(debugDuration(1_000_000_001n)).toBe("1.000000001s")
  })

  it("fixed rounds the exact value half to even, as {:.N}", () => {
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      [0.125, 2, "0.12"],
      [0.375, 2, "0.38"],
      [-0.125, 2, "-0.12"],
      [-0.125, 0, "-0"],
      [0.5, 0, "0"],
      [1.5, 0, "2"],
      [2.5, 0, "2"],
      [-2.5, 0, "-2"],
      [0.15, 1, "0.1"],
      [0.25, 1, "0.2"],
      [1.005, 2, "1.00"],
      [2.675, 2, "2.67"],
      [12.345, 2, "12.35"],
      [0.045, 2, "0.04"],
      [-0.04, 1, "-0.0"],
      [-0.05, 1, "-0.1"],
      [0.05, 1, "0.1"],
      [0.95, 1, "0.9"],
      [99.95, 1, "100.0"],
      [999.95, 1, "1000.0"],
      [1234.5, 0, "1234"],
      [1235.5, 0, "1236"],
      [9.5, 0, "10"],
      [25, 1, "25.0"],
      [1.25e22, 0, "12499999999999998951424"],
      [1e21, 1, "1000000000000000000000.0"],
      [-0, 1, "-0.0"],
      [0, 2, "0.00"],
      [5e-324, 3, "0.000"],
      [Number.NaN, 1, "NaN"],
      [Infinity, 1, "inf"],
      [-Infinity, 0, "-inf"],
    ]
    for (const [x, places, want] of cases) expect(fixed(x, places), `${x} to ${places}`).toBe(want)
  })

  it("display prints the shortest digits without an exponent, as {}", () => {
    expect(display(25)).toBe("25")
    expect(display(0)).toBe("0")
    expect(display(-0)).toBe("-0")
    expect(display(0.1 + 0.2)).toBe("0.30000000000000004")
    expect(display(1e16)).toBe("10000000000000000")
    expect(display(1e21)).toBe("1000000000000000000000")
    expect(display(1e-7)).toBe("0.0000001")
    expect(display(-2.5)).toBe("-2.5")
    expect(display(1.7976931348623157e308)).toBe(`17976931348623157${"0".repeat(292)}`)
    expect(display(Number.NaN)).toBe("NaN")
    expect(display(-Infinity)).toBe("-inf")
  })

  it("debug keeps a decimal point and switches to exponents outside [1e-4, 1e16), as {:?}", () => {
    expect(debug(25)).toBe("25.0")
    expect(debug(0)).toBe("0.0")
    expect(debug(-0)).toBe("-0.0")
    expect(debug(30)).toBe("30.0")
    expect(debug(1e15)).toBe("1000000000000000.0")
    expect(debug(1e16)).toBe("1e16")
    expect(debug(1.5e16)).toBe("1.5e16")
    expect(debug(1e-4)).toBe("0.0001")
    expect(debug(1e-5)).toBe("1e-5")
    expect(debug(1.5e-5)).toBe("1.5e-5")
    expect(debug(5e-324)).toBe("5e-324")
    expect(debug(Infinity)).toBe("inf")
  })

  it("lowerExp prints {:e}", () => {
    expect(lowerExp(25)).toBe("2.5e1")
    expect(lowerExp(100)).toBe("1e2")
    expect(lowerExp(0)).toBe("0e0")
    expect(lowerExp(-1)).toBe("-1e0")
    expect(lowerExp(0.1 + 0.2)).toBe("3.0000000000000004e-1")
  })

  it("json prints floats as serde_json does", () => {
    expect(json(25)).toBe("25.0")
    expect(json(0)).toBe("0.0")
    expect(json(-0)).toBe("-0.0")
    expect(json(1e15)).toBe("1000000000000000.0")
    expect(json(1e16)).toBe("1e+16")
    expect(json(12345678901234568)).toBe("1.2345678901234568e+16")
    expect(json(1e-5)).toBe("0.00001")
    expect(json(1e-6)).toBe("1e-6")
    expect(json(1.5e-7)).toBe("1.5e-7")
    expect(json(5e-324)).toBe("5e-324")
    expect(json(Number.NaN)).toBe("null")
    expect(json(Infinity)).toBe("null")
  })

  it("f32 values print with f32's shortest digits", () => {
    expect(json32(1 / 3)).toBe("0.33333334")
    expect(debug32(0.8333333)).toBe("0.8333333")
    expect(json32(0.1)).toBe("0.1")
    expect(json32(25)).toBe("25.0")
    expect(json32(-0)).toBe("-0.0")
    expect(json32(1e12)).toBe("1000000000000.0")
    expect(json32(1e13)).toBe("1e+13")
    expect(json32(1.5e13)).toBe("1.5e+13")
    expect(json32(1e-6)).toBe("0.000001")
    expect(json32(1e-7)).toBe("1e-7")
    expect(json32(3.4028235e38)).toBe("3.4028235e+38")
    expect(display32(123456789)).toBe("123456790")
    expect(display32(3.4028235e38)).toBe("340282350000000000000000000000000000000")
    expect(display32(16777217)).toBe("16777216")
    expect(debug32(1e-45)).toBe("1e-45")
    expect(debug32(1e7)).toBe("10000000.0")
  })

  it("zeroPad counts the sign in the width, as {:0W}", () => {
    expect(zeroPad(5, 2)).toBe("05")
    expect(zeroPad(-5, 3)).toBe("-05")
    expect(zeroPad(2026, 4)).toBe("2026")
    expect(zeroPad(123, 2)).toBe("123")
  })

  it("matches Rust on the generated golden values", () => {
    const view = new DataView(new ArrayBuffer(8))
    const rows = readFileSync(join(import.meta.dir, "fixtures", "fmt-golden.tsv"), "utf8")
      .trim()
      .split("\n")
    expect(rows.length).toBeGreaterThan(700)
    for (const row of rows) {
      const [kind, bits = "", ...want] = row.split("\t")
      if (kind === "f64") {
        view.setBigUint64(0, BigInt(bits))
        const x = view.getFloat64(0)
        const got = [display(x), debug(x), json(x), fixed(x, 0), fixed(x, 1), fixed(x, 2), fixed(x, 3), lowerExp(x)]
        expect(got, `f64 ${x}`).toEqual(want)
      } else {
        view.setUint32(0, Number(bits))
        const x = view.getFloat32(0)
        expect([display32(x), debug32(x), json32(x), fixed(x, 1)], `f32 ${x}`).toEqual(want)
      }
    }
  })
})
