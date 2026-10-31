// Usage windows and refusals: the shared model providers parse into.
//
// Responses carry rate-limit headers and providers expose usage endpoints;
// each provider folds its own formats into one `Limits` model of
// percentage windows with reset times, which drives routing and the status
// display. Refused requests are classified into a `Refusal`. The header
// and time helpers here are shared by the provider parsers.
import { Result, Schema } from "effect"

import { SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"

import { header as visibleHeader } from "./proxy/headers.ts"
import { byteOrder, F64, isRaw, list, opt, U32 } from "./serde.ts"

/** A usage window, e.g. Claude's 5-hour session or ChatGPT's weekly limit. */
export const WindowSchema = Schema.Struct({
  /** Nominal length: `5h`, `7d`, or `30d`. */
  span: Schema.String,
  /** Model the limit is scoped to, or absent when it covers every request. */
  model: opt(Schema.String),
  /** Percent used, 0 to 100. */
  used: F64,
  resetsAt: opt(TimestampFromString),
}).pipe(Schema.encodeKeys({ resetsAt: "resets_at" }))

export type Window = typeof WindowSchema.Type

const clamp = (x: number, low: number, high: number): number => (x !== x ? x : Math.min(high, Math.max(low, x)))

export const Window = {
  make: (span: string, used: number, resetsAt: Timestamp | undefined): Window =>
    resetsAt === undefined ? { span, used: clamp(used, 0, 100) } : { span, used: clamp(used, 0, 100), resetsAt },

  /** Percent used at `now`; a window whose reset has passed starts over. */
  usedAt: (self: Window, now: Timestamp): number =>
    self.resetsAt !== undefined && self.resetsAt <= now ? 0 : self.used,

  /** The reset time, if it is still ahead. */
  upcomingReset: (self: Window, now: Timestamp): Timestamp | undefined =>
    self.resetsAt !== undefined && self.resetsAt > now ? self.resetsAt : undefined,

  isFull: (self: Window, now: Timestamp): boolean => Window.usedAt(self, now) >= 100,

  /** Display label such as `5h`, `7d`, or `7d Fable`. */
  label: (self: Window): string => (self.model === undefined ? self.span : `${self.span} ${self.model}`),

  sameSlot: (self: Window, other: Window): boolean => self.span === other.span && self.model === other.model,
} as const

/**
 * Classifies a window by its length so the 5h/weekly/monthly split survives
 * plan changes (ChatGPT Pro has no 5-hour window; Team may be monthly).
 */
export const spanFor = (seconds: number): "5h" | "7d" | "30d" => {
  const DAY = 86_400
  if (seconds < DAY) return "5h"
  if (seconds >= 28 * DAY) return "30d"
  return "7d"
}

/** Last known usage windows for one account. */
export const LimitsSchema = Schema.Struct({
  windows: list(WindowSchema),
  observedAt: opt(TimestampFromString),
  /** Codex: banked credits that reset a rate-limit window when redeemed. */
  resetCredits: opt(U32),
}).pipe(Schema.encodeKeys({ observedAt: "observed_at", resetCredits: "reset_credits" }))

export type Limits = typeof LimitsSchema.Type

/**
 * A window that ran out its time, and how much of it was used: what was
 * left is quota the reset threw away.
 */
export const LapseSchema = Schema.Struct({
  span: Schema.String,
  model: opt(Schema.String),
  /** Percent used when it was last read before the reset. */
  used: F64,
  endedAt: TimestampFromString,
}).pipe(Schema.encodeKeys({ endedAt: "ended_at" }))

export type Lapse = typeof LapseSchema.Type

/**
 * Score for accounts with no usage data: worse than any real reading but
 * still selectable, so an unmeasured account never looks empty.
 */
export const UNKNOWN_SCORE = 101.0

/** Age after which a reading without reset times no longer blocks. */
const STALE_AFTER: SignedDuration = SignedDuration.fromMins(5)

/**
 * How close a long window's reset must be for its spare quota to come
 * before every 5-hour window's.
 */
export const URGENT: SignedDuration = SignedDuration.fromHours(24)
/** The room, in percent of a long window, that makes its reset urgent. */
export const URGENT_SPARE = 10.0

/**
 * When an account's spare capacity is lost, as `Limits.urgency` orders it:
 * compare the fields in order, undefined last.
 */
export interface Urgency {
  /** A long window with room left that resets within `URGENT`. */
  readonly weekEnding: Timestamp | undefined
  /** The soonest started 5-hour window with room left. */
  readonly short: Timestamp | undefined
  /** The soonest long window with room left. */
  readonly long: Timestamp | undefined
}

const last = (at: Timestamp | undefined): Timestamp => at ?? Timestamp.MAX

export const Urgency = {
  /** A key that sorts the most urgent first. */
  key: (self: Urgency): readonly [Timestamp, Timestamp, Timestamp] => [
    last(self.weekEnding),
    last(self.short),
    last(self.long),
  ],
} as const

const min = (values: Iterable<Timestamp | undefined>): Timestamp | undefined => {
  let best: Timestamp | undefined
  for (const v of values) if (v !== undefined && (best === undefined || v < best)) best = v
  return best
}

const max = (values: Iterable<Timestamp | undefined>): Timestamp | undefined => {
  let best: Timestamp | undefined
  for (const v of values) if (v !== undefined && (best === undefined || v > best)) best = v
  return best
}

const spanRank = (span: string): number => (span === "5h" ? 0 : span === "7d" ? 1 : 2)

// `Option<String>` order: None first.
const compareModels = (a: string | undefined, b: string | undefined): number => {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  return byteOrder(a, b)
}

/** Windows that apply to every request, as opposed to one model. */
const shared = (self: Limits): ReadonlyArray<Window> => self.windows.filter((w) => w.model === undefined)

/**
 * Shared windows that are full. A full window without a reset time only
 * counts while the reading is fresh, so stale data cannot park an account
 * forever.
 */
const full = (self: Limits, now: Timestamp): ReadonlyArray<Window> => {
  const fresh = self.observedAt !== undefined && Timestamp.durationSince(now, self.observedAt) < STALE_AFTER
  return shared(self).filter((w) => Window.isFull(w, now) && (fresh || Window.upcomingReset(w, now) !== undefined))
}

export const Limits = {
  empty: (): Limits => ({ windows: [] }),

  /** A reading taken at `now`, or undefined when it carries no windows. */
  observed: (windows: ReadonlyArray<Window>, now: Timestamp): Limits | undefined =>
    windows.length === 0 ? undefined : { windows, observedAt: now },

  /**
   * Merges a newer observation. Windows it carries replace older readings
   * of the same slot; slots it omits are kept unless their reset passed.
   * `now` stands in for the newer reading's time when it has none.
   */
  merge: (self: Limits, newer: Limits, now: Timestamp): Limits => {
    const at = newer.observedAt ?? now
    const kept = self.windows.filter(
      (old) => !newer.windows.some((w) => Window.sameSlot(w, old)) && (old.resetsAt === undefined || old.resetsAt > at),
    )
    const windows = [...kept, ...newer.windows].toSorted(
      (a, b) => spanRank(a.span) - spanRank(b.span) || compareModels(a.model, b.model),
    )
    const observedAt = newer.observedAt ?? self.observedAt
    const resetCredits = newer.resetCredits ?? self.resetCredits
    return {
      windows,
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(resetCredits === undefined ? {} : { resetCredits }),
    }
  },

  /**
   * The windows of this reading that `newer`, taken at `now`, shows have
   * reset: their time passed, or a later period of the same slot began.
   * Each is reported once, as merging then drops it.
   */
  lapsed: (self: Limits, newer: Limits, now: Timestamp): ReadonlyArray<Lapse> => {
    const lapses: Array<Lapse> = []
    for (const old of self.windows) {
      const ended = old.resetsAt
      if (ended === undefined) continue
      const nextPeriod = newer.windows.some(
        (w) =>
          Window.sameSlot(w, old) &&
          w.resetsAt !== undefined &&
          w.resetsAt > Timestamp.add(ended, SignedDuration.fromHours(1)),
      )
      if (ended <= now || nextPeriod) {
        lapses.push(
          old.model === undefined
            ? { span: old.span, used: old.used, endedAt: ended }
            : { span: old.span, model: old.model, used: old.used, endedAt: ended },
        )
      }
    }
    return lapses
  },

  /** Windows that apply to every request, as opposed to one model. */
  shared,

  /** Highest usage across shared windows, or `UNKNOWN_SCORE`. */
  score: (self: Limits, now: Timestamp): number => {
    let best: number | undefined
    for (const w of shared(self)) {
      const used = Window.usedAt(w, now)
      best = best === undefined ? used : Math.max(best, used)
    }
    return best ?? UNKNOWN_SCORE
  },

  /**
   * If a shared window is full, when the account is usable again: the
   * latest reset among full windows, since every one of them must reopen.
   */
  exhaustedUntil: (self: Limits, now: Timestamp): Timestamp | undefined =>
    max(full(self, now).map((w) => Window.upcomingReset(w, now))),

  isExhausted: (self: Limits, now: Timestamp): boolean => full(self, now).length > 0,

  /**
   * How soon this account's spare capacity is lost, for spending it first;
   * earlier sorts first. A long window (week or month) with room left that
   * resets within `URGENT` comes before everything: its unused quota is the
   * plan's fee thrown away. Then the soonest started 5-hour window, whose
   * quota is lost at its reset too, then the soonest long window.
   */
  urgency: (self: Limits, now: Timestamp): Urgency => {
    const windows = shared(self)
    const spare = (w: Window): boolean => !Window.isFull(w, now)
    const long = min(windows.filter((w) => w.span !== "5h" && spare(w)).map((w) => Window.upcomingReset(w, now)))
    const short = min(
      windows
        .filter((w) => w.span === "5h" && Window.usedAt(w, now) > 0 && spare(w))
        .map((w) => Window.upcomingReset(w, now)),
    )
    // Worth saving only with real room left in it.
    const weekEnding = min(
      windows
        .filter((w) => w.span !== "5h" && Window.usedAt(w, now) <= 100 - URGENT_SPARE)
        .map((w) => Window.upcomingReset(w, now))
        .filter((at) => at !== undefined && at <= Timestamp.add(now, URGENT)),
    )
    return { weekEnding, short, long }
  },

  /** The soonest moment some spare capacity on this account expires, if any is known to. */
  expiringAt: (self: Limits, now: Timestamp): Timestamp | undefined => {
    const urgency = Limits.urgency(self, now)
    return urgency.weekEnding ?? urgency.short ?? urgency.long
  },
} as const

/** One window of a pool of accounts, read as if they were one account. */
export interface PoolWindow {
  /** `5h`, `7d`, or `30d`. */
  readonly span: "5h" | "7d" | "30d"
  /** Percent used: the mean of the accounts' usage. */
  readonly used: number
  /** When capacity next comes back: the soonest reset of a window in use. */
  readonly resetsAt: Timestamp | undefined
}

export const PoolWindow = {
  /** The window's length in minutes, as Codex states it. */
  minutes: (self: PoolWindow): number => (self.span === "5h" ? 300 : self.span === "30d" ? 43_200 : 10_080),
} as const

/**
 * The windows of a pool of accounts, each given by its limits and whether
 * it sits out (a blocked account counts as full in its shortest window).
 * Accounts without a reading for a window are left out of its mean.
 */
export const pooled = (accounts: Iterable<readonly [Limits, boolean]>, now: Timestamp): ReadonlyArray<PoolWindow> =>
  pooledBy(
    Array.from(accounts, ([l, b]) => [l, b, 1.0] as const),
    now,
  )

/**
 * `pooled`, each account weighted by its share of the pool's capacity, so a
 * large plan's usage counts for more than a small one's.
 */
export const pooledBy = (
  accounts: Iterable<readonly [Limits, boolean, number]>,
  now: Timestamp,
): ReadonlyArray<PoolWindow> => {
  const all = Array.from(accounts)
  const windows: Array<PoolWindow> = []
  for (const span of ["5h", "7d", "30d"] as const) {
    const readings: Array<readonly [number, Timestamp | undefined, number]> = []
    for (const [limits, blocked, weight] of all) {
      const sharedWindows = shared(limits)
      const window = sharedWindows.find((w) => w.span === span)
      if (window === undefined) continue
      let shortest: number | undefined
      for (const w of sharedWindows) {
        const rank = spanRank(w.span)
        if (shortest === undefined || rank < shortest) shortest = rank
      }
      const used = blocked && shortest === spanRank(span) ? 100.0 : Window.usedAt(window, now)
      readings.push([used, Window.upcomingReset(window, now), weight])
    }
    const weight = readings.reduce((sum, r) => sum + r[2], 0)
    if (readings.length === 0 || weight <= 0) continue
    const used = readings.reduce((sum, [u, , w]) => sum + u * w, 0) / weight
    const resetsAt = min(readings.filter(([u]) => u > 0).map(([, reset]) => reset))
    windows.push({ span, used, resetsAt })
  }
  return windows
}

/** A header's value, trimmed; undefined when absent or not visible ASCII. */
export const header = (headers: Headers, name: string): string | undefined => visibleHeader(headers, name)?.trim()

const F64_TEXT = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/
const F64_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i

/** Rust's `str::parse::<f64>`: undefined where it fails. */
export const parseF64 = (text: string): number | undefined => {
  if (F64_TEXT.test(text)) return Number(text)
  if (!F64_SPECIAL.test(text)) return undefined
  const negative = text.startsWith("-")
  if (/nan$/i.test(text)) return Number.NaN
  return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
}

/** A header's value as a finite number. */
export const headerF64 = (headers: Headers, name: string): number | undefined => {
  const raw = header(headers, name)
  if (raw === undefined) return undefined
  const value = parseF64(raw)
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/** Parses a unix-seconds timestamp header. */
export const headerTime = (headers: Headers, name: string): Timestamp | undefined => {
  const secs = headerF64(headers, name)
  return secs === undefined ? undefined : Timestamp.fromSecond(Math.trunc(secs))
}

/** `Retry-After` as seconds or an HTTP date. */
export const retryAfter = (headers: Headers, now: Timestamp): Timestamp | undefined => {
  const raw = header(headers, "retry-after")
  if (raw === undefined) return undefined
  const secs = parseF64(raw)
  if (secs !== undefined) {
    // `f64::max` ignores NaN.
    const wait = secs !== secs ? 0 : Math.max(secs, 0)
    return Timestamp.add(now, SignedDuration.fromSecsF64(wait))
  }
  return Timestamp.fromHttpDate(raw)
}

/** A JSON time: RFC 3339 text, or unix seconds. */
export const parseTime = (value: unknown): Timestamp | undefined => {
  if (typeof value === "string") {
    const parsed = Timestamp.parse(value)
    return Result.isSuccess(parsed) ? parsed.success : undefined
  }
  let n: number | undefined
  if (typeof value === "number") n = value
  else if (isRaw(value)) n = Number(value.rawJSON)
  if (n === undefined || n !== n) return n === undefined ? undefined : Timestamp.fromSecond(0)
  return Timestamp.fromSecond(Math.trunc(Math.max(-9.3e18, Math.min(9.3e18, n))))
}

/** Why an upstream refused a request. */
export type Refusal =
  /**
   * The account's quota is spent. `until` is when it should come back, if
   * known; `model` limits the block to one model.
   */
  | { readonly _tag: "Exhausted"; readonly until: Timestamp | undefined; readonly model: string | undefined }
  /** Short-lived throttling; the account itself is fine. */
  | { readonly _tag: "Throttled"; readonly until: Timestamp | undefined }

export const Refusal = {
  Exhausted: (until: Timestamp | undefined, model: string | undefined): Refusal => ({
    _tag: "Exhausted",
    until,
    model,
  }),
  Throttled: (until: Timestamp | undefined): Refusal => ({ _tag: "Throttled", until }),
} as const
