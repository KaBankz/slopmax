import { describe, expect } from "bun:test"

import { it } from "@slopmax/test"
import { Effect, Schema } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { without } from "../src/account.ts"
import { build, HistorySchema, load, percentile, Range, when } from "../src/history.ts"
import { append, type Entry } from "../src/ledger.ts"
import { Home } from "../src/paths.ts"
import type { ProviderId } from "../src/provider/mod.ts"
import { since as rangeStart } from "../src/summary.ts"
import * as waste from "../src/waste.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const ts = (secs: number): Timestamp => secs * 1000

const entry = (at: Timestamp, provider: ProviderId, model: string, input: number): Entry => ({
  at,
  account: `${provider}-1`,
  provider,
  model,
  status: 200,
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  ms: 900,
  firstByteMs: input,
  attempts: 1,
})

const since = (range: string, now: Timestamp): Timestamp => rangeStart(range, now) ?? now

const sum = (activity: ReadonlyArray<ReadonlyArray<number>>): number =>
  activity.reduce((total, row) => total + row.reduce((a, b) => a + b, 0), 0)

const WARMUP = "slopmax"

describe("history", () => {
  it("days_fill_their_buckets_by_provider", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("7d", now)
    const today = Timestamp.add(start, SignedDuration.fromHours(24 * 6 + 1))
    const entries = [
      entry(Timestamp.add(start, SignedDuration.fromHours(1)), "claude", "claude-opus-5-5", 100),
      entry(today, "claude", "claude-opus-5-5", 300),
      entry(today, "codex", "gpt-6-sol", 50),
    ]
    const names = new Map([["claude-1", "me@x.dev"]])
    const history = build(entries, "week", start, now, {}, names)
    expect(history.buckets.length).toBe(7)
    expect(history.providers).toEqual(["claude", "codex"])
    expect(history.buckets[0]?.tokens).toEqual([110, 0])
    expect(history.buckets[6]?.tokens).toEqual([310, 60])
    expect(history.buckets[6]?.requests).toBe(2)
    expect(history.buckets.slice(1, 6).every((b) => b.requests === 0)).toBe(true)
    expect(history.total.requests).toBe(3)
    // The busiest first, under its display name.
    expect(history.models[0]?.name).toBe("claude-opus-5-5")
    expect(history.accounts[0]?.name).toBe("me@x.dev")
    expect(history.accounts[1]?.name).toBe("codex-1")
    expect(sum(history.activity)).toBe(3)
  })

  it("failover_failures_and_housekeeping_count_apart", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("today", now)
    const at = Math.max(start, Timestamp.sub(now, SignedDuration.fromMins(1)))
    const rescued = { ...entry(at, "claude", "claude-opus-5-5", 100), attempts: 2 }
    const failed = without(
      { ...entry(at, "claude", "claude-opus-5-5", 0), status: 429, input: 0, output: 0 },
      "firstByteMs",
    )
    // Spent before any account could be tried.
    const refused = { ...failed, account: "" }
    // An agent listing models.
    const listing = without({ ...entry(at, "claude", "-", 0), input: 0, output: 0 }, "model")
    const history = build([rescued, failed, refused, listing], "today", start, now, {}, new Map())
    expect([history.total.requests, history.total.failed]).toEqual([1, 2])
    expect(history.rescued).toBe(1)
    const bucket = history.buckets.at(-1)
    expect([bucket?.requests, bucket?.failed, bucket?.rescued]).toEqual([1, 2, 1])
    // The account the failure reached counts it; no account, no row.
    expect(history.accounts.length).toBe(1)
    expect(history.accounts[0]?.totals.failed).toBe(1)
    // The failure no account took.
    expect(history.unplaced).toBe(1)
    expect(history.models.length).toBe(1)
  })

  it("api_keys_bill_what_subscriptions_only_value", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("today", now)
    const at = Math.max(start, Timestamp.sub(now, SignedDuration.fromMins(1)))
    const subscription = entry(at, "claude", "claude-opus-5-5", 1_000_000)
    const key = entry(at, "anthropic", "claude-opus-5-5", 1_000_000)
    const history = build([subscription, key], "today", start, now, {}, new Map())
    // 1M input at $4 and 10 output: both valued, one of them billed.
    const each = 4.0 + (10.0 * 20.0) / 1e6
    expect(Math.abs(history.total.cost - 2.0 * each)).toBeLessThan(1e-9)
    expect(Math.abs(history.billed - each)).toBeLessThan(1e-9)
  })

  it("caching_speed_sessions_and_agents", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("7d", now)
    const at = Timestamp.sub(now, SignedDuration.fromMins(1))
    const prices = { m: { input: 10, output: 0, cacheRead: 1 } }
    const answer = (session: string): Entry => ({
      ...entry(at, "claude", "m", 0),
      cacheRead: 1_000_000,
      output: 1_000,
      ms: 11_000,
      firstByteMs: 1_000,
      agent: "claude",
      session,
    })
    const warmup: Entry = { ...entry(at, "codex", "gpt-6-sol", 5), agent: "slopmax" }
    const history = build([answer("a"), answer("a"), answer("b"), warmup], "week", start, now, prices, new Map())
    // Three million tokens read from cache at $1 instead of $10.
    expect(Math.abs(history.cacheSaved - 27)).toBeLessThan(1e-9)
    expect(history.sessions).toBe(2)
    expect(history.speeds[0]?.model).toBe("m")
    expect(Math.abs((history.speeds[0]?.tokensPerSecond ?? 0) - 100)).toBeLessThan(1e-9)
    expect(history.agents.map((a) => a.name)).toEqual(["Claude Code", "Warmups"])
    expect(history.monthly).not.toBeNull()
    // The warmup is neither work nor input that missed the cache.
    expect(sum(history.activity)).toBe(3)
    expect(history.cached).toBe(1)
    expect(history.buckets.at(-1)?.cached).toBe(1)
  })

  it("an_hour_of_warmups_alone_has_no_cache_rate", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("today", now)
    const warmup: Entry = {
      ...entry(Math.max(start, Timestamp.sub(now, SignedDuration.fromMins(1))), "codex", "gpt-6-sol", 9),
      agent: WARMUP,
    }
    const history = build([warmup], "today", start, now, {}, new Map())
    expect(history.total.requests).toBe(1)
    expect(history.buckets.at(-1)?.cached).toBeNull()
    expect(history.cached).toBeNull()
    expect(history.activity.flat().every((n) => n === 0)).toBe(true)
  })

  it("today_counts_hours_up_to_now", () => {
    const start = ts(1_000_000)
    const now = Timestamp.add(start, SignedDuration.fromHours(5))
    const history = build([], "today", start, now, {}, new Map())
    expect(history.buckets.map((b) => b.label)).toEqual(["00:00", "01:00", "02:00", "03:00", "04:00", "05:00"])
    expect(history.providers).toEqual([])
  })

  it("work_falls_on_the_local_weekday_and_hour", () => {
    // 1970-01-01 00:16:40 UTC, a Thursday.
    expect(when(ts(1_000), SignedDuration.ZERO)).toEqual([3, 0])
    // Five hours west it is still Wednesday evening.
    expect(when(ts(1_000), SignedDuration.fromSecs(-5 * 3_600))).toEqual([2, 19])
  })

  it("first_bytes_read_as_median_and_slowest_twentieth", () => {
    const waits = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(waits, 50)).toBe(51)
    expect(percentile(waits, 95)).toBe(96)
    expect(percentile([], 50)).toBeUndefined()
  })
})

