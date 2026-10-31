import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Array, DateTime, Option, Schema } from "effect"
import {
  exhaustedUntil,
  expiringAt,
  isExhausted,
  lapsed,
  Limits,
  longWindow,
  merge,
  observed,
  pooled,
  score,
  scopedWindows,
  spanFor,
  spanMinutes,
  unknownScore,
  upcomingReset,
  urgency,
  urgencyOrder,
  usedAt,
  Window,
  windowLabel,
  windowOf,
} from "../src/index.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const limitsOf = (windows: ReadonlyArray<Window>, observedAt?: DateTime.Utc) =>
  new Limits({ windows, ...(observedAt === undefined ? {} : { observedAt }) })

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

  it("is named by its length so plan changes keep the split", () => {
    expect(spanFor(18_000)).toBe("5h")
    expect(spanFor(86_399)).toBe("5h")
    expect(spanFor(86_400)).toBe("7d")
    expect(spanFor(27 * 86_400)).toBe("7d")
    expect(spanFor(28 * 86_400)).toBe("30d")
    expect([spanMinutes("5h"), spanMinutes("7d"), spanMinutes("30d")]).toEqual([300, 10_080, 43_200])
  })

  it("leaves out the model and the reset in JSON when it has none", () => {
    expect(Schema.encodeSync(Window)(Window.of("5h", 10))).toEqual({ span: "5h", used: 10 })
    expect(Schema.decodeUnknownSync(Limits)({})).toEqual(Limits.empty)
  })

  it("refuses a reading over 100 percent in a file", () => {
    expect(() => Schema.decodeUnknownSync(Window)({ span: "5h", used: 101 })).toThrow()
  })
})

describe("Limits", () => {
  it("lets elapsed windows start over", () => {
    let limits = limitsOf([Window.of("5h", 100, ts(500))])
    expect(isExhausted(limits, ts(400))).toBe(true)
    expect(exhaustedUntil(limits, ts(400))).toEqual(Option.some(ts(500)))
    expect(isExhausted(limits, ts(600))).toBe(false)
    expect(score(limits, ts(600))).toBe(0)
    // A newer reading drops elapsed windows it does not mention.
    limits = merge(limits, limitsOf([Window.of("7d", 10)], ts(600)), ts(600))
    expect(limits.windows.map((w) => w.span)).toEqual(["7d"])
  })

  it("scores unknown usage above full, and never counts it as exhausted", () => {
    expect(score(Limits.empty, ts(0))).toBe(unknownScore)
    expect(score(undefined, ts(0))).toBe(101)
    expect(isExhausted(Limits.empty, ts(0))).toBe(false)
  })

  it("scores the fullest shared window, ignoring windows for one model", () => {
    const limits = limitsOf([Window.of("5h", 30), Window.of("7d", 55), Window.of("7d", 99, undefined, "opus")])
    expect(score(limits, ts(0))).toBe(55)
  })

  it("merges a newer reading by slot, sorted by span then model, keeping credits it does not report", () => {
    const older = new Limits({
      windows: [Window.of("7d", 50, ts(9_000)), Window.of("5h", 20, ts(900)), Window.of("7d", 70, undefined, "opus")],
      observedAt: ts(100),
      resetCredits: 2,
    })
    const newer = limitsOf([Window.of("5h", 30, ts(5_000))], ts(1_000))
    const merged = merge(older, newer, ts(1_000))
    expect(merged.windows.map((w) => [w.span, w.used, w.model])).toEqual([
      ["5h", 30, undefined],
      ["7d", 50, undefined],
      ["7d", 70, "opus"],
    ])
    expect(merged.observedAt).toEqual(ts(1_000))
    expect(merged.resetCredits).toBe(2)
    expect(merge(merged, new Limits({ windows: [], resetCredits: 0 }), ts(1_000)).resetCredits).toBe(0)
    expect(merge(undefined, newer, ts(1_000)).windows).toEqual(newer.windows)
  })

  it("reads a reading as observed only when it has windows", () => {
    expect(observed([], ts(1))).toEqual(Option.none())
    expect(Option.map(observed([Window.of("5h", 1)], ts(1)), (l) => l.observedAt)).toEqual(Option.some(ts(1)))
  })

  it("says a window lapsed once its reset passes or a new period shows", () => {
    const week = 7 * 86_400
    const old = limitsOf([Window.of("5h", 30, ts(10_000)), Window.of("7d", 60, ts(50_000))], ts(1_000))
    // Before either reset, a reading of the same period lapses nothing.
    const same = Option.getOrThrow(observed([Window.of("7d", 61, ts(50_000))], ts(2_000)))
    expect(lapsed(old, same, ts(2_000))).toEqual([])
    // The 5-hour window's time passed: it lapsed at 30% used.
    expect(lapsed(old, same, ts(20_000))).toEqual([{ span: "5h", used: 30, endedAt: ts(10_000) }])
    // A reading of next week's window shows this week ended, whatever the clock says.
    const next = Option.getOrThrow(observed([Window.of("7d", 2, ts(50_000 + week))], ts(3_000)))
    expect(lapsed(old, next, ts(3_000))).toEqual([{ span: "7d", used: 60, endedAt: ts(50_000) }])
    expect(lapsed(undefined, next, ts(3_000))).toEqual([])
  })

  it("counts a full window without a reset only while the reading is fresh", () => {
    const limits = limitsOf([Window.of("7d", 100)], ts(1_000))
    expect(isExhausted(limits, ts(1_000 + 299))).toBe(true)
    expect(exhaustedUntil(limits, ts(1_000 + 299))).toEqual(Option.none())
    expect(isExhausted(limits, ts(1_000 + 300))).toBe(false)
  })

  it("is limited until the latest reset of its full windows, and a model's own window stops only that model", () => {
    const limits = limitsOf(
      [Window.of("5h", 100, ts(2_000)), Window.of("7d", 100, ts(9_000)), Window.of("7d", 100, ts(5_000), "opus")],
      ts(1_000),
    )
    expect(exhaustedUntil(limits, ts(1_000))).toEqual(Option.some(ts(9_000)))
    const opus = limitsOf([Window.of("7d", 100, ts(5_000), "opus")], ts(1_000))
    expect(isExhausted(opus, ts(1_000))).toBe(false)
    expect(isExhausted(opus, ts(1_000), "opus")).toBe(true)
    expect(exhaustedUntil(opus, ts(1_000), "opus")).toEqual(Option.some(ts(5_000)))
  })

  it("expires spare capacity first in started windows with headroom", () => {
    const threeDays = 1_000 + 3 * 86_400
    expect(
      expiringAt(limitsOf([Window.of("5h", 40, ts(2_000)), Window.of("7d", 60, ts(threeDays))]), ts(1_000)),
    ).toEqual(Option.some(ts(2_000)))
    // A week with room left that ends within the day comes first.
    const ending = limitsOf([Window.of("5h", 40, ts(2_000)), Window.of("7d", 60, ts(9_000))])
    expect(expiringAt(ending, ts(1_000))).toEqual(Option.some(ts(9_000)))
    expect(urgency(ending, ts(1_000)).short).toEqual(Option.some(ts(2_000)))
    // With too little room left, a week ending is nothing to save.
    const spent = limitsOf([Window.of("5h", 40, ts(2_000)), Window.of("7d", 95, ts(9_000))])
    expect(urgency(spent, ts(1_000)).weekEnding).toEqual(Option.none())
    expect(expiringAt(spent, ts(1_000))).toEqual(Option.some(ts(2_000)))
    expect(expiringAt(limitsOf([Window.of("5h", 0)]), ts(1_000))).toEqual(Option.none())
    // The most urgent sorts first; nothing known sorts last.
    const short = limitsOf([Window.of("5h", 40, ts(2_000)), Window.of("7d", 60, ts(threeDays))])
    const unknown = urgency(undefined, ts(1_000))
    const sorted = Array.sort([unknown, urgency(short, ts(1_000)), urgency(ending, ts(1_000))], urgencyOrder)
    expect(sorted).toEqual([urgency(ending, ts(1_000)), urgency(short, ts(1_000)), unknown])
    // Ties on a week ending fall to the started 5-hour window.
    const idle = limitsOf([Window.of("5h", 0, ts(2_000)), Window.of("7d", 60, ts(9_000))])
    expect(urgencyOrder(urgency(ending, ts(1_000)), urgency(idle, ts(1_000)))).toBe(-1)
  })

  it("finds windows by span and scope", () => {
    const windows = [Window.of("5h", 10), Window.of("7d", 80, undefined, "opus"), Window.of("30d", 30)]
    expect(windowOf(windows, "5h")?.used).toBe(10)
    // The model's own weekly window is not the shared one.
    expect(windowOf(windows, "7d")).toBeUndefined()
    expect(longWindow(windows)?.span).toBe("30d")
    expect(scopedWindows(windows).map((w) => w.model)).toEqual(["opus"])
  })
})

