// What the ledger says, shaped for the tables and charts that show it: the
// summary `slopmax usage` prints, the history the dashboard and the desktop
// chart, and the quota the resets threw away. Everything here is pure: the
// records, the prices, the clock and the time zone are all arguments, so a
// day boundary or a clock change is tested by passing a zone.
//
// Three kinds of request are told apart throughout. A failure (status 400 or
// more) counts only as failed. An answer moved tokens and counts everywhere.
// Anything else is an agent's housekeeping (listing models, counting
// tokens) and counts nowhere.
import {
  type AccountId,
  AccountTotals,
  agentFacts,
  History,
  HistoryBucket,
  type HistoryRange,
  isAnswer,
  isFailed,
  LeftAccount,
  LeftOnTheTable,
  type LedgerRecord,
  NamedTotals,
  noAccountFree,
  type ProviderId,
  providerOrder,
  isSubscription,
  type RequestRecord,
  type RequestSender,
  type Span,
  Speed,
  Summary,
  type SummaryBy,
  type SummaryRange,
  SummaryRow,
  Totals,
  type WindowEndedRecord,
} from "@slopmax/domain"
import { money } from "@slopmax/domain/format"
import { DateTime } from "effect"
import { costAt, type Pricing, type Rates } from "./pricing.ts"

/** Everything the views need besides the records. */
export interface ViewContext {
  /** Accounts' names as people know them; an account not here shows its id. */
  readonly names: ReadonlyMap<AccountId, string>
  readonly pricing: Pricing
  readonly now: DateTime.Utc
  /** Where "today", days and hours are counted. */
  readonly zone: DateTime.TimeZone
}

// ---------------------------------------------------------------------------
// Local time

/** A moment's day and hour on the clock in `zone`. */
interface Local {
  /** Days since 1970-01-01 on the local calendar. */
  readonly day: number
  readonly hour: number
  /** Monday is 0. */
  readonly weekday: number
}

const hourMillis = 3_600_000
const dayMillis = 86_400_000

const offsetAt = (millis: number, zone: DateTime.TimeZone): number =>
  DateTime.zonedOffset(DateTime.setZone(DateTime.makeUnsafe(millis), zone))

/**
 * Turns moments into local days and hours. Asking the system's time zone
 * data is slow next to everything else a view does per record (a month of
 * heavy use is over a hundred thousand records), and a zone's offset only
 * changes a few times a year, so the offset is looked up once per UTC hour
 * and reused. An hour with a clock change in it is looked up per moment.
 */
const localClock = (zone: DateTime.TimeZone): ((at: DateTime.DateTime) => Local) => {
  const byHour = new Map<number, number | undefined>()
  const offsetOf = (millis: number): number => {
    if (zone._tag === "Offset") return zone.offset
    const hour = Math.floor(millis / hourMillis)
    let offset = byHour.get(hour)
    if (offset === undefined && !byHour.has(hour)) {
      const start = offsetAt(hour * hourMillis, zone)
      offset = start === offsetAt(hour * hourMillis + hourMillis - 1, zone) ? start : undefined
      byHour.set(hour, offset)
    }
    return offset ?? offsetAt(millis, zone)
  }
  return (at) => {
    const millis = DateTime.toEpochMillis(at)
    const local = millis + offsetOf(millis)
    const day = Math.floor(local / dayMillis)
    return {
      day,
      hour: Math.floor((local - day * dayMillis) / hourMillis),
      // 1970-01-01 was a Thursday.
      weekday: (((day + 3) % 7) + 7) % 7,
    }
  }
}

/** A local day's calendar date. */
const dateOf = (day: number): { readonly year: number; readonly month: number; readonly date: number } => {
  const { year, month, day: date } = DateTime.toPartsUtc(DateTime.makeUnsafe(day * dayMillis))
  return { year, month, date }
}

const two = (n: number) => String(n).padStart(2, "0")

