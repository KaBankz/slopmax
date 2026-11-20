import { describe, expect, test } from "bun:test"
import { HistoryBucket } from "@slopmax/client"
import {
  activityTip,
  axis,
  cacheAxis,
  cacheTip,
  firstByteTip,
  labelEvery,
  levels,
  moneyTick,
  places,
  requestsTip,
  rhythm,
  secondsTick,
  tickValues,
  tokensTick,
  tokensTip,
  zeroAxis,
} from "../../src/view/charts.ts"

const bucket = (fields: Partial<ConstructorParameters<typeof HistoryBucket>[0]> = {}) =>
  new HistoryBucket({
    label: "Oct 31",
    tokens: [],
    requests: 0,
    failed: 0,
    rescued: 0,
    sessions: 0,
    cost: 0,
    ...fields,
  })

describe("value axes", () => {
  test("end on round values, three to five steps of 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(axis(9, 1)).toEqual({ top: 10, ticks: 6 })
    expect(axis(47, 1)).toEqual({ top: 50, ticks: 6 })
    expect(axis(1_234, 1)).toEqual({ top: 1_250, ticks: 6 })
    expect(axis(0.37, 0.01)).toEqual({ top: 0.4, ticks: 5 })
    // Whole counts never get half steps.
    expect(axis(3, 1)).toEqual({ top: 3, ticks: 4 })
    // Nothing to show still draws a small axis.
    expect(axis(0, 1)).toEqual({ top: 3, ticks: 4 })
    expect(tickValues(zeroAxis(9, 1))).toEqual([0, 2, 4, 6, 8, 10])
  })

  test("ticks keep the places their steps need", () => {
    expect(places(5)).toBe(0)
    expect(places(0.5)).toBe(1)
    expect(places(0.25)).toBe(2)
    expect(secondsTick(0.5)(1.5)).toBe("1.5 s")
    expect(secondsTick(1)(2)).toBe("2 s")
    expect(tokensTick(2_000_000)).toBe("2M")
    expect(tokensTick(2_500_000)).toBe("2.5M")
    expect(moneyTick(5)).toBe("$5")
    expect(moneyTick(2.5)).toBe("$2.50")
  })

  test("the cache axis ends at 100% and starts low enough to hold the lowest value", () => {
    expect(cacheAxis([95, 97])).toEqual({ bottom: 90, top: 100, ticks: 3 })
    expect(cacheAxis([86, 92])).toEqual({ bottom: 80, top: 100, ticks: 3 })
    expect(cacheAxis([60])).toEqual({ bottom: 50, top: 100, ticks: 3 })
    expect(cacheAxis([20])).toEqual({ bottom: 0, top: 100, ticks: 3 })
  })

  test("bucket labels thin out on long ranges", () => {
    expect(labelEvery("today")).toBe(3)
    expect(labelEvery("7d")).toBe(1)
    expect(labelEvery("30d")).toBe(5)
  })
})

describe("tooltips", () => {
  test("say each bucket's figures", () => {
    expect(requestsTip(bucket({ requests: 12, failed: 2 }))).toBe("Oct 31\n12 answered\n2 failed")
    expect(requestsTip(bucket({ requests: 1 }))).toBe("Oct 31\n1 answered\n0 failed")
    expect(cacheTip(bucket({ cached: 0.864 }))).toBe("Oct 31\n86% of input from cache")
    expect(cacheTip(bucket())).toBe("Oct 31\nNo cache data")
    expect(firstByteTip(bucket({ firstByte: [840, 3_125] }))).toBe("Oct 31\nMedian 0.84 s\nSlowest 5% 3.12 s")
    expect(firstByteTip(bucket())).toBe("Oct 31\nNo response timings")
    expect(tokensTip({ providers: ["claude", "codex"] }, bucket({ tokens: [30_900_000, 11_100_000] }))).toBe(
      "Oct 31\nClaude: 30.9M\nChatGPT: 11.1M\nTotal: 42.0M",
    )
  })
})

describe("when you work", () => {
  test("levels each hour by where it ranks among the busy ones, as a contribution graph does", () => {
    expect(levels([[0, 1, 2, 3, 4, 100]])).toEqual([[0, 1, 2, 3, 4, 4]])
    // One burst does not wash the rest out, and hours alike share a level.
    expect(levels([[5, 5, 5, 0]])).toEqual([[4, 4, 4, 0]])
    expect(levels([[0, 0]])).toEqual([[0, 0]])
    // Many quiet hours alike stay below the one busy hour.
    expect(levels([[1, 1, 1, 1, 1, 1, 1, 1, 1, 25]])).toEqual([[2, 2, 2, 2, 2, 2, 2, 2, 2, 4]])
  })

  test("says when the work falls, in words", () => {
    const week = Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 24 }, (_hour, hour) => (day === 1 && hour === 20 ? 9 : day === 5 && hour === 3 ? 1 : 0)),
    )
    expect(rhythm(week)).toEqual([
      { title: "Busiest hour", value: "Tue 20:00", note: "9 requests" },
      { title: "Busiest day", value: "Tuesday", note: "90% of requests" },
      { title: "Most active", value: "Evenings", note: "90% of requests" },
      { title: "Weekends", value: "10%", note: "of requests" },
    ])
    expect(rhythm([[0, 0]])).toEqual([])
    expect(activityTip(1, 9, 1)).toBe("Tue 09:00 | 1 answered")
  })
})
