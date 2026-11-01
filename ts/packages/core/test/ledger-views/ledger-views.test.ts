import { describe, expect } from "bun:test"
import { AccountId, LedgerRecord, noAccountFree, Totals } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Schema } from "effect"
import {
  costLabel,
  history,
  left,
  percentile,
  rangeStart,
  summary,
  unusedValue,
  type ViewContext,
} from "../../src/ledger-views.ts"
import type { Pricing, Rates } from "../../src/pricing.ts"

const decode = Schema.decodeUnknownSync(LedgerRecord)
const id = Schema.decodeUnknownSync(AccountId)

const listed: Readonly<Record<string, Rates>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  m: { input: 10, output: 0, cacheRead: 1, cacheWrite: 12.5 },
}
const fees: Readonly<Record<string, number>> = { "claude/max 20x": 200, "claude/pro": 20, "codex/team": 30 }
const pricing: Pricing = { rates: (model) => listed[model], planFee: (provider, plan) => fees[`${provider}/${plan}`] }

const utc = DateTime.zoneMakeOffset(0)
const now = DateTime.makeUnsafe("2026-10-31T12:30:00Z")
const minutesAgo = (n: number) => DateTime.subtractDuration(now, Duration.minutes(n))

const context = (overrides: Partial<ViewContext> = {}): ViewContext => ({
  names: new Map(),
  pricing,
  now,
  zone: utc,
  ...overrides,
})

/** A request record; a field given as undefined is left out. */
const request = (at: DateTime.DateTime, fields: Record<string, unknown> = {}): LedgerRecord =>
  decode(
    Object.fromEntries(
      Object.entries({
        _tag: "Request",
        at: DateTime.formatIso(DateTime.toUtc(at)),
        account: "claude-11111111",
        provider: "claude",
        model: "claude-opus-5-5",
        status: 200,
        usage: { input: 0, output: 10 },
        ms: 900,
        ...fields,
      }).filter(([, value]) => value !== undefined),
    ),
  )

const tokens = (input: number, rest: Record<string, number> = {}) => ({ usage: { input, output: 10, ...rest } })

const ended = (account: string, plan: string, span: string, used: number, at: string): LedgerRecord =>
  decode({ _tag: "WindowEnded", at, account, provider: "claude", plan, span, used })

const endedRecords = (records: ReadonlyArray<LedgerRecord>) =>
  records.flatMap((record) => (record._tag === "WindowEnded" ? [record] : []))

