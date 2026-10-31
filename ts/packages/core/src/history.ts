// The ledger as a window charts it: what went through slopmax over a range,
// hour by hour or day by day; by provider, model, account, and agent; what
// failover saved and what failed; what caching saved; how soon answers
// began and how fast they came; and when the work happens. Worked out once
// for every UI, as `view` is for the accounts.
import { Effect, Schema, SchemaGetter } from "effect"

import { fmt, num, SignedDuration, time, Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import type { Config } from "./config.ts"
import { Entry, read as readLedger } from "./ledger.ts"
import type { Home } from "./paths.ts"
import type { Custom } from "./pricing.ts"
import { ProviderId, ProviderIdSchema, Spec } from "./provider/mod.ts"
import { byteOrder, Count, F64, isRaw, type Raw } from "./serde.ts"
import { since as rangeStart, Totals, TotalsSchema } from "./summary.ts"
import { type Left, LeftSchema, left as leftOf, read as readWindows } from "./waste.ts"

/** Answers shorter than this say little about a model's speed. */
const SPEED_MIN_OUTPUT = 64
/**
 * The agent slopmax's own warmups name, which keep a window open at
 * slopmax's hours rather than do the user's work.
 */
const WARMUP = "slopmax"

/** The span a history covers, counted in local days; in JSON by its variant's name. */
export const RangeSchema = Schema.Literals(["today", "week", "month"])

export type Range = typeof RangeSchema.Type

const ALL: ReadonlyArray<Range> = ["today", "week", "month"]
const DEFAULT: Range = "week"

export const Range = {
  ALL,

  default: DEFAULT,

  title: (self: Range): string => (self === "today" ? "Today" : self === "week" ? "7 Days" : "30 Days"),

  /** The range `summary` knows as `key`: `today`, `7d`, or `30d`. */
  parse: (key: string): Range | undefined => Range.ALL.find((r) => Range.key(r) === key),

  /** The name `summary` knows it by. */
  key: (self: Range): string => (self === "today" ? "today" : self === "week" ? "7d" : "30d"),
} as const

/** An `f32`: any JSON number on read; written as serde_json writes one (`0.8333333`, `1.0`). */
const F32: Schema.Codec<number, number | Raw> = Schema.Union([Schema.Number, Schema.declare(isRaw)]).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((v: number | Raw) => (typeof v === "number" ? v : Number(v.rawJSON))),
    encode: SchemaGetter.transform((x: number): number | Raw => json.raw(fmt.json32(x))),
  }),
)

/** One hour or day. */
export const BucketSchema = Schema.Struct({
  /** `09:00`, or `Oct 3`. */
  label: Schema.String,
  /** Tokens answered by each of `History.providers`, in that order. */
  tokens: Schema.Array(Count),
  requests: Count,
  failed: Count,
  /** Answers that needed another account. */
  rescued: Count,
  /** The agents' conversations answered. */
  sessions: Count,
  /** What the answers would have cost on the API, in dollars. */
  cost: F64,
  /** The share of the agents' input read from cache, from 0 to 1, when any came in; warmups left out. */
  cached: Schema.NullOr(F32),
  /** The median and 95th percentile time to the first byte, in milliseconds, when any answer reported one. */
  firstByte: Schema.NullOr(Schema.Tuple([Count, Count])),
}).pipe(Schema.encodeKeys({ firstByte: "first_byte" }))

export type Bucket = typeof BucketSchema.Type

/** A model's or an account's part of the range. */
export const ShareSchema = Schema.Struct({
  name: Schema.String,
  provider: ProviderIdSchema,
  totals: TotalsSchema,
})

export interface Share {
  readonly name: string
  readonly provider: ProviderId
  readonly totals: Totals
}

/** An agent's part of the range. */
export const PartSchema = Schema.Struct({
  name: Schema.String,
  totals: TotalsSchema,
})

export interface Part {
  readonly name: string
  readonly totals: Totals
}

/** How fast a model writes, once it has begun. */
export const SpeedSchema = Schema.Struct({
  model: Schema.String,
  provider: ProviderIdSchema,
  /** Output tokens a second, the median over its answers. */
  tokensPerSecond: F64,
}).pipe(Schema.encodeKeys({ tokensPerSecond: "tokens_per_second" }))

export type Speed = typeof SpeedSchema.Type