/** Local midnight `daysBack` calendar days before `now`'s date, whatever clock changes lie between. */
const midnight = (now: DateTime.Utc, zone: DateTime.TimeZone, daysBack: number): DateTime.Utc => {
  const today = dateOf(localClock(zone)(now).day)
  return DateTime.toUtc(
    DateTime.makeZonedUnsafe(
      { year: today.year, month: today.month, day: today.date - daysBack },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  )
}

const rangeDays: { readonly [K in SummaryRange]: number | undefined } = {
  today: 0,
  "7d": 6,
  "30d": 29,
  all: undefined,
}

/** Where a range starts: local midnight today, six or 29 days before that, or the epoch for `all`. */
export const rangeStart = (range: SummaryRange, now: DateTime.Utc, zone: DateTime.TimeZone): DateTime.Utc => {
  const days = rangeDays[range]
  return days === undefined ? DateTime.makeUnsafe(0) : midnight(now, zone, days)
}

// ---------------------------------------------------------------------------
// Totals

/**
 * A request as the views add it up, read once: whether it was an answer or
 * a failure, and what it cost (undefined when its model has no price). A
 * record is added to several totals at once, so these are worked out once
 * per record, and each model's prices once per view.
 */
interface Read {
  readonly record: RequestRecord
  readonly answered: boolean
  readonly failed: boolean
  readonly cost: number | undefined
  readonly rates: Rates | undefined
}

/** Reads records for one view, looking each model's prices up once. */
const readerOf = (pricing: Pricing): ((record: RequestRecord) => Read) => {
  const known = new Map<string, Rates | undefined>()
  const ratesOf = (model: string): Rates | undefined => {
    if (known.has(model)) return known.get(model)
    const rates = pricing.rates(model)
    known.set(model, rates)
    return rates
  }
  return (record) => {
    const answered = isAnswer(record)
    const rates = answered && record.model !== undefined ? ratesOf(record.model) : undefined
    return {
      record,
      answered,
      failed: isFailed(record),
      cost: rates === undefined ? undefined : costAt(rates, record.usage),
      rates,
    }
  }
}

/** Totals while they are added up. */
class Tally {
  requests = 0
  input = 0
  output = 0
  cacheRead = 0
  cacheWrite = 0
  cost = 0
  unpriced = 0
  failed = 0

  /** Counts a request: an answer everywhere, a failure as failed, housekeeping not at all. */
  add(read: Read): void {
    if (read.failed) {
      this.failed += 1
      return
    }
    if (!read.answered) return
    const { record, cost } = read
    if (cost === undefined) this.unpriced += 1
    else this.cost += cost
    this.requests += 1
    this.input += record.usage.input
    this.output += record.usage.output
    this.cacheRead += record.usage.cacheRead
    this.cacheWrite += record.usage.cacheWrite
  }

  get tokens(): number {
    return this.input + this.output + this.cacheRead + this.cacheWrite
  }

  /** The share of input read from cache, when any input came in. */
  get cached(): number | undefined {
    const input = this.input + this.cacheRead + this.cacheWrite
    return input > 0 ? this.cacheRead / input : undefined
  }

  totals(): Totals {
    return new Totals({
      requests: this.requests,
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      // Rounded to a millionth of a dollar, so sums read 0.227, not 0.22701000000000002.
      cost: Math.round(this.cost * 1e6) / 1e6,
      unpriced: this.unpriced,
      failed: this.failed,
    })
  }
}

/** A cost as people read it: `$1.20`; `$1.20+` when some answers had no price; `—` when none had one. */
export const costLabel = (totals: Totals): string => {
  if (totals.unpriced === 0) return money(totals.cost)
  return totals.unpriced === totals.requests ? "—" : `${money(totals.cost)}+`
}

const requestsOf = (records: ReadonlyArray<LedgerRecord>, since: DateTime.Utc): ReadonlyArray<RequestRecord> => {
  const from = since.epochMilliseconds
  const found: Array<RequestRecord> = []
  for (const record of records) {
    if (record._tag === "Request" && record.at.epochMilliseconds >= from) found.push(record)
  }
  return found
}

const nameOf = (ctx: ViewContext, id: AccountId): string => ctx.names.get(id) ?? id

// ---------------------------------------------------------------------------
// Summary

/** `slopmax usage`: totals since the range's start, in rows by local day, model, or account. */
export const summary = (
  records: ReadonlyArray<LedgerRecord>,
  range: SummaryRange,
  by: SummaryBy,
  ctx: ViewContext,
): Summary => {
  const since = rangeStart(range, ctx.now, ctx.zone)
  const localOf = localClock(ctx.zone)
  const keyOf = (record: RequestRecord): string => {
    switch (by) {
      case "model":
        return record.model ?? "-"
      case "account":
        // Failures no account was free to take.
        return record.account === undefined ? noAccountFree : nameOf(ctx, record.account)
      case "day": {
        const local = dateOf(localOf(record.at).day)
        return `${local.year}-${two(local.month)}-${two(local.date)}`
      }
    }
  }
  const rows = new Map<string, Tally>()
  const total = new Tally()
  const readOf = readerOf(ctx.pricing)
  for (const record of requestsOf(records, since)) {
    const read = readOf(record)
    // Housekeeping makes no row of its own.
    if (!read.answered && !read.failed) continue
    const key = keyOf(record)
    let row = rows.get(key)
    if (row === undefined) {
      row = new Tally()
      rows.set(key, row)
    }
    row.add(read)
    total.add(read)
  }
  return new Summary({
    range,
    by,
    since,
    rows: [...rows.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, row]) => new SummaryRow({ key, totals: row.totals() })),
    total: total.totals(),
  })
}