describe("summary", () => {
  it("counts answers whose model has no price apart, and labels the cost to say so", () => {
    const at = minutesAgo(1)
    const unpriced = summary([request(at, { model: "compat-model", ...tokens(10) })], "today", "model", context())
    expect(costLabel(unpriced.total)).toBe("—")
    const mixed = summary(
      [request(at, { model: "compat-model", ...tokens(10) }), request(at, { usage: { input: 1_000_000 } })],
      "today",
      "model",
      context(),
    )
    expect(costLabel(mixed.total)).toBe("$4.00+")
    expect([mixed.total.requests, mixed.total.unpriced]).toEqual([2, 1])
    const priced = summary([request(at, { usage: { input: 500_000 } })], "today", "day", context())
    expect(costLabel(priced.total)).toBe("$2.00")
  })

  it("counts only answers as requests: a failure as failed, an agent's housekeeping not at all", () => {
    const at = minutesAgo(1)
    const result = summary(
      [
        request(at, { usage: { input: 100 } }),
        // An agent listing models or counting tokens moves none.
        request(at, { usage: {} }),
        request(at, { status: 429, usage: {} }),
      ],
      "today",
      "day",
      context(),
    )
    expect([result.total.requests, result.total.failed, result.total.input, result.total.unpriced]).toEqual([
      1, 1, 100, 0,
    ])
  })

  it("starts ranges at local midnight, six or 29 days before it, or at the epoch for all", () => {
    // 03:00 UTC is still the evening before, five hours west.
    const west = DateTime.zoneMakeOffset(-5 * 3_600_000)
    const late = DateTime.makeUnsafe("2026-10-31T03:00:00Z")
    expect(DateTime.formatIso(rangeStart("today", late, west))).toBe("2026-10-30T05:00:00.000Z")
    expect(DateTime.formatIso(rangeStart("7d", late, west))).toBe("2026-10-24T05:00:00.000Z")
    expect(DateTime.formatIso(rangeStart("30d", late, west))).toBe("2026-10-01T05:00:00.000Z")
    expect(DateTime.toEpochMillis(rangeStart("all", late, west))).toBe(0)
    const today = rangeStart("today", now, utc)
    expect(Duration.toHours(DateTime.distance(today, now))).toBeLessThan(24)
    expect(Duration.toHours(DateTime.distance(rangeStart("7d", now, utc), today))).toBe(24 * 6)
  })

  it("starts a range on a local midnight even across a clock change", () => {
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York")
    // Clocks go back an hour on November 1st, 2026.
    const after = DateTime.makeUnsafe("2026-11-02T12:00:00Z")
    expect(DateTime.formatIso(rangeStart("today", after, newYork))).toBe("2026-11-02T05:00:00.000Z")
    expect(DateTime.formatIso(rangeStart("7d", after, newYork))).toBe("2026-10-27T04:00:00.000Z")
  })

  it("makes rows by local day, model or account, sorted, with failures no account took apart", () => {
    const records = [
      request(DateTime.makeUnsafe("2026-10-30T23:30:00Z"), tokens(1)),
      request(DateTime.makeUnsafe("2026-10-31T08:00:00Z"), { ...tokens(2), model: undefined }),
      request(DateTime.makeUnsafe("2026-10-31T09:00:00Z"), { status: 429, usage: {}, account: undefined }),
      request(DateTime.makeUnsafe("2026-10-31T09:30:00Z"), { ...tokens(3), account: "codex-22222222" }),
      // Housekeeping makes no row.
      request(DateTime.makeUnsafe("2026-10-31T10:00:00Z"), { usage: {}, model: "listing" }),
    ]
    const ctx = context({ names: new Map([[id("claude-11111111"), "me@x.dev"]]) })
    const keys = (by: "day" | "model" | "account", zone = utc) =>
      summary(records, "7d", by, { ...ctx, zone }).rows.map((row) => row.key)
    expect(keys("day")).toEqual(["2026-10-30", "2026-10-31"])
    // An hour east, the first answer was already on the 31st.
    expect(keys("day", DateTime.zoneMakeOffset(3_600_000))).toEqual(["2026-10-31"])
    expect(keys("model")).toEqual(["-", "claude-opus-5-5"])
    expect(keys("account")).toEqual([noAccountFree, "codex-22222222", "me@x.dev"])
    const result = summary(records, "7d", "account", ctx)
    expect(result.rows.find((row) => row.key === noAccountFree)?.totals.failed).toBe(1)
    expect(result.total.requests).toBe(3)
    expect(DateTime.formatIso(result.since)).toBe("2026-10-25T00:00:00.000Z")
  })

  it("rounds costs to a millionth of a dollar", () => {
    const at = minutesAgo(1)
    const result = summary(
      [
        request(at, { usage: { input: 1 } }),
        request(at, { usage: { input: 1 } }),
        request(at, { usage: { input: 1 } }),
      ],
      "today",
      "day",
      { ...context(), pricing: { ...pricing, rates: () => ({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }) } },
    )
    expect(result.total.cost).toBe(0)
    const pennies = summary([request(at, { usage: { input: 2_270_100 } })], "today", "day", {
      ...context(),
      pricing: { ...pricing, rates: () => ({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }) },
    })
    expect(pennies.total.cost).toBe(0.22701)
  })

  it("labels a cost with nothing in it as nothing spent", () => {
    expect(costLabel(Totals.zero)).toBe("$0.00")
  })
})

