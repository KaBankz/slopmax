// What the Usage and Performance pages, and the overview's Today and
// per-day panels, say about a history: the figures across the top with
// their trend lines, the tables, and the token mix. The history is the
// ledger's own shape (`GET /history`).
import { type History, type HistoryBucket, providerFacts, type Summary, Totals } from "@slopmax/client"
import { compact, fixed, grouped, providerTitle } from "@slopmax/client/format"
import type { SparkPoint } from "./charts.ts"
import { count, dollars, headlineDollars, priced } from "./words.ts"

/** How a figure moved since the span before. */
export interface Change {
  /** `12.0%`, by how much either way. */
  readonly text: string
  readonly direction: "up" | "down" | "flat"
  /** Against what, in short: `w/w`, `vs yesterday`. */
  readonly versus: string
  /** `1,204 yesterday by this hour`. */
  readonly tip: string
}

/** A figure's line over its buckets, in one of the trend colors. */
export interface Trend {
  readonly series: 1 | 2 | 3 | 4
  readonly points: ReadonlyArray<SparkPoint>
}

/** A figure with its caption, how it moved when there is a span before to tell, and its trend. */
export interface Stat {
  readonly title: string
  readonly value: string
  readonly note: string
  readonly change?: Change
  readonly trend?: Trend
}

/** What the span before a range is called: `yesterday by this hour`, `the 7 days before`. */
const before = (history: History): string =>
  history.range === "today" ? "yesterday by this hour" : "the 7 days before"

/** The span before a range, in short. */
const versus = (history: History): string => (history.range === "today" ? "vs yesterday" : "w/w")

/** How `now` moved from `then`; nothing when there was nothing then to move from. */
export const change = (now: number, then: number, said: string, when: string, against: string): Change | undefined => {
  if (then <= 0) return undefined
  const percent = ((now - then) / then) * 100
  const flat = Math.abs(percent) < 0.05
  return {
    text: `${fixed(flat ? 0 : Math.abs(percent), 1)}%`,
    direction: flat ? "flat" : percent > 0 ? "up" : "down",
    versus: against,
    tip: `${said} ${when}`,
  }
}

/** A stat with its change from the span before, when the history has one. */
const moved = (
  stat: Stat,
  history: History,
  pick: (totals: History["total"]) => number,
  say: (n: number) => string,
) => {
  const previous = history.previous
  if (previous === undefined) return stat
  const changed = change(
    pick(history.total),
    pick(previous.total),
    say(pick(previous.total)),
    before(history),
    versus(history),
  )
  return changed === undefined ? stat : { ...stat, change: changed }
}

/** Every token a bucket moved. */
const bucketTokens = (bucket: HistoryBucket): number => bucket.tokens.reduce((sum, n) => sum + n, 0)

/** A figure's trend over `buckets`: a point each, its tooltip the bucket and the figure in words. */
const trend = (
  buckets: ReadonlyArray<HistoryBucket>,
  series: Trend["series"],
  pick: (bucket: HistoryBucket) => number | undefined,
  say: (n: number) => string,
): Trend => ({
  series,
  points: buckets.map((bucket) => {
    const value = pick(bucket)
    return { label: bucket.label, value, tip: value === undefined ? bucket.label : `${bucket.label}\n${say(value)}` }
  }),
})

/** The share of input read from cache, as words: `62% from cache`. */
const cacheNote = (cached: number | undefined) =>
  cached === undefined ? "no cache reads" : `${fixed(cached * 100, 0)}% from cache`

/** Whether a history has nothing in it. */
export const isQuiet = (history: History): boolean => history.total.requests === 0 && history.total.failed === 0