// ---------------------------------------------------------------------------
// Quota left on the table

const weeksInAMonth = 52 / 12

/**
 * What the unused part of a window cost: the share of the plan's monthly fee
 * that buys that span. A week is a month's fee over 52/12 weeks; a month is
 * the whole fee. The 5-hour window and a window on one model are worth
 * nothing apart, since the fee buys the week. Nothing when the plan or its
 * price is not known.
 */
export const unusedValue = (
  window: {
    readonly provider: ProviderId
    readonly plan?: string | undefined
    readonly span: Span
    readonly model?: string | undefined
    readonly used: number
  },
  pricing: Pick<Pricing, "planFee">,
): number | undefined => {
  if (window.model !== undefined || window.span === "5h") return 0
  const share = window.span === "7d" ? 1 / weeksInAMonth : 1
  if (window.plan === undefined) return undefined
  const fee = pricing.planFee(window.provider, window.plan)
  if (fee === undefined) return undefined
  return fee * share * (Math.min(100, Math.max(0, 100 - window.used)) / 100)
}

const isLong = (record: WindowEndedRecord) => record.model === undefined && record.span !== "5h"

/**
 * The windows that ended at or after `since`, oldest first, each once: the
 * same window can be recorded twice when a restart sees its reset again.
 */
export const windowsEnded = (
  records: ReadonlyArray<LedgerRecord>,
  since: DateTime.Utc,
): ReadonlyArray<WindowEndedRecord> => {
  const seen = new Map<string, WindowEndedRecord>()
  for (const record of records) {
    if (record._tag !== "WindowEnded" || record.at.epochMilliseconds < since.epochMilliseconds) continue
    const key = [record.account, record.span, record.model ?? "", DateTime.toEpochMillis(record.at)].join("\0")
    if (!seen.has(key)) seen.set(key, record)
  }
  return [...seen.values()].toSorted((a, b) => DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at))
}

/** Weekly and monthly quota that resets threw away, and what that part of each plan cost, by account. */
export const left = (ended: ReadonlyArray<WindowEndedRecord>, ctx: ViewContext): LeftOnTheTable => {
  let windows = 0
  let unusedSum = 0
  let dollars = 0
  let unpriced = 0
  const accounts = new Map<
    string,
    { name: string; provider: ProviderId; windows: number; unused: number; dollars: number }
  >()
  for (const record of ended) {
    if (!isLong(record)) continue
    const unused = Math.min(100, Math.max(0, 100 - record.used))
    const value = unusedValue(record, ctx.pricing)
    windows += 1
    unusedSum += unused
    if (value === undefined) unpriced += 1
    else dollars += value
    const name = nameOf(ctx, record.account)
    const key = `${name}\0${record.provider}`
    const account = accounts.get(key) ?? { name, provider: record.provider, windows: 0, unused: 0, dollars: 0 }
    account.windows += 1
    account.unused += unused
    account.dollars += value ?? 0
    accounts.set(key, account)
  }
  if (windows === 0) return LeftOnTheTable.none
  const rows = [...accounts.values()]
    .toSorted((a, b) =>
      a.name === b.name ? providerRank(a.provider) - providerRank(b.provider) : a.name < b.name ? -1 : 1,
    )
    .map(
      (account) =>
        new LeftAccount({
          name: account.name,
          provider: account.provider,
          windows: account.windows,
          unused: account.unused / account.windows,
          dollars: account.dollars,
        }),
    )
    .toSorted((a, b) => b.dollars - a.dollars || b.unused - a.unused)
  return new LeftOnTheTable({ windows, unused: unusedSum / windows, dollars, unpriced, accounts: rows })
}

// ---------------------------------------------------------------------------
// History

/** Answers shorter than this say little about a model's speed. */
export const speedMinOutput = 64

const providerRank = (provider: ProviderId): number => providerOrder.indexOf(provider)