describe("history", () => {
  it("fills each day's bucket by provider, and ranks models and accounts busiest first", () => {
    const since = rangeStart("7d", now, utc)
    const lastDay = DateTime.addDuration(since, Duration.hours(24 * 6 + 1))
    const records = [
      request(DateTime.addDuration(since, Duration.hours(1)), tokens(100)),
      request(lastDay, tokens(300)),
      request(lastDay, { ...tokens(50), provider: "codex", model: "gpt-6-sol", account: "codex-22222222" }),
    ]
    const result = history(records, "7d", context({ names: new Map([[id("claude-11111111"), "me@x.dev"]]) }))
    expect(result.buckets.length).toBe(7)
    expect(result.providers).toEqual(["claude", "codex"])
    expect(result.buckets[0]?.tokens).toEqual([110, 0])
    expect(result.buckets[6]?.tokens).toEqual([310, 60])
    expect(result.buckets[6]?.requests).toBe(2)
    expect(result.buckets.slice(1, 6).every((bucket) => bucket.requests === 0)).toBe(true)
    expect(result.buckets.map((bucket) => bucket.label)).toEqual([
      "Oct 25",
      "Oct 26",
      "Oct 27",
      "Oct 28",
      "Oct 29",
      "Oct 30",
      "Oct 31",
    ])
    expect(result.total.requests).toBe(3)
    expect(result.models[0]?.name).toBe("claude-opus-5-5")
    expect(result.accounts.map((account) => account.name)).toEqual(["me@x.dev", "codex-22222222"])
    expect(result.activity.flat().reduce((a, b) => a + b, 0)).toBe(3)
  })

  it("counts failover's rescues, failures and housekeeping apart", () => {
    const at = minutesAgo(1)
    const records = [
      request(at, { ...tokens(100), attempts: 2, firstByteMs: 100 }),
      request(at, { status: 429, usage: {} }),
      // Spent before any account could be tried.
      request(at, { status: 429, usage: {}, account: undefined }),
      // An agent listing models.
      request(at, { usage: {}, model: undefined }),
    ]
    const result = history(records, "today", context())
    expect([result.total.requests, result.total.failed]).toEqual([1, 2])
    expect(result.rescued).toBe(1)
    const bucket = result.buckets.at(-1)
    expect([bucket?.requests, bucket?.failed, bucket?.rescued]).toEqual([1, 2, 1])
    // The account the failure reached counts it; a failure that reached none makes no row.
    expect(result.accounts.length).toBe(1)
    expect(result.accounts[0]?.totals.failed).toBe(1)
    expect(result.unplaced).toBe(1)
    expect(result.models.length).toBe(1)
  })

  it("bills what API keys answered, and only values what subscriptions answered", () => {
    const at = minutesAgo(1)
    const records = [
      request(at, tokens(1_000_000)),
      request(at, { ...tokens(1_000_000), provider: "anthropic", account: "anthropic-33333333" }),
    ]
    const result = history(records, "today", context())
    // A million input at $4 and ten output at $20 a million: both valued, one billed.
    const each = 4 + (10 * 20) / 1e6
    expect(result.total.cost).toBeCloseTo(2 * each, 9)
    expect(result.billed).toBeCloseTo(each, 9)
  })

  it("works out what caching saved, how fast answers came, the sessions and the agents", () => {
    const at = minutesAgo(1)
    const answer = (session: string) =>
      request(at, {
        model: "m",
        usage: { cacheRead: 1_000_000, output: 1_000 },
        ms: 11_000,
        firstByteMs: 1_000,
        agent: "claude-code",
        session,
      })
    const warmup = request(at, {
      ...tokens(5),
      provider: "codex",
      model: "gpt-6-sol",
      account: "codex-22222222",
      agent: "slopmax",
    })
    const result = history([answer("a"), answer("a"), answer("b"), warmup], "7d", context())
    // Three million tokens read from cache at $1 instead of $10.
    expect(result.cacheSaved).toBeCloseTo(27, 9)
    expect(result.sessions).toBe(2)
    expect(result.speeds[0]?.model).toBe("m")
    expect(result.speeds[0]?.tokensPerSecond).toBeCloseTo(100, 9)
    expect(result.agents.map((agent) => agent.name)).toEqual(["Claude Code", "Warmups"])
    expect(result.monthly).toBeCloseTo((result.total.cost * 30) / 7, 9)
    // The warmup is neither work nor input that missed the cache.
    expect(result.activity.flat().reduce((a, b) => a + b, 0)).toBe(3)
    expect(result.cached).toBe(1)
    expect(result.buckets.at(-1)?.cached).toBe(1)
    expect(result.firstByte).toBe(1_000)
  })

  it("gives an hour of warmups alone no cache rate and no place among the work", () => {
    const warmup = request(minutesAgo(1), { ...tokens(9), provider: "codex", model: "gpt-6-sol", agent: "slopmax" })
    const result = history([warmup], "today", context())
    expect(result.total.requests).toBe(1)
    expect(result.buckets.at(-1)?.cached).toBeUndefined()
    expect(result.cached).toBeUndefined()
    expect(result.activity.flat().every((n) => n === 0)).toBe(true)
  })

  it("counts today's hours up to now", () => {
    const fiveAm = DateTime.makeUnsafe("2026-10-31T05:20:00Z")
    const result = history([], "today", context({ now: fiveAm }))
    expect(result.buckets.map((bucket) => bucket.label)).toEqual(["00:00", "01:00", "02:00", "03:00", "04:00", "05:00"])
    expect(result.providers).toEqual([])
    expect(result.monthly).toBeUndefined()
  })

  it("places work on the local weekday and hour", () => {
    // Thursday, 00:16 UTC.
    const record = request(DateTime.makeUnsafe("2026-10-29T00:16:40Z"), tokens(1))
    const at = (zone: DateTime.TimeZone) => {
      const activity = history([record], "7d", context({ zone })).activity
      return activity.flatMap((row, day) => row.flatMap((n, hour) => (n > 0 ? [[day, hour]] : [])))
    }
    expect(at(utc)).toEqual([[3, 0]])
    // Five hours west it is still Wednesday evening.
    expect(at(DateTime.zoneMakeOffset(-5 * 3_600_000))).toEqual([[2, 19]])
  })

  it("reads the time to the first byte as the median and the slowest twentieth", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 50)).toBe(51)
    expect(percentile(values, 95)).toBe(96)
    expect(percentile([], 50)).toBeUndefined()
    const at = minutesAgo(1)
    const records = values.map((ms) => request(at, { ...tokens(1), firstByteMs: ms }))
    const result = history(records, "today", context())
    expect(result.buckets.at(-1)?.firstByte).toEqual([51, 96])
    expect(result.firstByte).toBe(51)
  })

  it("keeps each local calendar day in its own bucket across a clock change", () => {
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York")
    const records = [
      // 23:30 on October 31st, daylight time.
      request(DateTime.makeUnsafe("2026-11-01T03:30:00Z"), tokens(1)),
      // 01:30 on November 1st, the first time round.
      request(DateTime.makeUnsafe("2026-11-01T05:30:00Z"), tokens(2)),
    ]
    const result = history(records, "7d", context({ now: DateTime.makeUnsafe("2026-11-03T12:00:00Z"), zone: newYork }))
    expect(result.buckets.map((bucket) => bucket.label)).toEqual([
      "Oct 28",
      "Oct 29",
      "Oct 30",
      "Oct 31",
      "Nov 1",
      "Nov 2",
      "Nov 3",
    ])
    expect(result.buckets.map((bucket) => bucket.tokens[0] ?? 0)).toEqual([0, 0, 0, 11, 12, 0, 0])
  })

  it("places work on the right local hour when a clock change falls inside an hour", () => {
    // Lord Howe Island moves its clocks half an hour, at 15:30 UTC on 3 October 2026.
    const lordHowe = DateTime.zoneMakeNamedUnsafe("Australia/Lord_Howe")
    const records = [
      // 01:45 on Sunday 4 October, standard time.
      request(DateTime.makeUnsafe("2026-10-03T15:15:00Z"), tokens(1)),
      // 02:45, summer time.
      request(DateTime.makeUnsafe("2026-10-03T15:45:00Z"), tokens(2)),
    ]
    const result = history(
      records,
      "today",
      context({ now: DateTime.makeUnsafe("2026-10-03T18:00:00Z"), zone: lordHowe }),
    )
    expect(result.buckets.map((bucket) => bucket.tokens[0] ?? 0)).toEqual([0, 11, 12, 0, 0, 0])
    expect(result.activity[6]?.slice(0, 4)).toEqual([0, 1, 1, 0])
  })

  it("says what the range's resets left on the table", () => {
    const records = [
      ended("claude-11111111", "max 20x", "7d", 50, "2026-10-30T00:00:00Z"),
      // Before the range.
      ended("claude-11111111", "max 20x", "7d", 0, "2026-10-01T00:00:00Z"),
    ]
    const result = history(records, "7d", context())
    expect(result.left.windows).toBe(1)
    expect(result.left.dollars).toBeCloseTo(((200 * 12) / 52) * 0.5, 9)
  })
})

