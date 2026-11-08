// What the Usage and Performance pages, and the overview's Today panel,
// say about a history: the figures across the top, the tables, and the
// token mix. The history is the ledger's own shape (`GET /history`).
import { type History, providerFacts, Totals } from "@slopmax/client"
import { compact, fixed, grouped, providerTitle } from "@slopmax/client/format"
import { count, dollars, priced } from "./words.ts"

/** A figure with its caption. */
export interface Stat {
  readonly title: string
  readonly value: string
  readonly note: string
}

/** The share of input read from cache, as words: `62% from cache`. */
const cacheNote = (cached: number | undefined) =>
  cached === undefined ? "no cache reads" : `${fixed(cached * 100, 0)}% from cache`

/** Whether a history has nothing in it. */
export const isQuiet = (history: History): boolean => history.total.requests === 0 && history.total.failed === 0

/** The overview's Today panel. */
export const todayStats = (history: History): ReadonlyArray<Stat> => [
  {
    title: "Requests",
    value: grouped(history.total.requests),
    note: history.total.failed === 0 ? "none failed" : `${grouped(history.total.failed)} failed`,
  },
  { title: "Tokens", value: compact(history.total.tokens), note: cacheNote(history.cached) },
  {
    title: "API value",
    value: priced(history.total.cost, history.total.unpriced, history.total.requests),
    note: "what the API would charge",
  },
  { title: "Saved by failover", value: grouped(history.rescued), note: "answered by another account" },
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
    { title: "Tokens", value: compact(total.tokens), note: cacheNote(history.cached) },
    {
      title: "Requests",
      value: grouped(total.requests),
      note: history.sessions > 0 ? `in ${count(history.sessions, "conversation")}` : "answered",
    },
    { title: "API value", value, note: valueNote },
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
    },
    { title: "Saved by failover", value: grouped(history.rescued), note: "answered by another account" },
    {
      title: "From cache",
      value: history.cached === undefined ? "—" : `${fixed(history.cached * 100, 0)}%`,
      note: `saving ${priced(history.cacheSaved, 0, total.requests)}`,
    },
    {
      title: "First byte",
      value: history.firstByte === undefined ? "—" : `${fixed(history.firstByte / 1000, 2)} s`,
      note: "the median wait",
    },
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

/** Today's tokens hour by hour, all 24 hours, for the small charts on the overview and the panel. */
export const hourly = (history: History): ReadonlyArray<number> => {
  const hours = Array.from({ length: 24 }, () => 0)
  history.buckets.forEach((bucket, i) => {
    const hour = /^(\d{2}):/.exec(bucket.label)?.[1]
    const at = hour === undefined ? i : Number(hour)
    if (at >= 0 && at < 24) hours[at] = bucket.tokens.reduce((sum, n) => sum + n, 0)
  })
  return hours
}

/** The panel's one line about today: `{compact} tokens, {value} at API prices`. */
export const todayLine = (history: History): string => {
  const total = history.total
  const tokens = `${compact(total.tokens)} tokens`
  return total.cost > 0 ? `${tokens}, ${priced(total.cost, total.unpriced, total.requests)} at API prices` : tokens
}
