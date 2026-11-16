import { describe, expect, test } from "bun:test"
import { History, NamedTotals, Summary, SummaryRow, Totals } from "@slopmax/client"
import { DateTime } from "effect"
import {
  accountRows,
  change,
  hourly,
  isQuiet,
  machineRows,
  modelRows,
  perRequest,
  performanceStats,
  speedRows,
  todayStats,
  tokenMix,
  usageStats,
} from "../../src/view/usage.ts"
import { fixtureHistory, quietHistory } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T15:30:00Z")
const totals = (requests: number, tokens: number, cost = 0, unpriced = 0, failed = 0) =>
  new Totals({ requests, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost, unpriced, failed })

const history = (fields: Partial<ConstructorParameters<typeof History>[0]>) =>
  new History({ ...quietHistory("7d"), ...fields })

describe("the figures across the top", () => {
  test("the overview's today: requests, tokens, value and what failover saved", () => {
    const today = history({ range: "today", total: totals(908, 34_500_000, 21.7, 0, 12), rescued: 36, cached: 0.86 })
    expect(todayStats(today)).toEqual([
      { title: "Requests", value: "908", note: "12 failed" },
      { title: "Tokens", value: "34.5M", note: "86% from cache" },
      { title: "API value", value: "$21.70", note: "what the API would charge" },
      { title: "Saved by failover", value: "36", note: "answered by another account" },
    ])
    expect(todayStats(quietHistory("today"))[0]?.note).toBe("none failed")
  })

  test("the usage page: conversations, what keys billed, and a month at this pace", () => {
    const week = history({ total: totals(6_334, 240_700_000, 152.04), sessions: 244, billed: 3.49, monthly: 651.61 })
    expect(usageStats(week).map((stat) => [stat.value, stat.note])).toEqual([
      ["240.7M", "no cache reads"],
      ["6,334", "in 244 conversations"],
      ["$152.04", "Billed to API keys $3.49"],
      ["$651.61", "at API prices"],
    ])
    const unpriced = history({ range: "30d", total: totals(4, 1_000, 0, 4) })
    expect(
      usageStats(unpriced)
        .map((stat) => [stat.value, stat.note])
        .slice(2),
    ).toEqual([
      ["—", "4 requests unpriced"],
      ["—", "from a week's use"],
    ])
  })

  test("the performance page: how many were answered, cache and first byte", () => {
    const week = history({
      total: totals(998, 10, 0, 0, 2),
      rescued: 9,
      cached: 0.86,
      cacheSaved: 364.9,
      firstByte: 840,
    })
    expect(performanceStats(week).map((stat) => [stat.value, stat.note])).toEqual([
      ["99.8%", "2 failed"],
      ["9", "answered by another account"],
      ["86%", "saving $364.90"],
      ["0.84 s", "the median wait"],
    ])
    expect(performanceStats(quietHistory("7d")).map((stat) => stat.value)).toEqual(["—", "0", "—", "—"])
  })
})

