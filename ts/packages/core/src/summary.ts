// Usage summaries from the ledger: token totals and what they would cost
// on the API, by day, model, or account. `slopmax usage` prints them and
// the dashboard charts them.
import { Effect, Schema, SchemaGetter } from "effect"

import { fmt, num, SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"

import { Entry, read } from "./ledger.ts"
import { type Custom, Price, price } from "./pricing.ts"
import { byteOrder, Count, F64, omitWhen } from "./serde.ts"

/** The periods a summary covers, counted in local days. */
export const RANGES: ReadonlyArray<string> = ["today", "7d", "30d", "all"]
/** The row, by account, of failures no account could take. */
export const NO_ACCOUNT = "(no account free)"

/** How a summary groups requests. */
export const GROUPS: ReadonlyArray<string> = ["day", "model", "account"]

/** Rounds away float noise such as `0.22701000000000002`, as serde writes it. */
const MicroDollars = F64.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.transform((cost: number) => num.round(cost * 1e6) / 1e6),
  }),
)

const zeroOmitted = omitWhen(Count, 0, (n) => n === 0)

/** Totals for one row. */
export const TotalsSchema = Schema.Struct({
  /**
   * Requests answered; failures and agents' housekeeping (listing models,
   * counting tokens) are not among them.
   */
  requests: Count,
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  /** API price of the requests to priced models, in dollars. */
  cost: MicroDollars,
  /** Requests to models without a price, left out of `cost`. */
  unpriced: zeroOmitted,
  /** Requests that ended in an error instead of an answer. */
  failed: zeroOmitted,
}).pipe(Schema.encodeKeys({ cacheRead: "cache_read", cacheWrite: "cache_write" }))

/**
 * Totals for one row. Filled in place as the ledger is read (Rust's
 * `&mut self`), since a summary adds up every line of it.
 */
export interface Totals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  unpriced: number
  failed: number
}

export const Totals = {
  empty: (): Totals => ({
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    unpriced: 0,
    failed: 0,
  }),

  /**
   * Counts a ledger row: an answer in every total, a failure as failed, and
   * an agent's housekeeping not at all.
   */
  add: (self: Totals, entry: Entry, prices: Readonly<Record<string, Custom>>): void =>
    Totals.count(self, entry, Totals.priceOf(entry, prices)),

  /** The price of `entry`'s model, if it has one: what `count` takes, looked up once for every total a row goes in. */
  priceOf: (entry: Entry, prices: Readonly<Record<string, Custom>>): Price | undefined =>
    entry.model === undefined ? undefined : price(entry.model, prices),

  /** `add`, with the price of `entry`'s model (`priceOf`) already looked up. */
  count: (self: Totals, entry: Entry, p: Price | undefined): void => {
    if (Entry.failed(entry)) {
      self.failed += 1
      return
    }
    if (!Entry.answered(entry)) return
    if (p === undefined) self.unpriced += 1
    else self.cost += Price.cost(p, entry.input, entry.output, entry.cacheRead, entry.cacheWrite)
    self.requests += 1
    self.input += entry.input
    self.output += entry.output
    self.cacheRead += entry.cacheRead
    self.cacheWrite += entry.cacheWrite
  },

  /** The cost as shown: `—` when nothing is priced, a trailing `+` when some requests are left out. */
  costLabel: (self: Totals): string => {
    if (self.unpriced === 0) return `$${fmt.fixed(self.cost, 2)}`
    if (self.unpriced === self.requests) return "—"
    return `$${fmt.fixed(self.cost, 2)}+`
  },
} as const

export interface Summary {
  readonly since: Timestamp
  readonly by: string
  /** By key, in byte order (a `Map`, since an object puts keys like `7` first). */
  readonly rows: ReadonlyMap<string, Totals>
  readonly total: Totals
}

const encodeTotals = Schema.encodeSync(TotalsSchema)
const encodeTime = Schema.encodeSync(TimestampFromString)

/**
 * JSON text for `value`, where a `Map` (as `value` or a value of one) is an
 * object with its keys in the map's order.
 */