/** What went through slopmax over a range. */
export const HistorySchema = Schema.Struct({
  range: RangeSchema,
  /** Hours for today, days otherwise, oldest first, empty ones included. */
  buckets: Schema.Array(BucketSchema),
  /** The providers that answered, in the order each bucket lists its tokens. */
  providers: Schema.Array(ProviderIdSchema),
  /** The answers' totals, failures counted apart. */
  total: TotalsSchema,
  /** Answers that came from another account after the first could not give one: the requests failover saved. */
  rescued: Count,
  /**
   * Failures that reached no account, because every one was limited or out
   * of rotation; the rest count against the account they reached.
   */
  unplaced: Count,
  /**
   * What answers from API keys were billed, in dollars: real spending,
   * unlike the rest of `total.cost`, which subscriptions cover.
   */
  billed: F64,
  /** Subscription quota the range's resets threw away, and what it cost. */
  left: LeftSchema,
  /** What reading input from cache saved against sending it afresh, in dollars at API prices. */
  cacheSaved: F64,
  /**
   * The share of the agents' input read from cache, from 0 to 1, when any
   * came in; warmups, which never read it, left out.
   */
  cached: Schema.NullOr(F32),
  /** The agents' conversations that were answered. */
  sessions: Count,
  /** The median time to the first byte of an answer, in milliseconds. */
  firstByte: Schema.NullOr(Count),
  /** What a month at this range's pace would be worth at API prices, when the range says enough about a month. */
  monthly: Schema.NullOr(F64),
  /** The agents' answers by local weekday (Monday first) and hour; warmups, at slopmax's hours, left out. */
  activity: Schema.Array(Schema.Array(Count)),
  /** Most tokens first. */
  models: Schema.Array(ShareSchema),
  /** Most tokens first; an account that only failed comes last. */
  accounts: Schema.Array(ShareSchema),
  /** Claude Code, Codex, slopmax's own warmups, or other agents; most tokens first. */
  agents: Schema.Array(PartSchema),
  /** Each model's median output speed, fastest first. */
  speeds: Schema.Array(SpeedSchema),
}).pipe(Schema.encodeKeys({ cacheSaved: "cache_saved", firstByte: "first_byte" }))

export interface History {
  readonly range: Range
  readonly buckets: ReadonlyArray<Bucket>
  readonly providers: ReadonlyArray<ProviderId>
  readonly total: Totals
  readonly rescued: number
  readonly unplaced: number
  readonly billed: number
  readonly left: Left
  readonly cacheSaved: number
  readonly cached: number | null
  readonly sessions: number
  readonly firstByte: number | null
  readonly monthly: number | null
  readonly activity: ReadonlyArray<ReadonlyArray<number>>
  readonly models: ReadonlyArray<Share>
  readonly accounts: ReadonlyArray<Share>
  readonly agents: ReadonlyArray<Part>
  readonly speeds: ReadonlyArray<Speed>
}

/** Every token a request moved: input, output, and both kinds of cache. */
export const tokens = (totals: Totals): number => totals.input + totals.output + totals.cacheRead + totals.cacheWrite

/** The share of input read from cache, from 0 to 1, when any came in (an `f32`, as the Rust divides). */
export const cached = (totals: Totals): number | null => {
  const input = totals.input + totals.cacheRead + totals.cacheWrite
  return input > 0 ? Math.fround(Math.fround(totals.cacheRead) / Math.fround(input)) : null
}

/** What usage is valued at: API prices per model, and plans' fees. */
export interface Prices {
  readonly models: Readonly<Record<string, Custom>>
  readonly plans: Readonly<Record<string, number>>
}

export const Prices = {
  of: (config: Config): Prices => ({ models: config.prices, plans: config.planPrices }),
} as const

/**
 * Reads `home`'s ledger and reset windows over `range`. `names` gives
 * accounts their display names.
 */
export const load = Effect.fn("history.load")(function* (
  home: Home,
  range: Range,
  now: Timestamp,
  prices: Prices,
  names: ReadonlyMap<string, string>,
) {
  const since = rangeStart(Range.key(range), now) ?? now
  const history = build(yield* readLedger(home.usage(), since), range, since, now, prices.models, names)
  const lapsed = yield* readWindows(home.windows(), since)
  return { ...history, left: leftOf(lapsed, prices.plans, names) } satisfies History
})

/** One bucket while it fills. */
interface Filling {
  readonly totals: Totals
  /** The agents' answers, warmups aside. */
  readonly work: Totals
  readonly tokens: Array<number>
  rescued: number
  readonly sessions: Set<string>
  readonly waits: Array<number>
}

const divEuclid = (a: number, b: number): number => Math.floor(a / b)

const remEuclid = (a: number, b: number): number => ((a % b) + b) % b

// Days count on the local calendar, hours from the day's midnight.
const day = (t: Timestamp): number =>
  divEuclid(Timestamp.asSecond(t) + SignedDuration.asSecs(Timestamp.localOffset(t)), 86_400)