/** A month's fee as a week's. */
const week = (monthly: number) => (monthly * 12) / 52

describe("left on the table", () => {
  it("values the unused part of a week at its share of the plan's fee", () => {
    const value = (plan: string | undefined, span: "5h" | "7d" | "30d", used: number, model?: string) =>
      unusedValue({ provider: "claude", plan, span, used, model }, pricing)
    // Max 20x at $200 a month: a week is $46.15; half unused, $23.08.
    expect(value("max 20x", "7d", 50)).toBeCloseTo((200 * 12) / 52 / 2, 9)
    // A week used to the full wastes nothing; past the full, nothing either.
    expect(value("pro", "7d", 100)).toBe(0)
    expect(value("pro", "7d", 130)).toBe(0)
    // Five hours, and a model's own week, are not what the fee buys.
    expect(value("pro", "5h", 0)).toBe(0)
    expect(value("pro", "7d", 0, "Fable")).toBe(0)
    // A month's window is the whole fee.
    expect(unusedValue({ provider: "codex", plan: "team", span: "30d", used: 0 }, pricing)).toBe(30)
    expect(value(undefined, "7d", 0)).toBeUndefined()
    expect(value("enterprise", "7d", 0)).toBeUndefined()
  })

  it("totals long windows by account, most dollars first", () => {
    const records = [
      ended("claude-aaaaaaaa", "max 20x", "7d", 50, "2026-10-01T00:00:01Z"),
      ended("claude-aaaaaaaa", "max 20x", "7d", 100, "2026-10-01T00:00:02Z"),
      ended("claude-aaaaaaaa", "max 20x", "5h", 0, "2026-10-01T00:00:03Z"),
      ended("claude-bbbbbbbb", "pro", "7d", 80, "2026-10-01T00:00:04Z"),
      ended("claude-cccccccc", "mystery", "7d", 0, "2026-10-01T00:00:05Z"),
    ]
    const result = left(endedRecords(records), context({ names: new Map([[id("claude-aaaaaaaa"), "work@x.dev"]]) }))
    expect([result.windows, result.unpriced]).toEqual([4, 1])
    // 50, 0, 20 and 100 unused.
    expect(result.unused).toBeCloseTo(42.5, 9)
    expect(result.dollars).toBeCloseTo(week(200) * 0.5 + week(20) * 0.2, 9)
    expect(result.accounts[0]?.name).toBe("work@x.dev")
    expect([result.accounts[0]?.windows, result.accounts[0]?.unused]).toEqual([2, 25])
    expect(result.accounts.at(-1)?.dollars).toBe(0)
  })

  it("is nothing when no long window ended", () => {
    const result = left(endedRecords([ended("claude-aaaaaaaa", "pro", "5h", 10, "2026-10-01T00:00:00Z")]), context())
    expect(result.windows).toBe(0)
    expect(result.accounts).toEqual([])
  })
})
