import { describe, expect, it } from "bun:test"

import { Timestamp } from "@slopmax/common"

import {
  type Limits,
  Limits as L,
  LimitsSchema,
  PoolWindow,
  parseF64,
  parseTime,
  pooled,
  pooledBy,
  retryAfter,
  spanFor,
  UNKNOWN_SCORE,
  Urgency,
  Window,
} from "../src/limits.ts"
import { Schema } from "effect"

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

describe("limits", () => {
  it("elapsed_windows_start_over", () => {
    let limits: Limits = { windows: [Window.make("5h", 100.0, ts(500))] }
    expect(L.isExhausted(limits, ts(400))).toBe(true)
    expect(L.exhaustedUntil(limits, ts(400))).toBe(ts(500))
    expect(L.isExhausted(limits, ts(600))).toBe(false)
    expect(L.score(limits, ts(600))).toBe(0.0)

    // A newer reading drops elapsed windows it does not mention.
    limits = L.merge(limits, { windows: [Window.make("7d", 10.0, undefined)], observedAt: ts(600) }, ts(600))
    expect(limits.windows.length).toBe(1)
    expect(limits.windows[0]?.span).toBe("7d")
  })

  it("pools_read_as_one_account", () => {
    const now = ts(1000)
    const account = (fiveHour: number, reset: number, week: number): Limits => ({
      windows: [Window.make("5h", fiveHour, ts(reset)), Window.make("7d", week, ts(90_000))],
      observedAt: now,
    })
    const busy = account(90.0, 4000, 60.0)
    const fresh = account(10.0, 2000, 20.0)
    const idle = account(0.0, 1500, 0.0)
    let pool = pooled(
      [
        [busy, false],
        [fresh, false],
        [idle, false],
      ],
      now,
    )
    expect(pool.length).toBe(2)
    expect(pool[0]?.span).toBe("5h")
    expect(Math.abs((pool[0]?.used ?? 0) - 100.0 / 3.0)).toBeLessThan(1e-9)
    // The soonest reset of a window in use; the idle one frees nothing.
    expect(pool[0]?.resetsAt).toBe(ts(2000))
    expect(Math.abs((pool[1]?.used ?? 0) - 80.0 / 3.0)).toBeLessThan(1e-9)
    expect(pool[0] && PoolWindow.minutes(pool[0])).toBe(300)
    expect(pool[1] && PoolWindow.minutes(pool[1])).toBe(10_080)

    // A blocked account counts as full in its shortest window.
    pool = pooled(
      [
        [fresh, true],
        [idle, false],
      ],
      now,
    )
    expect(pool[0]?.used).toBe(50.0)
    expect(pool[1]?.used).toBe(10.0)
    // Accounts never measured are left out.
    const unknown = L.empty()
    pool = pooled(
      [
        [busy, false],
        [unknown, false],
      ],
      now,
    )
    expect(pool[0]?.used).toBe(90.0)
    expect(pooled([[unknown, false]], now)).toEqual([])
    // Weighted, a large plan's usage counts for more.
    const weighted = pooledBy(
      [
        [busy, false, 0.8],
        [fresh, false, 0.2],
      ],
      now,
    )
    const plain = pooled(
      [
        [busy, false],
        [fresh, false],
      ],
      now,
    )
    expect(weighted[0]?.used ?? 0).toBeGreaterThan(plain[0]?.used ?? 0)
  })

  it("unknown_usage_scores_above_full", () => {
    expect(L.score(L.empty(), ts(0))).toBe(UNKNOWN_SCORE)
    expect(L.isExhausted(L.empty(), ts(0))).toBe(false)
  })

  it("a_window_lapses_once_its_reset_passes_or_a_new_period_shows", () => {
    const week = 7 * 86_400
    const old: Limits = {
      windows: [Window.make("5h", 30.0, ts(10_000)), Window.make("7d", 60.0, ts(50_000))],
      observedAt: ts(1_000),
    }
    // Before either reset, a reading of the same period lapses nothing.
    const same = L.observed([Window.make("7d", 61.0, ts(50_000))], ts(2_000))
    if (same === undefined) throw new Error("no reading")
    expect(L.lapsed(old, same, ts(2_000))).toEqual([])
    // The 5-hour window's time passed: it lapsed at 30% used.
    let lapsed = L.lapsed(old, same, ts(20_000))
    expect(lapsed.length).toBe(1)
    expect([lapsed[0]?.span, lapsed[0]?.used]).toEqual(["5h", 30.0])
    expect(lapsed[0]?.endedAt).toBe(ts(10_000))
    // A reading of next week's window shows this week's ended, even if the
    // clock says otherwise.
    const next = L.observed([Window.make("7d", 2.0, ts(50_000 + week))], ts(3_000))
    if (next === undefined) throw new Error("no reading")
    lapsed = L.lapsed(old, next, ts(3_000))
    expect(lapsed.length).toBe(1)
    expect([lapsed[0]?.span, lapsed[0]?.used]).toEqual(["7d", 60.0])
  })

  it("expiring_at_prefers_started_windows_with_headroom", () => {
    const threeDays = 1000 + 3 * 86_400
    const limits: Limits = { windows: [Window.make("5h", 40.0, ts(2000)), Window.make("7d", 60.0, ts(threeDays))] }
    expect(L.expiringAt(limits, ts(1000))).toBe(ts(2000))
    // A week with room left that ends within the day comes first.
    const ending: Limits = { windows: [Window.make("5h", 40.0, ts(2000)), Window.make("7d", 60.0, ts(9000))] }
    expect(L.expiringAt(ending, ts(1000))).toBe(ts(9000))
    expect(L.urgency(ending, ts(1000)).short).toBe(ts(2000))
    // With too little room left, a week ending is nothing to save.
    const spent: Limits = { windows: [Window.make("5h", 40.0, ts(2000)), Window.make("7d", 95.0, ts(9000))] }
    expect(L.urgency(spent, ts(1000)).weekEnding).toBeUndefined()
    expect(L.expiringAt(spent, ts(1000))).toBe(ts(2000))
    const idle: Limits = { windows: [Window.make("5h", 0.0, undefined)] }
    expect(L.expiringAt(idle, ts(1000))).toBeUndefined()
  })
})

