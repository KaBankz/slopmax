import { describe, expect, test } from "bun:test"
import {
  History,
  HistoryBucket,
  LeftAccount,
  NamedTotals,
  PreviousTotals,
  Summary,
  SummaryRow,
  Totals,
} from "@slopmax/client"
import { DateTime } from "effect"
import {
  accountRows,
  activityStats,
  agentProvider,
  change,
  isQuiet,
  leftAccountValue,
  machineRows,
  modelProvider,
  modelRows,
  perRequest,
  performanceStats,
  previousRequests,
  requestTotal,
  speedRows,
  tokenMix,
  usageStats,
} from "../../src/view/usage.ts"
import { fixtureHistory, quietHistory } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T15:30:00Z")
const totals = (requests: number, tokens: number, cost = 0, unpriced = 0, failed = 0) =>
  new Totals({ requests, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost, unpriced, failed })

const bucket = (label: string, requests: number, failed: number, cached?: number, cost = 0, tokens = 0) =>
  new HistoryBucket({
    label,
    tokens: [tokens],
    requests,
    failed,
    rescued: 0,
    sessions: 0,
    cost,
    ...(cached === undefined ? {} : { cached }),
  })

const history = (fields: Partial<ConstructorParameters<typeof History>[0]>) =>
  new History({ ...quietHistory("7d"), ...fields })

test("unused value separates a configured zero price, spent quota, and an unknown price", () => {
  const row = { name: "work", provider: "claude", windows: 1, unused: 40, dollars: 0 } as const
  expect(leftAccountValue(new LeftAccount({ ...row, unpriced: 0 }), 1)).toBe("$0.00")
  expect(leftAccountValue(new LeftAccount({ ...row, unpriced: 1 }), 1)).toBe("—")
  expect(leftAccountValue(new LeftAccount({ ...row, unused: 0 }), 1)).toBe("$0.00")
  expect(leftAccountValue(new LeftAccount(row), 1)).toBe("—")
})