/** A `(name, provider)` key and what is kept under it. */
interface Slot<A> {
  readonly name: string
  readonly provider: ProviderId
  readonly value: A
}

const slotKey = (name: string, provider: ProviderId): string => `${provider}\u0000${name}`

/** In key order, as a BTreeMap keyed by the pair: by name, then provider. */
const bySlot = <A>(slots: Iterable<Slot<A>>): Array<Slot<A>> =>
  [...slots].toSorted((a, b) => byteOrder(a.name, b.name) || ProviderId.compare(a.provider, b.provider))

/** Totals by `(name, provider)`. */
class Grouped {
  readonly slots = new Map<string, Slot<Totals>>()

  get(name: string, provider: ProviderId): Totals {
    const key = slotKey(name, provider)
    let slot = this.slots.get(key)
    if (slot === undefined) {
      slot = { name, provider, value: Totals.empty() }
      this.slots.set(key, slot)
    }
    return slot.value
  }
}

/** Output speeds by `(model, provider)`. */
class Speeds {
  readonly slots = new Map<string, Slot<Array<number>>>()

  push(name: string, provider: ProviderId, speed: number): void {
    const key = slotKey(name, provider)
    const slot = this.slots.get(key)
    if (slot === undefined) this.slots.set(key, { name, provider, value: [speed] })
    else slot.value.push(speed)
  }
}

/** @internal The history of `entries` from `since` to `now`; exported for tests. */
export const build = (
  entries: ReadonlyArray<Entry>,
  range: Range,
  since: Timestamp,
  now: Timestamp,
  prices: Readonly<Record<string, Custom>>,
  names: ReadonlyMap<string, string>,
): History => {
  const slot = (t: Timestamp): number =>
    range === "today"
      ? Math.max(0, Math.trunc(SignedDuration.asSecs(Timestamp.durationSince(t, since)) / 3_600))
      : Math.max(0, day(t) - day(since))
  const count = range === "today" ? slot(now) + 1 : range === "week" ? 7 : 30
  const providers = ProviderId.ALL.filter((p) => entries.some((e) => e.provider === p && Entry.answered(e)))

  const buckets: Array<Filling> = Array.from({ length: count }, () => ({
    totals: Totals.empty(),
    work: Totals.empty(),
    tokens: providers.map(() => 0),
    rescued: 0,
    sessions: new Set<string>(),
    waits: [],
  }))
  const total = Totals.empty()
  const work = Totals.empty()
  let rescued = 0
  let unplaced = 0
  const billed = Totals.empty()
  let cacheSaved = 0
  const sessions = new Set<string>()
  const waits: Array<number> = []
  const activity: Array<Array<number>> = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const models = new Grouped()
  const accounts = new Grouped()
  const agents = new Map<string, Totals>()
  const speeds = new Speeds()
  for (const entry of entries) {
    const bucket = buckets[slot(entry.at)]
    if (bucket === undefined) continue
    // Looked up once for all the totals the entry goes in.
    const p = Entry.answered(entry) ? Totals.priceOf(entry, prices) : undefined
    Totals.count(bucket.totals, entry, p)
    Totals.count(total, entry, p)
    // A failure counts against the account it reached, if any.
    if (entry.account !== "" && (Entry.answered(entry) || Entry.failed(entry))) {
      const account = names.get(entry.account) ?? entry.account
      Totals.count(accounts.get(account, entry.provider), entry, p)
    }
    if (Entry.failed(entry) && entry.account === "") unplaced += 1
    if (!Entry.answered(entry)) continue
    if (!Spec.isSubscription(ProviderId.spec(entry.provider))) Totals.count(billed, entry, p)
    const i = providers.indexOf(entry.provider)
    if (i >= 0) bucket.tokens[i] = (bucket.tokens[i] ?? 0) + Entry.tokens(entry)
    if (entry.attempts > 1) {
      bucket.rescued += 1
      rescued += 1
    }
    if (entry.firstByteMs !== undefined) {
      bucket.waits.push(entry.firstByteMs)
      waits.push(entry.firstByteMs)
    }
    // An agent's conversation; slopmax's warmups have none.
    if (entry.session !== undefined) {
      bucket.sessions.add(entry.session)
      sessions.add(entry.session)
    }
    const model = entry.model ?? "unknown"
    if (p !== undefined) cacheSaved += (entry.cacheRead * (p.input - p.cacheRead)) / 1e6
    const fast = speed(entry)
    if (fast !== undefined) speeds.push(model, entry.provider, fast)
    if (entry.agent !== WARMUP) {
      Totals.count(bucket.work, entry, p)
      Totals.count(work, entry, p)
      const [weekday, hour] = when(entry.at, Timestamp.localOffset(entry.at))
      const row = activity[weekday]
      if (row !== undefined) row[hour] = (row[hour] ?? 0) + 1
    }
    Totals.count(models.get(model, entry.provider), entry, p)
    const name = agent(entry.agent)
    let part = agents.get(name)
    if (part === undefined) {
      part = Totals.empty()
      agents.set(name, part)
    }
    Totals.count(part, entry, p)
  }

  const filled = buckets.map((b, i): Bucket => ({
    label: label(range, since, i),
    tokens: b.tokens,
    requests: b.totals.requests,
    failed: b.totals.failed,
    rescued: b.rescued,
    sessions: b.sessions.size,
    cost: b.totals.cost,
    cached: cached(b.work),
    firstByte: firstBytes(b.waits),
  }))
  const parts = [...agents.entries()]
    .toSorted(([a], [b]) => byteOrder(a, b))
    .map(([name, totals]): Part => ({ name, totals }))
    .toSorted((a, b) => tokens(b.totals) - tokens(a.totals))
  const medians: Array<Speed> = []
  for (const { name, provider, value } of bySlot(speeds.slots.values())) {
    const each = value.toSorted(num.totalCmp)
    const median = each[Math.floor(each.length / 2)]
    if (median !== undefined) medians.push({ model: name, provider, tokensPerSecond: median })
  }
  return {
    range,
    buckets: filled,
    providers,
    monthly: range === "week" ? (total.cost * 30) / 7 : null,
    total,
    rescued,
    unplaced,
    billed: billed.cost,
    left: { windows: 0, unused: 0, dollars: 0, unpriced: 0, accounts: [] },
    cacheSaved,
    cached: cached(work),
    sessions: sessions.size,
    firstByte: percentile(waits, 50) ?? null,
    activity,
    models: ranked(models),
    accounts: ranked(accounts),
    agents: parts,
    speeds: medians.toSorted((a, b) => num.totalCmp(b.tokensPerSecond, a.tokensPerSecond)),
  }
}