describe("limits, beyond the Rust tests", () => {
  it("windows, spans, and merging keep the Rust's rules", () => {
    expect(Window.make("5h", 140, undefined).used).toBe(100)
    expect(Window.make("5h", -3, undefined).used).toBe(0)
    expect(Window.label({ span: "7d", model: "Fable", used: 1 })).toBe("7d Fable")
    expect([spanFor(3600), spanFor(86_400), spanFor(28 * 86_400 - 1), spanFor(28 * 86_400)]).toEqual([
      "5h",
      "7d",
      "7d",
      "30d",
    ])
    const merged = L.merge(
      { windows: [Window.make("7d", 1, ts(9_000))], resetCredits: 2 },
      { windows: [{ span: "7d", model: "Opus", used: 3 }, Window.make("5h", 4, ts(8_000))] },
      ts(100),
    )
    expect(merged.windows.map(Window.label)).toEqual(["5h", "7d", "7d Opus"])
    expect(merged.resetCredits).toBe(2)
    expect(merged.observedAt).toBeUndefined()
    // A full window without a reset counts only while the reading is fresh.
    const stale: Limits = { windows: [Window.make("5h", 100, undefined)], observedAt: ts(0) }
    expect(L.isExhausted(stale, ts(299))).toBe(true)
    expect(L.isExhausted(stale, ts(300))).toBe(false)
    expect(Urgency.key({ weekEnding: undefined, short: ts(5), long: undefined })).toEqual([
      Timestamp.MAX,
      ts(5),
      Timestamp.MAX,
    ])
  })

  it("headers and times parse as the Rust parses them", () => {
    const headers = new Headers({ "retry-after": " 2.5 ", "x-date": "Sun, 06 Nov 1994 08:49:37 GMT" })
    expect(retryAfter(headers, ts(100))).toBe(ts(100) + 2500)
    expect(retryAfter(new Headers({ "retry-after": "-4" }), ts(100))).toBe(ts(100))
    expect(retryAfter(new Headers({ "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }), ts(0))).toBe(784111777000)
    expect(retryAfter(new Headers(), ts(0))).toBeUndefined()
    expect([parseF64("1e3"), parseF64(".5"), parseF64("5."), parseF64("0x10"), parseF64("")]).toEqual([
      1000,
      0.5,
      5,
      undefined,
      undefined,
    ])
    expect(parseTime("2026-10-01T00:00:00+02:00")).toBe(Date.UTC(2026, 8, 30, 22))
    expect(parseTime(1_700_000_000.9)).toBe(ts(1_700_000_000))
    expect(parseTime(true)).toBeUndefined()
  })

  it("limits on disk omit what is absent and write floats as serde_json does", () => {
    const encoded = Schema.encodeSync(LimitsSchema)({
      windows: [Window.make("5h", 40, ts(10))],
      observedAt: ts(5),
    })
    expect(JSON.stringify(encoded)).toBe(
      '{"windows":[{"span":"5h","used":40.0,"resets_at":"1970-01-01T00:00:10Z"}],"observed_at":"1970-01-01T00:00:05Z"}',
    )
    expect(Schema.decodeUnknownSync(LimitsSchema)({})).toEqual({ windows: [] })
  })
})