/** The overview's Today panel. */
export const todayStats = (history: History): ReadonlyArray<Stat> => [
  moved(
    {
      title: "Requests",
      value: grouped(history.total.requests),
      note: history.total.failed === 0 ? "none failed" : `${grouped(history.total.failed)} failed`,
      trend: trend(
        history.buckets,
        3,
        (b) => b.requests,
        (n) => count(n, "request"),
      ),
    },
    history,
    (t) => t.requests,
    grouped,
  ),
  moved(
    {
      title: "Tokens",
      value: compact(history.total.tokens),
      note: cacheNote(history.cached),
      trend: trend(history.buckets, 2, bucketTokens, (n) => `${compact(n)} tokens`),
    },
    history,
    (t) => t.input + t.output + t.cacheRead + t.cacheWrite,
    compact,
  ),
  moved(
    {
      title: "API value",
      value: priced(history.total.cost, history.total.unpriced, history.total.requests),
      note: "what the API would charge",
      trend: trend(
        history.buckets,
        1,
        (b) => b.cost,
        (n) => `${dollars(n)} at API prices`,
      ),
    },
    history,
    (t) => t.cost,
    dollars,
  ),
  {
    title: "Saved by failover",
    value: grouped(history.rescued),
    note: "answered by another account",
    trend: trend(
      history.buckets,
      4,
      (b) => b.rescued,
      (n) => `${grouped(n)} saved by failover`,
    ),
  },
]

/** The Usage page's figures. */
export const usageStats = (history: History): ReadonlyArray<Stat> => {
  const total = history.total
  const value = priced(total.cost, total.unpriced, total.requests)
  const valueNote =
    history.billed > 0
      ? `Billed to API keys ${dollars(history.billed)}`
      : total.unpriced === 0 || total.unpriced < total.requests
        ? "at API prices"
        : `${count(total.unpriced, "request")} unpriced`
  return [
    moved(
      {
        title: "Tokens",
        value: compact(total.tokens),
        note: cacheNote(history.cached),
        trend: trend(history.buckets, 2, bucketTokens, (n) => `${compact(n)} tokens`),
      },
      history,
      (t) => t.input + t.output + t.cacheRead + t.cacheWrite,
      compact,
    ),
    moved(
      {
        title: "Requests",
        value: grouped(total.requests),
        note: history.sessions > 0 ? `in ${count(history.sessions, "conversation")}` : "answered",
        trend: trend(
          history.buckets,
          3,
          (b) => b.requests,
          (n) => count(n, "request"),
        ),
      },
      history,
      (t) => t.requests,
      grouped,
    ),
    moved(
      {
        title: "API value",
        value,
        note: valueNote,
        trend: trend(
          history.buckets,
          1,
          (b) => b.cost,
          (n) => `${dollars(n)} at API prices`,
        ),
      },
      history,
      (t) => t.cost,
      dollars,
    ),
    {
      title: "A month at this pace",
      value: history.monthly === undefined ? "—" : dollars(history.monthly),
      note: history.range === "7d" ? "at API prices" : "from a week's use",
    },
  ]
}

/** The Performance page's figures. */
export const performanceStats = (history: History): ReadonlyArray<Stat> => {
  const total = history.total
  const asked = total.requests + total.failed
  return [
    {
      title: "Answered",
      value: asked === 0 ? "—" : `${fixed((total.requests / asked) * 100, 1)}%`,
      note: total.failed === 0 ? "none failed" : `${grouped(total.failed)} failed`,
      trend: trend(
        history.buckets,
        4,
        (b) => (b.requests + b.failed === 0 ? undefined : (b.requests / (b.requests + b.failed)) * 100),
        (n) => `${fixed(n, 1)}% answered`,
      ),
    },
    {
      title: "Saved by failover",
      value: grouped(history.rescued),
      note: "answered by another account",
      trend: trend(
        history.buckets,
        3,
        (b) => b.rescued,
        (n) => `${grouped(n)} saved by failover`,
      ),
    },
    {
      title: "From cache",
      value: history.cached === undefined ? "—" : `${fixed(history.cached * 100, 0)}%`,
      note: `saving ${priced(history.cacheSaved, 0, total.requests)}`,
      trend: trend(
        history.buckets,
        2,
        (b) => (b.cached === undefined ? undefined : b.cached * 100),
        (n) => `${fixed(n, 0)}% from cache`,
      ),
    },
    {
      title: "First byte",
      value: history.firstByte === undefined ? "—" : `${fixed(history.firstByte / 1000, 2)} s`,
      note: "the median wait",
      trend: trend(
        history.buckets,
        1,
        (b) => (b.firstByte === undefined ? undefined : b.firstByte[0] / 1000),
        (n) => `${fixed(n, 2)} s to the first byte`,
      ),
    },
  ]
}