const write = (value: unknown, indent: number, depth: number): string => {
  if (!(value instanceof Map)) {
    const text = JSON.stringify(value, null, indent)
    // Strings are escaped, so every newline is the layout's.
    return indent === 0 || depth === 0 ? text : text.replaceAll("\n", `\n${" ".repeat(indent * depth)}`)
  }
  if (value.size === 0) return "{}"
  const parts: Array<string> = []
  for (const [k, v] of value) {
    const key = JSON.stringify(String(k))
    parts.push(indent === 0 ? `${key}:${write(v, 0, 0)}` : `${key}: ${write(v, indent, depth + 1)}`)
  }
  if (indent === 0) return `{${parts.join(",")}}`
  const pad = " ".repeat(indent * (depth + 1))
  return `{\n${pad}${parts.join(`,\n${pad}`)}\n${" ".repeat(indent * depth)}}`
}

export const Summary = {
  /**
   * The summary as serde_json writes it: `{"since","by","rows","total"}`,
   * the rows in key order, then the `extra` keys. Compact, or pretty with
   * `indent` spaces (`serde_json::to_string_pretty` is 2).
   */
  json: (self: Summary, indent = 0, extra: ReadonlyArray<readonly [string, unknown]> = []): string => {
    const rows = new Map<string, unknown>()
    for (const [k, totals] of self.rows) rows.set(k, encodeTotals(totals))
    const object = new Map<string, unknown>([
      ["since", encodeTime(self.since)],
      ["by", self.by],
      ["rows", rows],
      ["total", encodeTotals(self.total)],
      ...extra,
    ])
    return write(object, indent, 0)
  },
} as const

/** The start of `range` (one of `RANGES`) at local midnight, or undefined for an unknown range. */
export const since = (range: string, now: Timestamp): Timestamp | undefined => {
  let days: number
  switch (range) {
    case "today":
      days = 0
      break
    case "7d":
      days = 6
      break
    case "30d":
      days = 29
      break
    case "all":
      return 0
    default:
      return undefined
  }
  const offset = Timestamp.localOffset(now)
  const [y, m, d] = Timestamp.date(now, offset)
  const today = Timestamp.midnight(y, m, d, offset) ?? now
  return Timestamp.sub(today, SignedDuration.fromHours(24 * days))
}

/** The summary of `entries` from `since`, grouped `by` one of `GROUPS`; `names` gives accounts their display names. */
export const summarize = (
  entries: ReadonlyArray<Entry>,
  start: Timestamp,
  by: string,
  prices: Readonly<Record<string, Custom>>,
  names: ReadonlyMap<string, string>,
): Summary => {
  const key = (entry: Entry): string => {
    switch (by) {
      case "model":
        return entry.model ?? "-"
      case "account":
        // Failures that reached no account: every one was limited.
        if (entry.account === "") return NO_ACCOUNT
        return names.get(entry.account) ?? entry.account
      default: {
        const [y, m, d] = Timestamp.date(entry.at, Timestamp.localOffset(entry.at))
        return `${fmt.zeroPad(y, 4)}-${fmt.zeroPad(m, 2)}-${fmt.zeroPad(d, 2)}`
      }
    }
  }
  const rows = new Map<string, Totals>()
  const total = Totals.empty()
  // An agent's housekeeping makes no row of its own.
  for (const entry of entries) {
    if (!Entry.answered(entry) && !Entry.failed(entry)) continue
    const k = key(entry)
    let row = rows.get(k)
    if (row === undefined) {
      row = Totals.empty()
      rows.set(k, row)
    }
    const p = Entry.answered(entry) ? Totals.priceOf(entry, prices) : undefined
    Totals.count(row, entry, p)
    Totals.count(total, entry, p)
  }
  const sorted = new Map<string, Totals>()
  for (const k of [...rows.keys()].toSorted(byteOrder)) sorted.set(k, rows.get(k) ?? Totals.empty())
  return { since: start, by, rows: sorted, total }
}

/**
 * Summarizes the ledger in `dir` from `since`, grouped `by` one of
 * `GROUPS`. `names` gives accounts their display names.
 */
export const build = Effect.fn("summary.build")(function* (
  dir: string,
  start: Timestamp,
  by: string,
  prices: Readonly<Record<string, Custom>>,
  names: ReadonlyMap<string, string>,
) {
  return summarize(yield* read(dir, start), start, by, prices, names)
})
