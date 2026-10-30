import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { compact, duration, until } from "../src/human.ts"
import { SignedDuration, Timestamp } from "../src/time.ts"

const at = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? Timestamp.UNIX_EPOCH
const bySecs = (s: number) => duration(SignedDuration.fromSecs(s))
const byMillis = (ms: number) => duration(SignedDuration.fromMillis(ms))

describe("human (Rust tests)", () => {
  it("durations_use_two_units", () => {
    const f = bySecs
    expect(f(42)).toBe("42s")
    expect(f(9 * 60 + 30)).toBe("9m30s")
    expect(f(2 * 3600 + 5 * 60 + 59)).toBe("2h05m")
    expect(f(3 * 86_400 + 4 * 3600 + 120)).toBe("3d4h")
    expect(f(-5)).toBe("0s")
  })

  it("until_reports_now_when_passed", () => {
    const now = at(1_000)
    expect(until(at(900), now)).toBe("now")
    expect(until(at(1_090), now)).toBe("1m30s")
  })

  it("counts_keep_three_figures", () => {
    expect(compact(999)).toBe("999")
    expect(compact(12_345)).toBe("12.3k")
    expect(compact(1_234_567)).toBe("1.2M")
    expect(compact(5_000_000_000)).toBe("5.0B")
  })
})

describe("human (contract details)", () => {
  it("durations drop units below the two shown and pad the second", () => {
    const f = byMillis
    expect(f(0)).toBe("0s")
    expect(f(999)).toBe("0s")
    expect(f(-1_500)).toBe("0s")
    expect(f(60_000)).toBe("1m00s")
    expect(f(3_600_000)).toBe("1h00m")
    expect(f(86_400_000)).toBe("1d0h")
    expect(f(86_400_000 * 400 + 3_600_000 * 23)).toBe("400d23h")
    expect(until(at(1_000), at(1_000))).toBe("now")
    expect(until(Timestamp.add(at(1_000), 500), at(1_000))).toBe("0s")
  })

  it("counts round half to even at one decimal", () => {
    // 1.25 and 2.25 are exact in binary, so these are real ties.
    expect(compact(1_250)).toBe("1.2k")
    expect(compact(1_350)).toBe("1.4k")
    expect(compact(2_250_000)).toBe("2.2M")
    expect(compact(1_000)).toBe("1.0k")
    expect(compact(999_999)).toBe("1000.0k")
    expect(compact(0)).toBe("0")
  })
})