/** What `pick` came to a day over `span`. */
const perDay = (span: ReadonlyArray<HistoryBucket>, pick: (day: HistoryBucket) => number): number =>
  span.reduce((sum, day) => sum + pick(day), 0) / span.length

/**
 * The overview's figures a day, from a month's history: each the average of
 * the last 7 whole days (fewer, for a ledger younger than a week), how it
 * moved from the 7 days before, and its line over every whole day since
 * the first that held a request. Today is left out, as it is not over.
 * None before a whole day has passed.
 */
export const dailyStats = (history: History): ReadonlyArray<Stat> => {
  const whole = history.buckets.slice(0, -1)
  const first = whole.findIndex((day) => day.requests + day.failed > 0)
  if (first < 0) return []
  const days = whole.slice(first)
  const week = days.slice(-7)
  const prior = days.length >= 14 ? days.slice(-14, -7) : []
  const figure = (
    title: string,
    series: Trend["series"],
    pick: (day: HistoryBucket) => number,
    say: (n: number) => string,
    note: string,
  ): Stat => {
    const then = prior.length === 0 ? 0 : perDay(prior, pick)
    const changed = change(perDay(week, pick), then, `${say(then)} a day`, "the 7 days before", "w/w")
    return {
      title,
      value: say(perDay(week, pick)),
      note: week.length < 7 ? `over ${count(week.length, "day")}` : note,
      ...(changed === undefined ? {} : { change: changed }),
      trend: trend(days, series, pick, say),
    }
  }
  return [
    figure("API value / day", 1, (day) => day.cost, headlineDollars, "at API prices"),
    figure("Tokens / day", 2, bucketTokens, compact, ""),
  ]
}

/** A row of a bar list: a name, how long its bar is against the largest, and its figures. */
export interface BarRow {
  readonly name: string
  readonly detail?: string
  readonly fraction: number
  readonly tokens: string
  readonly requests: string
  readonly value: string
}

const bars = (
  rows: ReadonlyArray<{ readonly name: string; readonly detail?: string; readonly totals: Totals }>,
): ReadonlyArray<BarRow> => {
  const most = Math.max(1, ...rows.map((row) => row.totals.tokens))
  return rows.map((row) => ({
    name: row.name,
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    fraction: row.totals.tokens / most,
    tokens: compact(row.totals.tokens),
    requests: count(row.totals.requests, "request"),
    value: priced(row.totals.cost, row.totals.unpriced, row.totals.requests),
  }))
}

/** How many models are named before the rest are summed as Other. */
export const topModels = 5

/** The models by tokens: the top five by name, then the rest as `Other` when it has tokens. */
export const modelRows = (history: History): ReadonlyArray<BarRow> => {
  const named = history.models.slice(0, topModels)
  const rest = history.models.slice(topModels)
  const other = rest.reduce(
    (sum, row) =>
      new Totals({
        requests: sum.requests + row.totals.requests,
        input: sum.input + row.totals.input,
        output: sum.output + row.totals.output,
        cacheRead: sum.cacheRead + row.totals.cacheRead,
        cacheWrite: sum.cacheWrite + row.totals.cacheWrite,
        cost: sum.cost + row.totals.cost,
        unpriced: sum.unpriced + row.totals.unpriced,
        failed: sum.failed + row.totals.failed,
      }),
    Totals.zero,
  )
  return bars([
    ...named.map((row) => ({ name: row.name, totals: row.totals })),
    ...(other.tokens > 0 ? [{ name: "Other", totals: other }] : []),
  ])
}

/** The agents by tokens. */
export const agentRows = (history: History): ReadonlyArray<BarRow> =>
  bars(history.agents.map((row) => ({ name: row.name, totals: row.totals })))

/** What the summary calls requests sent with slopmax's own key: here, or the hub read from another machine. */
const ownKey: ReadonlyArray<string> = ["this machine", "hub"]

/**
 * The machines that sent requests, most tokens first: none when only this
 * slopmax's own key did, as on a machine no other uses.
 */