/** An agent as the charts name it; slopmax's own warmups are apart from the agents' work. */
export const senderName = (sender: RequestSender | undefined): string =>
  sender === undefined ? "Other" : sender === "slopmax" ? "Warmups" : agentFacts[sender].title

/**
 * The value at the `p`th percentile: the sorted values' element at
 * `length × p / 100`, so the median of 1..100 is 51 and the 95th is 96.
 */
export const percentile = (sorted: ReadonlyArray<number>, p: number): number | undefined =>
  sorted.length === 0 ? undefined : sorted[Math.min(Math.floor((sorted.length * p) / 100), sorted.length - 1)]

/** Output tokens a second once the answer began, when it was long enough to say. */
export const speedOf = (record: RequestRecord): number | undefined => {
  if (record.firstByteMs === undefined || record.usage.output < speedMinOutput) return undefined
  const writing = record.ms - record.firstByteMs
  return writing > 0 ? (record.usage.output * 1_000) / writing : undefined
}

/** Where a moment falls among a history's buckets: its local hour today, or its local day of the range. */
const slotOf = (range: HistoryRange, local: Local, first: Local): number =>
  range === "today" ? local.hour : local.day - first.day

class Filling {
  readonly totals = new Tally()
  /** The agents' answers, warmups aside. */
  readonly work = new Tally()
  readonly tokens: Array<number>
  rescued = 0
  readonly sessions = new Set<string>()
  readonly waits: Array<number> = []

  constructor(providers: number) {
    this.tokens = Array.from({ length: providers }, () => 0)
  }
}

const sortedNumbers = (values: ReadonlyArray<number>): ReadonlyArray<number> => values.toSorted((a, b) => a - b)

const dayLabels = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const labelOf = (range: HistoryRange, first: Local, index: number): string =>
  range === "today" ? `${two(index)}:00` : dayLabels.format((first.day + index) * dayMillis)

/** Most tokens first, then most failures; ties keep their order. */
const ranked = <A extends { readonly totals: Tally }>(groups: ReadonlyArray<A>): ReadonlyArray<A> =>
  groups.toSorted((a, b) => b.totals.tokens - a.totals.tokens || b.totals.failed - a.totals.failed)

/**
 * `GET /history`: what went through slopmax over the range, hour by hour for
 * today and day by day otherwise; by provider, model, account and agent; what
 * failover saved and what failed; what caching saved; how soon answers began
 * and how fast they came; when the work happens; and what the range's resets
 * left on the table.
 */