describe("history, beyond the Rust tests", () => {
  it("ranges_have_titles_keys_and_json_names", () => {
    expect(Range.ALL.map(Range.title)).toEqual(["Today", "7 Days", "30 Days"])
    expect(Range.ALL.map(Range.key)).toEqual(["today", "7d", "30d"])
    expect(Range.parse("30d")).toBe("month")
    expect(Range.parse("all")).toBeUndefined()
    expect(Range.default).toBe("week")
  })

  it("history_json_has_rusts_keys_in_order", () => {
    const now = Timestamp.nowUnsafe()
    const start = since("7d", now)
    const at = Timestamp.sub(now, SignedDuration.fromMins(1))
    const answer: Entry = { ...entry(at, "claude", "claude-opus-5-5", 100), cacheRead: 50, agent: "claude" }
    const history = build([answer], "week", start, now, {}, new Map())
    const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(HistorySchema)(history)))
    expect(Object.keys(encoded)).toEqual([
      "range",
      "buckets",
      "providers",
      "total",
      "rescued",
      "unplaced",
      "billed",
      "left",
      "cache_saved",
      "cached",
      "sessions",
      "first_byte",
      "monthly",
      "activity",
      "models",
      "accounts",
      "agents",
      "speeds",
    ])
    expect(encoded.range).toBe("week")
    expect(Object.keys(encoded.buckets[0])).toEqual([
      "label",
      "tokens",
      "requests",
      "failed",
      "rescued",
      "sessions",
      "cost",
      "cached",
      "first_byte",
    ])
    expect(encoded.buckets.at(-1).first_byte).toEqual([100, 100])
    expect(encoded.activity.length).toBe(7)
    // An f32 share, as serde_json writes one.
    const text = JSON.stringify(Schema.encodeSync(HistorySchema)(history))
    expect(text).toContain('"cached":0.33333334,')
    expect(text).toContain('"first_byte":100,')
  })

  it.live("load_reads_the_ledger_and_the_windows_that_reset", () =>
    Effect.gen(function* () {
      const home = Home.at(tempDir("history"))
      const now = Timestamp.nowUnsafe()
      const at = Timestamp.sub(now, SignedDuration.fromMins(1))
      yield* append(home.usage(), [entry(at, "claude", "claude-opus-5-5", 100)])
      yield* waste.append(home.windows(), [
        { endedAt: at, account: "claude-1", provider: "claude", plan: "max 20x", span: "7d", used: 40 },
      ])
      const history = yield* load(home, "week", now, { models: {}, plans: {} }, new Map([["claude-1", "me"]]))
      expect(history.total.requests).toBe(1)
      expect(history.left.windows).toBe(1)
      expect(history.left.accounts[0]?.name).toBe("me")
    }),
  )
})
