// Quota left on the table: what part of each subscription window went
// unused when it reset, and what that part of the plan cost. A week of a Max
// plan left half unused is half a week's fee paid for nothing.
//
// The daemon writes each window that resets to `~/.slopmax/windows.jsonl`
// with how much of it was used; this reads them back and values the unused
// part of the long windows (weekly, or monthly) at the plan's price. The
// 5-hour windows are kept too, but valued at nothing: the weekly cap is what
// the fee buys.
import { dirname } from "node:path"

import { Effect, Schema } from "effect"

import { num, Timestamp, TimestampFromString } from "@slopmax/common"

import { context, lift } from "./error.ts"
import * as fsx from "./fsx.ts"
import { planMonthly } from "./pricing.ts"
import { ProviderId, ProviderIdSchema } from "./provider/mod.ts"
import { byteOrder, Count, F64, opt } from "./serde.ts"

/** Weeks in an average month, to turn a monthly fee into a weekly one. */
const WEEKS_A_MONTH = 52.0 / 12.0

/** One window that reset, as the daemon saw it. */
export const RecordSchema = Schema.Struct({
  endedAt: TimestampFromString,
  account: Schema.String,
  provider: ProviderIdSchema,
  plan: opt(Schema.String),
  span: Schema.String,
  model: opt(Schema.String),
  /** Percent used when it was last read before the reset. */
  used: F64,
}).pipe(Schema.encodeKeys({ endedAt: "ended_at" }))

export type Record = typeof RecordSchema.Type

const compareKeys = (a: Record, b: Record): number =>
  byteOrder(a.account, b.account) ||
  byteOrder(a.span, b.span) ||
  (a.model === b.model ? 0 : a.model === undefined ? -1 : b.model === undefined ? 1 : byteOrder(a.model, b.model)) ||
  a.endedAt - b.endedAt

/** Appends `records` to the file at `path`. */
export const append = Effect.fn("waste.append")(function* (path: string, records: ReadonlyArray<Record>) {
  if (records.length === 0) return
  yield* fsx.privateDir(dirname(path)).pipe(Effect.mapError(lift))
  yield* fsx.appendLines(path, RecordSchema, records).pipe(context(`opening ${path}`))
})

const decodeRecord = Schema.decodeUnknownOption(RecordSchema)

/** The windows that reset from `since` on, each once, oldest first. */
export const read = Effect.fn("waste.read")(function* (path: string, since: Timestamp) {
  const records: Array<Record> = []
  for (const line of (yield* fsx.readLines(path)) ?? []) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const record = decodeRecord(value)
    if (record._tag === "Some" && record.value.endedAt >= since) records.push(record.value)
  }
  const byKey = records.toSorted(compareKeys)
  const once = byKey.filter((r, i) => i === 0 || compareKeys(byKey[i - 1] ?? r, r) !== 0)
  return once.toSorted((a, b) => a.endedAt - b.endedAt)
})

/**
 * What the unused part of a window cost: the share of the plan's fee for
 * that span of time it bought. Undefined when the plan has no known price;
 * nothing for 5-hour windows and windows on one model, which the weekly fee
 * does not buy apart.
 */
export const value = (
  provider: ProviderId,
  plan: string | undefined,
  span: string,
  model: string | undefined,
  used: number,
  planPrices: Readonly<globalThis.Record<string, number>>,
): number | undefined => {
  let share: number
  if (span === "7d" && model === undefined) share = 1.0 / WEEKS_A_MONTH
  else if (span === "30d" && model === undefined) share = 1.0
  else return 0.0
  if (plan === undefined) return undefined
  const monthly = planMonthly(provider, plan, planPrices)
  if (monthly === undefined) return undefined
  const unused = Math.min(100, Math.max(0, 100.0 - used)) / 100.0
  return monthly * share * unused
}

export const AccountLeftSchema = Schema.Struct({
  name: Schema.String,
  provider: ProviderIdSchema,
  windows: Count,
  unused: F64,
  dollars: F64,
})

export type AccountLeft = typeof AccountLeftSchema.Type

/** Quota left on the table over a range. */
export const LeftSchema = Schema.Struct({
  /** Long windows (weekly or monthly) that reset. */
  windows: Count,
  /** What they left unused, on average, in percent. */
  unused: F64,
  /** What the unused part cost, at plan prices. */
  dollars: F64,
  /** Windows of plans without a known price, left out of `dollars`. */
  unpriced: Count,
  /** Most dollars first. */
  accounts: Schema.Array(AccountLeftSchema),
})

export type Left = typeof LeftSchema.Type

// `f64::total_cmp`, descending.
const descending = (a: number, b: number): number => num.totalCmp(b, a)

/** Totals `records`; `names` gives accounts their display names. */
export const left = (
  records: ReadonlyArray<Record>,
  planPrices: Readonly<globalThis.Record<string, number>>,
  names: ReadonlyMap<string, string>,
): Left => {
  let windows = 0
  let unusedSum = 0
  let dollars = 0
  let unpriced = 0
  const byAccount = new Map<
    string,
    { name: string; provider: ProviderId; windows: number; unused: number; dollars: number }
  >()
  for (const record of records) {
    const long = record.model === undefined && (record.span === "7d" || record.span === "30d")
    if (!long) continue
    const unused = Math.min(100, Math.max(0, 100.0 - record.used))
    const worth = value(record.provider, record.plan, record.span, undefined, record.used, planPrices)
    windows += 1
    unusedSum += unused
    if (worth === undefined) unpriced += 1
    else dollars += worth
    const name = names.get(record.account) ?? record.account
    const key = `${name}\u0000${record.provider}`
    const entry = byAccount.get(key) ?? { name, provider: record.provider, windows: 0, unused: 0, dollars: 0 }
    entry.windows += 1
    entry.unused += unused
    entry.dollars += worth ?? 0
    byAccount.set(key, entry)
  }
  // A BTreeMap by (name, provider), then most dollars first.
  const accounts = [...byAccount.values()]
    .toSorted((a, b) => byteOrder(a.name, b.name) || ProviderId.compare(a.provider, b.provider))
    .map((a) => ({
      name: a.name,
      provider: a.provider,
      windows: a.windows,
      unused: a.unused / a.windows,
      dollars: a.dollars,
    }))
    .toSorted((a, b) => descending(a.dollars, b.dollars) || descending(a.unused, b.unused))
  return { windows, unused: windows > 0 ? unusedSum / windows : 0, dollars, unpriced, accounts }
}