describe("pooled", () => {
  it("reads a pool of accounts as one account", () => {
    const now = ts(1_000)
    const account = (fiveHour: number, reset: number, week: number) =>
      limitsOf([Window.of("5h", fiveHour, ts(reset)), Window.of("7d", week, ts(90_000))], now)
    const busy = account(90, 4_000, 60)
    const fresh = account(10, 2_000, 20)
    const idle = account(0, 1_500, 0)
    let pool = pooled([{ limits: busy }, { limits: fresh }, { limits: idle }], now)
    expect(pool.map((w) => w.span)).toEqual(["5h", "7d"])
    expect(pool[0]?.used).toBeCloseTo(100 / 3, 9)
    // The soonest reset of a window in use; the idle account frees nothing.
    expect(pool[0]?.resetsAt).toEqual(ts(2_000))
    expect(pool[1]?.used).toBeCloseTo(80 / 3, 9)
    expect(pool[0]?.weighted).toBe(false)

    // A blocked account counts as full in its shortest window.
    pool = pooled([{ limits: fresh, blocked: true }, { limits: idle }], now)
    expect([pool[0]?.used, pool[1]?.used]).toEqual([50, 10])
    // Accounts never measured are left out.
    expect(pooled([{ limits: busy }, { limits: Limits.empty }], now)[0]?.used).toBe(90)
    expect(pooled([{ limits: Limits.empty }], now)).toEqual([])
    // Weighted, a large plan's use counts for more.
    const weighted = pooled(
      [
        { limits: busy, share: 0.8 },
        { limits: fresh, share: 0.2 },
      ],
      now,
    )
    const plain = pooled([{ limits: busy }, { limits: fresh }], now)
    expect(weighted[0]?.used ?? 0).toBeGreaterThan(plain[0]?.used ?? 0)
    expect(weighted[0]?.weighted).toBe(true)
  })
})