export const history = (records: ReadonlyArray<LedgerRecord>, range: HistoryRange, ctx: ViewContext): History => {
  const since = rangeStart(range, ctx.now, ctx.zone)
  const localOf = localClock(ctx.zone)
  const first = localOf(since)
  const count = range === "today" ? localOf(ctx.now).hour + 1 : range === "7d" ? 7 : 30
  const requests = requestsOf(records, since)
  const providers = providerOrder.filter((provider) =>
    requests.some((record) => record.provider === provider && isAnswer(record)),
  )

  const buckets = Array.from({ length: count }, () => new Filling(providers.length))
  const total = new Tally()
  const work = new Tally()
  const billed = new Tally()
  let rescued = 0
  let unplaced = 0
  let cacheSaved = 0
  const sessions = new Set<string>()
  const waits: Array<number> = []
  const activity = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const models = new Map<string, { name: string; totals: Tally }>()
  const accounts = new Map<string, { name: string; provider: ProviderId; totals: Tally }>()
  const agents = new Map<string, { name: string; totals: Tally }>()
  const speeds = new Map<string, { model: string; provider: ProviderId; each: Array<number> }>()

  const readOf = readerOf(ctx.pricing)
  for (const record of requests) {
    const local = localOf(record.at)
    const bucket = buckets[slotOf(range, local, first)]
    if (bucket === undefined) continue
    const read = readOf(record)
    bucket.totals.add(read)
    total.add(read)
    const { answered, failed } = read
    // A failure counts against the account it reached, when it reached one.
    if (record.account !== undefined && (answered || failed)) {
      const name = nameOf(ctx, record.account)
      const key = `${name}\0${record.provider}`
      const account = accounts.get(key) ?? { name, provider: record.provider, totals: new Tally() }
      account.totals.add(read)
      accounts.set(key, account)
    }
    if (failed && record.account === undefined) unplaced += 1
    if (!answered) continue

    if (!isSubscription(record.provider)) billed.add(read)
    const column = providers.indexOf(record.provider)
    if (column >= 0) bucket.tokens[column] = (bucket.tokens[column] ?? 0) + record.usage.tokens
    if (record.attempts > 1) {
      bucket.rescued += 1
      rescued += 1
    }
    if (record.firstByteMs !== undefined) {
      bucket.waits.push(record.firstByteMs)
      waits.push(record.firstByteMs)
    }
    // An agent's conversation; warmups have none.
    if (record.session !== undefined) {
      bucket.sessions.add(record.session)
      sessions.add(record.session)
    }
    const model = record.model ?? "unknown"
    const rates = read.rates
    if (rates !== undefined) cacheSaved += (record.usage.cacheRead * (rates.input - rates.cacheRead)) / 1e6
    const speed = speedOf(record)
    if (speed !== undefined) {
      const key = `${model}\0${record.provider}`
      const entry = speeds.get(key) ?? { model, provider: record.provider, each: [] }
      entry.each.push(speed)
      speeds.set(key, entry)
    }
    // Warmups keep a window open at slopmax's hours; they are not the work, and never read the cache.
    if (record.agent !== "slopmax") {
      bucket.work.add(read)
      work.add(read)
      const row = activity[local.weekday]
      if (row !== undefined) row[local.hour] = (row[local.hour] ?? 0) + 1
    }
    const modelGroup = models.get(model) ?? { name: model, totals: new Tally() }
    modelGroup.totals.add(read)
    models.set(model, modelGroup)
    const agent = senderName(record.agent)
    const agentGroup = agents.get(agent) ?? { name: agent, totals: new Tally() }
    agentGroup.totals.add(read)
    agents.set(agent, agentGroup)
  }

  const firstByte = percentile(sortedNumbers(waits), 50)
  const cached = work.cached
  const monthly = range === "7d" ? (total.cost * 30) / 7 : undefined

  return new History({
    range,
    buckets: buckets.map((bucket, index) => {
      const sorted = sortedNumbers(bucket.waits)
      const p50 = percentile(sorted, 50)
      const p95 = percentile(sorted, 95)
      const bucketCached = bucket.work.cached
      return new HistoryBucket({
        label: labelOf(range, first, index),
        tokens: bucket.tokens,
        requests: bucket.totals.requests,
        failed: bucket.totals.failed,
        rescued: bucket.rescued,
        sessions: bucket.sessions.size,
        cost: bucket.totals.cost,
        ...(bucketCached === undefined ? {} : { cached: bucketCached }),
        ...(p50 === undefined || p95 === undefined ? {} : { firstByte: [p50, p95] as const }),
      })
    }),
    providers,
    total: total.totals(),
    rescued,
    unplaced,
    billed: billed.cost,
    left: left(windowsEnded(records, since), ctx),
    cacheSaved,
    ...(cached === undefined ? {} : { cached }),
    sessions: sessions.size,
    ...(firstByte === undefined ? {} : { firstByte }),
    ...(monthly === undefined ? {} : { monthly }),
    activity,
    models: ranked([...models.values()].toSorted(byName)).map(
      (group) => new NamedTotals({ name: group.name, totals: group.totals.totals() }),
    ),
    accounts: ranked([...accounts.values()].toSorted(byNameThenProvider)).map(
      (group) => new AccountTotals({ name: group.name, provider: group.provider, totals: group.totals.totals() }),
    ),
    agents: ranked([...agents.values()].toSorted(byName)).map(
      (group) => new NamedTotals({ name: group.name, totals: group.totals.totals() }),
    ),
    speeds: [...speeds.values()]
      .toSorted(byModelThenProvider)
      .flatMap((entry) => {
        const median = sortedNumbers(entry.each)[Math.floor(entry.each.length / 2)]
        return median === undefined
          ? []
          : [new Speed({ model: entry.model, provider: entry.provider, tokensPerSecond: median })]
      })
      .toSorted((a, b) => b.tokensPerSecond - a.tokensPerSecond),
  })
}

const byName = <A extends { readonly name: string }>(a: A, b: A): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

const byNameThenProvider = <A extends { readonly name: string; readonly provider: ProviderId }>(a: A, b: A): number =>
  byName(a, b) || providerRank(a.provider) - providerRank(b.provider)

const byModelThenProvider = (
  a: { readonly model: string; readonly provider: ProviderId },
  b: { readonly model: string; readonly provider: ProviderId },
): number => (a.model < b.model ? -1 : a.model > b.model ? 1 : providerRank(a.provider) - providerRank(b.provider))