describe("the figures across the top", () => {
  test("the overview counts all requests and explains success, cache, estimated cost and response time", () => {
    const today = history({
      range: "today",
      total: totals(908, 34_500_000, 21.7, 0, 12),
      rescued: 36,
      cached: 0.86,
      firstByte: 840,
    })
    expect(requestTotal(today.total)).toBe(920)
    expect(activityStats(today)).toEqual([
      { title: "Success rate", value: "98.7%", note: "Share answered (36 via failover)" },
      { title: "Tokens processed", value: "34.5M", note: "86% of input from cache" },
      { title: "Value at API prices", value: "$21.70", note: "Pay-as-you-go equivalent" },
      { title: "Median wait", value: "0.84 s", note: "Time to first response" },
    ])
    expect(activityStats(quietHistory("today")).map((stat) => stat.value)).toEqual(["—", "0", "—", "—"])
    const failures = history({ total: totals(0, 0, 0, 0, 4) })
    expect(activityStats(failures)[0]?.value).toBe("0.0%")
    expect(activityStats(failures)[2]?.value).toBe("—")
    expect(activityStats(history({ total: totals(4, 1000, 5, 2) }))[2]).toMatchObject({
      value: "$5.00+",
      note: "2 answers missing prices",
    })
  })

  test("period comparisons convey the direction and retain successes or failures near the rounding limits", () => {
    const previous = new PreviousTotals({ total: totals(90, 1000, 8, 0, 10), rescued: 0, sessions: 0 })
    const [success, tokens, value, wait] = activityStats(history({ total: totals(9_999, 1250, 6, 0, 1), previous }))
    expect(success).toMatchObject({ value: ">99.9%", change: { direction: "up", text: "10.0 points" } })
    expect(tokens?.change).toMatchObject({ direction: "up", text: "25.0%" })
    expect(value?.change).toMatchObject({ direction: "down", text: "25.0%" })
    expect(wait?.change).toBeUndefined()
    expect(performanceStats(history({ total: totals(1, 2, 0, 0, 9_999) }))[0]?.value).toBe("<0.1%")
    expect(activityStats(history({ total: totals(9, 12, 4, 2), previous }))[2]?.change).toBeUndefined()
  })

  test("the usage page: conversations, what keys billed, and a month at this pace", () => {
    // Three whole days of $20, $30 and $40, then today's $5 (not over, left out): $30 a day.
    const week = history({
      total: totals(6_334, 240_700_000, 152.04),
      sessions: 244,
      billed: 3.49,
      buckets: [
        bucket("Nov 10", 0, 0),
        bucket("Nov 11", 0, 0),
        bucket("Nov 12", 0, 0),
        bucket("Nov 13", 9, 0, undefined, 20),
        bucket("Nov 14", 9, 0, undefined, 30),
        bucket("Nov 15", 9, 0, undefined, 40),
        bucket("Nov 16", 1, 0, undefined, 5),
      ],
    })
    expect(usageStats(week).map((stat) => [stat.value, stat.note])).toEqual([
      ["240.7M", "No cache data"],
      ["6,334", "in 244 conversations"],
      ["$152.04", "Estimated API-key spend $3.49"],
      ["$900.00", "30 days at the last 3 full days' rate"],
    ])
    // The same pace on a month's range, which holds the same days.
    expect(usageStats(history({ ...week, range: "30d" }))[3]?.value).toBe("$900.00")
    // Today: the hours so far, scaled to a day, then a month.
    const today = history({
      range: "today",
      total: totals(10, 1_000, 6),
      buckets: Array.from({ length: 6 }, (_, i) => bucket(`0${i}:00`, 1, 0)),
    })
    expect(usageStats(today)[3]).toMatchObject({ value: "$720.00", note: "30 days at today's hourly rate" })
    // A full week reads the same on 7 days (six whole days besides today) as on 30 (which holds a seventh before them).
    const days = [10, 20, 30, 40, 50, 60].map((cost, i) => bucket(`Nov ${i + 11}`, 9, 0, undefined, cost))
    const full7 = history({ buckets: [...days, bucket("Nov 17", 1, 0, undefined, 5)] })
    const full30 = history({
      range: "30d",
      buckets: [bucket("Nov 10", 9, 0, undefined, 999), ...days, bucket("Nov 17", 1, 0, undefined, 5)],
    })
    expect(usageStats(full7)[3]).toMatchObject({ value: "$1,050", note: "30 days at the last 6 full days' rate" })
    expect(usageStats(full30)[3]).toMatchObject({ value: "$1,050", note: "30 days at the last 6 full days' rate" })
    // A request older than the 7-day range, then idle days: 30 days reads as 7 do.
    const sparse = history({ ...week, range: "30d", buckets: [bucket("Nov 6", 9, 0, undefined, 999), ...week.buckets] })
    expect(usageStats(sparse)[3]).toMatchObject({ value: "$900.00", note: "30 days at the last 3 full days' rate" })
    const unpriced = history({ range: "30d", total: totals(4, 1_000, 0, 4) })
    expect(
      usageStats(unpriced)
        .map((stat) => [stat.value, stat.note])
        .slice(2),
    ).toEqual([
      ["—", "4 answers missing prices"],
      ["—", "No model prices available"],
    ])
  })

  test("the monthly pace marks partial pricing and withholds a projection without model prices", () => {
    const buckets = [bucket("Nov 15", 4, 0, undefined, 30), bucket("Nov 16", 1, 0)]
    const previous = new PreviousTotals({ total: totals(4, 900, 24), rescued: 0, sessions: 0 })
    const partial = history({ buckets, total: totals(5, 1_000, 30, 3), billed: 3.49, previous })
    expect(usageStats(partial)[2]).toMatchObject({
      value: "$30.00+",
      note: "Estimated API-key spend $3.49",
    })
    expect(usageStats(partial)[2]?.change).toBeUndefined()
    expect(usageStats(history({ ...partial, billed: 0 }))[2]?.note).toBe("3 answers missing prices")
    const previousPartial = new PreviousTotals({ ...previous, total: totals(4, 900, 24, 1) })
    expect(
      usageStats(history({ ...partial, total: totals(5, 1_000, 30), previous: previousPartial }))[2]?.change,
    ).toBeUndefined()
    expect(usageStats(partial)[3]).toMatchObject({
      value: "$900.00+",
      note: "30 days at the last full day's rate. Known model prices only.",
    })
    const unknown = history({ buckets, total: totals(5, 1_000, 0, 5) })
    expect(usageStats(unknown)[3]).toMatchObject({ value: "—", note: "No model prices available" })
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
      ["86%", "Saved $364.90 at API prices"],
      ["0.84 s", "Time to first response"],
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

  test("a model and an agent take the provider they belong to, for their color", () => {
    expect(modelProvider(["claude", "codex", "grok"], "claude-opus-5-5")).toBe("claude")
    expect(modelProvider(["anthropic", "codex"], "claude-opus-5-5")).toBe("anthropic")
    expect(modelProvider(["claude", "codex"], "gpt-6.1-sol")).toBe("codex")
    expect(modelProvider(["claude", "grok"], "unknown")).toBeUndefined()
    expect(agentProvider("Grok Build")).toBe("grok")
    expect(agentProvider("Other")).toBeUndefined()
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
    expect(speedRows(week)[0]).toEqual({
      model: "gpt-6-mini",
      provider: "ChatGPT",
      providerId: "codex",
      speed: "182 tok/s",
      fraction: 1,
    })
  })

  test("the comparison counts failed requests and identifies the preceding span", () => {
    const today = fixtureHistory("today", now)
    const yesterday = today.previous?.total ?? Totals.zero
    expect(previousRequests(today)).toMatch(/requests yesterday by this hour$/)
    expect(previousRequests(today)).toContain((yesterday.requests + yesterday.failed).toLocaleString("en-US"))
    expect(previousRequests(fixtureHistory("7d", now))).toMatch(/in the previous 7 days$/)
    expect(previousRequests(fixtureHistory("30d", now))).toBeUndefined()
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
  test("read as a percent to a tenth with its direction, flat when that rounds to nothing", () => {
    expect(change(125, 100, "100", "the 7 days before", "w/w")).toEqual({
      text: "25.0%",
      direction: "up",
      versus: "w/w",
      tip: "100 the 7 days before",
    })
    expect(change(93.5, 100, "$100", "yesterday by this hour", "vs yesterday")).toMatchObject({
      text: "6.5%",
      direction: "down",
    })
    expect(change(100.04, 100, "100", "", "w/w")).toMatchObject({ text: "0.0%", direction: "flat" })
    expect(change(100.2, 100, "100", "", "w/w")?.direction).toBe("up")
    expect(change(5, 0, "0", "", "w/w")).toBeUndefined()
  })

  test("the usage figures carry them when the history has a span before", () => {
    const lastWeek = fixtureHistory("7d", DateTime.makeUnsafe("2026-11-16T12:00:00Z"))
    const [tokens, requests, value, month] = usageStats(lastWeek)
    expect(tokens?.change?.direction).toBe("up")
    expect(requests?.change?.tip).toContain("in the previous 7 days")
    expect(requests?.change?.versus).toBe("vs prior 7 days")
    expect(usageStats(fixtureHistory("today", DateTime.makeUnsafe("2026-11-16T12:00:00Z")))[0]?.change?.versus).toBe(
      "vs yesterday",
    )
    expect(value?.change?.direction).toBe("down")
    expect(month?.change).toBeUndefined()
    expect(usageStats(fixtureHistory("30d", DateTime.makeUnsafe("2026-11-16T12:00:00Z")))[0]?.change).toBeUndefined()
  })
})

describe("trend lines", () => {
  test("each figure with one has a point a bucket, its tooltip the bucket and the figure", () => {
    const week = fixtureHistory("7d", DateTime.makeUnsafe("2026-11-16T12:00:00Z"))
    const [tokens, , value, month] = usageStats(week)
    expect(tokens?.trend?.points.length).toBe(week.buckets.length)
    expect(tokens?.trend?.points[0]?.tip).toMatch(/^Nov 10\n[\d.]+M tokens$/)
    expect(value?.trend?.series).toBe(1)
    expect(month?.trend).toBeUndefined()
    // A bucket without a reading is a gap, not a zero; the line starts and
    // stops where there are readings.
    const [answered, , cache] = performanceStats(
      history({
        buckets: [
          bucket("Nov 10", 0, 0),
          bucket("Nov 11", 9, 1, 0.5),
          bucket("Nov 12", 0, 0),
          bucket("Nov 13", 4, 0, 1),
          bucket("Nov 14", 0, 0),
        ],
      }),
    )
    expect(answered?.trend?.points.map((p) => p.value)).toEqual([90, undefined, 100])
    expect(cache?.trend?.points.map((p) => p.label)).toEqual(["Nov 11", "Nov 12", "Nov 13"])
  })
})