const firstBytes = (waits: Array<number>): readonly [number, number] | null => {
  const p50 = percentile(waits, 50)
  const p95 = percentile(waits, 95)
  return p50 === undefined || p95 === undefined ? null : [p50, p95]
}

/**
 * How fast an answer came once it began, in output tokens a second, when it
 * was long enough to say.
 */
const speed = (entry: Entry): number | undefined => {
  if (entry.firstByteMs === undefined || entry.ms < entry.firstByteMs) return undefined
  const writing = entry.ms - entry.firstByteMs
  return entry.output >= SPEED_MIN_OUTPUT && writing > 0 ? (entry.output * 1e3) / writing : undefined
}

/** An agent as people know it. */
const agent = (id: string | undefined): string => {
  switch (id) {
    case "claude":
      return "Claude Code"
    case "codex":
      return "Codex"
    case WARMUP:
      return "Warmups"
    default:
      return "Other"
  }
}

/** @internal The weekday (Monday first) and hour of `at`, on a clock `offset` east of UTC. */
export const when = (at: Timestamp, offset: SignedDuration): readonly [weekday: number, hour: number] => {
  const local = Timestamp.asSecond(at) + SignedDuration.asSecs(offset)
  // The first day, January 1st 1970, was a Thursday.
  const weekday = remEuclid(divEuclid(local, 86_400) + 3, 7)
  const hour = Math.floor(remEuclid(local, 86_400) / 3_600)
  return [weekday, hour]
}

/** `09:00` for an hour of today, `Oct 3` for a day. */
const label = (range: Range, since: Timestamp, i: number): string => {
  if (range === "today") return `${fmt.zeroPad(i, 2)}:00`
  // Midday of the day, clear of any daylight saving shift.
  const noon = Timestamp.add(since, SignedDuration.fromHours(24 * i + 12))
  const [, month, date] = Timestamp.date(noon, Timestamp.localOffset(noon))
  return `${time.MONTHS[month - 1] ?? ""} ${date}`
}

/** @internal The value `p` percent of the way through `values` (sorted in place). */
export const percentile = (values: Array<number>, p: number): number | undefined => {
  if (values.length === 0) return undefined
  values.sort((a, b) => a - b)
  return values[Math.min(Math.floor((values.length * p) / 100), values.length - 1)]
}

/** Most tokens first; what moved none (an account that only failed) last. */
const ranked = (groups: Grouped): Array<Share> =>
  bySlot(groups.slots.values())
    .map(({ name, provider, value }): Share => ({ name, provider, totals: value }))
    .toSorted((a, b) => tokens(b.totals) - tokens(a.totals) || b.totals.failed - a.totals.failed)