describe("tables and parts", () => {
  test("names the five busiest models and sums the rest as Other", () => {
    const models = ["a", "b", "c", "d", "e", "f", "g"].map(
      (name, i) => new NamedTotals({ name, totals: totals(1, (7 - i) * 1_000, 1) }),
    )
    const rows = modelRows(history({ models }))
    expect(rows.map((row) => [row.name, row.tokens])).toEqual([
      ["a", "7.0k"],
      ["b", "6.0k"],
      ["c", "5.0k"],
      ["d", "4.0k"],
      ["e", "3.0k"],
      ["Other", "3.0k"],
    ])
    expect(rows[0]?.fraction).toBe(1)
  })

  test("the token mix splits every token four ways, and says what a request carries", () => {
    const total = new Totals({
      requests: 10,
      input: 100,
      output: 50,
      cacheRead: 800,
      cacheWrite: 50,
      cost: 0,
      unpriced: 0,
      failed: 0,
    })
    expect(tokenMix(total).map((part) => [part.title, part.share])).toEqual([
      ["Input", 0.1],
      ["Cache read", 0.8],
      ["Cache write", 0.05],
      ["Output", 0.05],
    ])
    expect(perRequest(total)).toEqual({ context: "95", output: "5" })
  })

  test("the accounts table gives shares, a dash for none failed, and a total", () => {
    const week = fixtureHistory("7d", now)
    const table = accountRows(week)
    expect(table.rows.map((row) => row.name)).toEqual([
      "ana@studio.dev",
      "ana@studio.dev",
      "ben@studio.dev",
      "ops@studio.dev",
      "Team API key",
    ])
    expect(table.rows[2]?.failed).toBe("—")
    expect(table.rows[3]?.failed).toBe("4")
    expect(table.unplaced).toBe(3)
    expect(table.total.share).toBe("100%")
    expect(speedRows(week)[0]).toEqual({ model: "gpt-6-mini", provider: "ChatGPT", speed: "182 tok/s" })
  })

  test("today's tokens fill all twenty-four hours", () => {
    const today = fixtureHistory("today", now)
    const hours = hourly(today)
    expect(hours.length).toBe(24)
    // The hours still to come have nothing in them.
    expect(hours.slice(today.buckets.length).every((n) => n === 0)).toBe(true)
    expect(hours.slice(0, today.buckets.length).some((n) => n > 0)).toBe(true)
    expect(isQuiet(quietHistory("today"))).toBe(true)
    expect(isQuiet(today)).toBe(false)
  })
})

const summary = (rows: ReadonlyArray<SummaryRow>) =>
  new Summary({ range: "7d", by: "machine", since: now, rows, total: Totals.zero })
const row = (key: string, requests: number, tokens: number) => new SummaryRow({ key, totals: totals(requests, tokens) })

describe("usage by machine", () => {
  test("lists the machines most tokens first, the hub's own key among them", () => {
    const rows = machineRows(summary([row("ci", 31, 20_400), row("hub", 96, 88_100), row("laptop", 412, 310_200)]))
    expect(rows.map((r) => [r.name, r.tokens, r.requests])).toEqual([
      ["laptop", "310.2k", "412 requests"],
      ["hub", "88.1k", "96 requests"],
      ["ci", "20.4k", "31 requests"],
    ])
    expect(rows[0]?.fraction).toBe(1)
  })

  test("says nothing while only this slopmax's own key sent requests", () => {
    expect(machineRows(summary([]))).toEqual([])
    expect(machineRows(summary([row("this machine", 9, 900)]))).toEqual([])
    expect(machineRows(summary([row("hub", 9, 900)]))).toEqual([])
    expect(machineRows(summary([row("this machine", 9, 900), row("laptop", 1, 10)])).length).toBe(2)
  })
})

describe("changes since the span before", () => {
  test("read as a signed percent, finer under ten, flat within half a point", () => {
    expect(change(125, 100, "100", "the 7 days before")).toEqual({
      text: "+25%",
      direction: "up",
      tip: "100 the 7 days before",
    })
    expect(change(93.5, 100, "$100", "yesterday by this hour")?.text).toBe("−6.5%")
    expect(change(100.2, 100, "100", "")?.direction).toBe("flat")
    expect(change(5, 0, "0", "")).toBeUndefined()
  })

  test("the usage figures carry them when the history has a span before", () => {
    const lastWeek = fixtureHistory("7d", DateTime.makeUnsafe("2026-11-16T12:00:00Z"))
    const [tokens, requests, value, month] = usageStats(lastWeek)
    expect(tokens?.change?.direction).toBe("up")
    expect(requests?.change?.tip).toContain("the 7 days before")
    expect(value?.change?.direction).toBe("down")
    expect(month?.change).toBeUndefined()
    expect(usageStats(fixtureHistory("30d", DateTime.makeUnsafe("2026-11-16T12:00:00Z")))[0]?.change).toBeUndefined()
  })
})