export const machineRows = (summary: Summary): ReadonlyArray<BarRow> => {
  if (summary.rows.every((row) => ownKey.includes(row.key))) return []
  return bars(
    summary.rows
      .filter((row) => row.totals.requests > 0 || row.totals.failed > 0)
      .toSorted((a, b) => b.totals.tokens - a.totals.tokens || a.key.localeCompare(b.key))
      .map((row) => ({ name: row.key, totals: row.totals })),
  )
}

/** One part of the token mix. */
export interface MixPart {
  readonly title: string
  readonly tokens: number
  readonly share: number
  readonly series: 1 | 2 | 3 | 4
}

/** Input, cache reads, cache writes and output, as shares of every token. */
export const tokenMix = (total: Totals): ReadonlyArray<MixPart> => {
  const sum = total.tokens
  const parts: ReadonlyArray<Omit<MixPart, "share">> = [
    { title: "Input", tokens: total.input, series: 1 },
    { title: "Cache read", tokens: total.cacheRead, series: 2 },
    { title: "Cache write", tokens: total.cacheWrite, series: 3 },
    { title: "Output", tokens: total.output, series: 4 },
  ]
  return parts.map((part) => ({ ...part, share: sum === 0 ? 0 : part.tokens / sum }))
}

/** What each request carried in and brought back, on average. */
export const perRequest = (total: Totals): { readonly context: string; readonly output: string } => {
  const n = Math.max(1, total.requests)
  return {
    context: compact(Math.round((total.input + total.cacheRead + total.cacheWrite) / n)),
    output: compact(Math.round(total.output / n)),
  }
}

/** A row of the accounts table. */
export interface AccountRow {
  readonly name: string
  readonly provider: string
  readonly fraction: number
  readonly share: string
  readonly tokens: string
  readonly requests: string
  readonly failed: string
  readonly value: string
}

/** The accounts table: each account's share of the tokens, its figures, and a total. */
export const accountRows = (
  history: History,
): { readonly rows: ReadonlyArray<AccountRow>; readonly unplaced: number; readonly total: AccountRow } => {
  const sum = history.accounts.reduce((s, row) => s + row.totals.tokens, 0)
  const most = Math.max(1, ...history.accounts.map((row) => row.totals.tokens))
  const shareOf = (tokens: number) => (sum === 0 ? 0 : (tokens / sum) * 100)
  const rows = history.accounts.map((row) => ({
    name: row.name,
    provider: providerFacts[row.provider].title,
    fraction: row.totals.tokens / most,
    share: `${fixed(shareOf(row.totals.tokens), 0)}%`,
    tokens: compact(row.totals.tokens),
    requests: grouped(row.totals.requests),
    failed: row.totals.failed === 0 ? "—" : grouped(row.totals.failed),
    value: priced(row.totals.cost, row.totals.unpriced, row.totals.requests),
  }))
  const total = history.total
  return {
    rows,
    unplaced: history.unplaced,
    total: {
      name: "Total",
      provider: "",
      fraction: 1,
      share: sum === 0 ? "—" : "100%",
      tokens: compact(total.tokens),
      requests: grouped(total.requests),
      failed: total.failed === 0 ? "—" : grouped(total.failed),
      value: priced(total.cost, total.unpriced, total.requests),
    },
  }
}

/** The output speeds, fastest first, for the Performance page. */
export const speedRows = (
  history: History,
): ReadonlyArray<{ readonly model: string; readonly provider: string; readonly speed: string }> =>
  history.speeds.slice(0, 6).map((row) => ({
    model: row.model,
    provider: providerTitle(row.provider),
    speed: `${fixed(row.tokensPerSecond, 0)} tok/s`,
  }))

/** Today's tokens hour by hour, all 24 hours, for the overview's small chart. */
export const hourly = (history: History): ReadonlyArray<number> => {
  const hours = Array.from({ length: 24 }, () => 0)
  history.buckets.forEach((bucket, i) => {
    const hour = /^(\d{2}):/.exec(bucket.label)?.[1]
    const at = hour === undefined ? i : Number(hour)
    if (at >= 0 && at < 24) hours[at] = bucket.tokens.reduce((sum, n) => sum + n, 0)
  })
  return hours
}
