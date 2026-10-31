// Usage windows: the one model every provider's rate-limit headers and usage
// endpoints are read into. Percent used, and when each window resets, drive
// placement, the status report and the nudges. Everything here is pure and
// takes `now` as an argument.
import { Array, DateTime, Duration, Option, Order, Schema } from "effect"
import { Instant, NonNegativeInt, Span, withDefault } from "./ids.ts"

/** A usage window, such as Claude's 5-hour session or ChatGPT's week. */
export class Window extends Schema.Class<Window>("Window")({
  span: Span,
  /** The model the limit covers, or absent when it covers every request. */
  model: Schema.optionalKey(Schema.String),
  /** Percent used, 0 to 100. */
  used: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optionalKey(Instant),
}) {
  /** A window read from a provider, with its use clamped to 0–100 (providers overshoot). */
  static of(span: Span, used: number, resetsAt?: DateTime.Utc, model?: string): Window {
    return new Window({
      span,
      used: Math.min(100, Math.max(0, Number.isFinite(used) ? used : 0)),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(model === undefined ? {} : { model }),
    })
  }
}

/** The last known windows of one account. */
export class Limits extends Schema.Class<Limits>("Limits")({
  windows: Schema.Array(Window).pipe(withDefault([])),
  observedAt: Schema.optionalKey(Instant),
  /** Limit resets the account holds, as its usage endpoint counts them. */
  resetCredits: Schema.optionalKey(NonNegativeInt),
  plan: Schema.optionalKey(Schema.String),
}) {
  static readonly empty: Limits = Schema.decodeUnknownSync(Limits)({})
}

/** A window from a pool of accounts read as one account. */
export class PoolWindow extends Schema.Class<PoolWindow>("PoolWindow")({
  span: Span,
  /** Percent used: the accounts' mean. */
  used: Schema.Number,
  /** When capacity next comes back: the soonest reset of a window in use. */
  resetsAt: Schema.optionalKey(Instant),
  /** Whether the mean is weighted by each account's share of the pool. */
  weighted: Schema.Boolean,
}) {}

/** A banked limit reset: redeeming it starts the account's windows over. */
export class LimitReset extends Schema.Class<LimitReset>("LimitReset")({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  grantedAt: Schema.optionalKey(Instant),
  expiresAt: Schema.optionalKey(Instant),
}) {}

/** A window that ran out its time, and how much of it had been used: the rest was quota thrown away. */
export interface Lapse {
  readonly span: Span
  readonly model?: string
  readonly used: number
  readonly endedAt: DateTime.Utc
}

/** The score of an account with no reading: worse than any real one, but still selectable. */
export const unknownScore = 101

/** A full window without a reset time stops blocking once its reading is this old. */
export const staleAfter: Duration.Duration = Duration.minutes(5)

/** A long window resetting this soon with room left is spent before any 5-hour window. */
export const urgentWithin: Duration.Duration = Duration.hours(24)

/** The room, in percent of a long window, that makes its reset worth saving. */
export const urgentSpare = 10

const spanRank = (span: Span): number => (span === "5h" ? 0 : span === "7d" ? 1 : 2)

const sameSlot = (a: Window, b: Window): boolean => a.span === b.span && a.model === b.model

/** Percent used at `now`: a window whose reset has passed starts over at 0. */
export const usedAt = (window: Window, now: DateTime.Utc): number =>
  window.resetsAt !== undefined && DateTime.isLessThanOrEqualTo(window.resetsAt, now) ? 0 : window.used

/** The reset, if it is still ahead. */
export const upcomingReset = (window: Window, now: DateTime.Utc): Option.Option<DateTime.Utc> =>
  window.resetsAt !== undefined && DateTime.isGreaterThan(window.resetsAt, now)
    ? Option.some(window.resetsAt)
    : Option.none()

export const isFull = (window: Window, now: DateTime.Utc): boolean => usedAt(window, now) >= 100

/** `5h`, `7d`, or `7d Fable` for a window that covers one model. */
export const windowLabel = (window: Window): string =>
  window.model === undefined ? window.span : `${window.span} ${window.model}`

/** Names a window by its length, so the 5-hour/week/month split survives plan changes. */
export const spanFor = (seconds: number): Span => (seconds < 86_400 ? "5h" : seconds >= 28 * 86_400 ? "30d" : "7d")

/** The window's length in minutes, as Codex states it. */
export const spanMinutes = (span: Span): number => (span === "5h" ? 300 : span === "30d" ? 43_200 : 10_080)

/** A reading taken at `now`, or nothing when it carries no windows. */
export const observed = (windows: ReadonlyArray<Window>, now: DateTime.Utc): Option.Option<Limits> =>
  windows.length === 0 ? Option.none() : Option.some(new Limits({ windows, observedAt: now }))

/** The windows that cover every request. */
export const sharedWindows = (windows: ReadonlyArray<Window>): ReadonlyArray<Window> =>
  windows.filter((window) => window.model === undefined)

/** The windows that cover one model only. */
export const scopedWindows = (windows: ReadonlyArray<Window>): ReadonlyArray<Window> =>
  windows.filter((window) => window.model !== undefined)

/** The window over every request for `span`. */
export const windowOf = <W extends { readonly span: Span; readonly model?: string }>(
  windows: ReadonlyArray<W>,
  span: Span,
): W | undefined => windows.find((window) => window.model === undefined && window.span === span)

/** The longer window: the week, or for plans without one, the month. */
export const longWindow = <W extends { readonly span: Span; readonly model?: string }>(
  windows: ReadonlyArray<W>,
): W | undefined => windowOf(windows, "7d") ?? windowOf(windows, "30d")

const bySlot = (a: Window, b: Window): number => {
  const rank = spanRank(a.span) - spanRank(b.span)
  if (rank !== 0) return rank
  if (a.model === b.model) return 0
  if (a.model === undefined) return -1
  if (b.model === undefined) return 1
  return a.model < b.model ? -1 : 1
}

/**
 * Folds a newer reading into an older one. Windows the newer one carries
 * replace older readings of the same slot; slots it leaves out are kept
 * unless their reset has passed.
 */
export const merge = (older: Limits | undefined, newer: Limits, now: DateTime.Utc): Limits => {
  const at = newer.observedAt ?? now
  const kept = (older?.windows ?? []).filter(
    (old) =>
      !newer.windows.some((window) => sameSlot(window, old)) &&
      (old.resetsAt === undefined || DateTime.isGreaterThan(old.resetsAt, at)),
  )
  const observedAt = newer.observedAt ?? older?.observedAt
  const resetCredits = newer.resetCredits ?? older?.resetCredits
  const plan = newer.plan ?? older?.plan
  return new Limits({
    windows: [...kept, ...newer.windows].toSorted(bySlot),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(resetCredits === undefined ? {} : { resetCredits }),
    ...(plan === undefined ? {} : { plan }),
  })
}

const newPeriodAfter = Duration.hours(1)

/**
 * The windows of the older reading that the newer one, taken at `now`, shows
 * have reset: their time passed, or a later period of the same slot began.
 * Each is reported once, since merging then drops it.
 */
export const lapsed = (older: Limits | undefined, newer: Limits, now: DateTime.Utc): ReadonlyArray<Lapse> =>
  (older?.windows ?? []).flatMap((old): ReadonlyArray<Lapse> => {
    if (old.resetsAt === undefined) return []
    const nextStarts = DateTime.addDuration(old.resetsAt, newPeriodAfter)
    const nextPeriod = newer.windows.some(
      (window) =>
        sameSlot(window, old) && window.resetsAt !== undefined && DateTime.isGreaterThan(window.resetsAt, nextStarts),
    )
    if (DateTime.isGreaterThan(old.resetsAt, now) && !nextPeriod) return []
    return [
      {
        span: old.span,
        used: old.used,
        endedAt: old.resetsAt,
        ...(old.model === undefined ? {} : { model: old.model }),
      },
    ]
  })

/** The highest use across shared windows, or {@link unknownScore} when there is no reading. */
export const score = (limits: Limits | undefined, now: DateTime.Utc): number => {
  const shared = sharedWindows(limits?.windows ?? [])
  return shared.length === 0 ? unknownScore : Math.max(...shared.map((window) => usedAt(window, now)))
}

/**
 * The full windows that stop requests (for `model`, when given, its own
 * windows count too). A full window without a reset time counts only while
 * the reading is fresh, so stale data cannot park an account forever.
 */
const fullWindows = (limits: Limits, now: DateTime.Utc, model?: string): ReadonlyArray<Window> => {
  const fresh =
    limits.observedAt !== undefined && Duration.isLessThan(DateTime.distance(limits.observedAt, now), staleAfter)
  return limits.windows.filter(
    (window) =>
      (window.model === undefined || window.model === model) &&
      isFull(window, now) &&
      (fresh || Option.isSome(upcomingReset(window, now))),
  )
}

export const isExhausted = (limits: Limits, now: DateTime.Utc, model?: string): boolean =>
  fullWindows(limits, now, model).length > 0

/** When a full window lets the account serve again: the latest of their resets, since all must reopen. */
export const exhaustedUntil = (limits: Limits, now: DateTime.Utc, model?: string): Option.Option<DateTime.Utc> =>
  latest(fullWindows(limits, now, model).flatMap((window) => Option.toArray(upcomingReset(window, now))))

const soonest = (times: ReadonlyArray<DateTime.Utc>): Option.Option<DateTime.Utc> =>
  Array.isReadonlyArrayNonEmpty(times) ? Option.some(Array.min(times, DateTime.Order)) : Option.none()

const latest = (times: ReadonlyArray<DateTime.Utc>): Option.Option<DateTime.Utc> =>
  Array.isReadonlyArrayNonEmpty(times) ? Option.some(Array.max(times, DateTime.Order)) : Option.none()

/** When an account's spare capacity is lost, for spending it first. */
export interface Urgency {
  /** A long window with real room left that resets within a day: its unused quota is fee thrown away. */
  readonly weekEnding: Option.Option<DateTime.Utc>
  /** The soonest started 5-hour window with room left. */
  readonly short: Option.Option<DateTime.Utc>
  /** The soonest long window with room left. */
  readonly long: Option.Option<DateTime.Utc>
}

export const urgency = (limits: Limits | undefined, now: DateTime.Utc): Urgency => {
  const shared = sharedWindows(limits?.windows ?? [])
  const resets = (windows: ReadonlyArray<Window>) =>
    windows.flatMap((window) => Option.toArray(upcomingReset(window, now)))
  const spare = shared.filter((window) => !isFull(window, now))
  const urgentBy = DateTime.addDuration(now, urgentWithin)
  return {
    weekEnding: soonest(
      resets(shared.filter((window) => window.span !== "5h" && usedAt(window, now) <= 100 - urgentSpare)).filter((at) =>
        DateTime.isLessThanOrEqualTo(at, urgentBy),
      ),
    ),
    short: soonest(resets(spare.filter((window) => window.span === "5h" && usedAt(window, now) > 0))),
    long: soonest(resets(spare.filter((window) => window.span !== "5h"))),
  }
}

/** Sooner first, and a moment not known after every known one. */
const soonerFirst: Order.Order<Option.Option<DateTime.Utc>> = Order.combine(
  Order.mapInput(Order.Boolean, Option.isNone),
  Option.makeOrder(DateTime.Order),
)

/** Sorts the most urgent account first: by a week ending, then a started 5-hour window, then any long window. */
export const urgencyOrder: Order.Order<Urgency> = Order.combineAll([
  Order.mapInput(soonerFirst, (u: Urgency) => u.weekEnding),
  Order.mapInput(soonerFirst, (u: Urgency) => u.short),
  Order.mapInput(soonerFirst, (u: Urgency) => u.long),
])

/** The soonest moment some spare capacity on the account is known to expire. */
export const expiringAt = (limits: Limits | undefined, now: DateTime.Utc): Option.Option<DateTime.Utc> => {
  const u = urgency(limits, now)
  return Option.orElse(u.weekEnding, () => Option.orElse(u.short, () => u.long))
}

/** One account of a pool: its limits, whether it sits out, and its share of the pool's capacity. */
export interface PoolMember {
  readonly limits: Limits
  /** A blocked account counts as full in its shortest window. */
  readonly blocked?: boolean
  readonly share?: number
}

/**
 * A pool of accounts read as one: for each span, the mean use of the
 * accounts with that window (weighted by share when every member has one),
 * and the soonest reset of a window in use. Accounts without a reading for a
 * span are left out of its mean.
 */
export const pooled = (members: ReadonlyArray<PoolMember>, now: DateTime.Utc): ReadonlyArray<PoolWindow> => {
  const weighted = members.length > 0 && members.every((member) => member.share !== undefined)
  return Span.literals.flatMap((span): ReadonlyArray<PoolWindow> => {
    const readings = members.flatMap((member) => {
      const shared = sharedWindows(member.limits.windows)
      const window = shared.find((w) => w.span === span)
      if (window === undefined) return []
      const shortest = Math.min(...shared.map((w) => spanRank(w.span)))
      const used = member.blocked === true && shortest === spanRank(span) ? 100 : usedAt(window, now)
      return [{ used, reset: upcomingReset(window, now), weight: weighted ? (member.share ?? 0) : 1 }]
    })
    const total = readings.reduce((sum, reading) => sum + reading.weight, 0)
    if (readings.length === 0 || total <= 0) return []
    const used = readings.reduce((sum, reading) => sum + reading.used * reading.weight, 0) / total
    const resetsAt = soonest(
      readings.filter((reading) => reading.used > 0).flatMap((reading) => Option.toArray(reading.reset)),
    )
    return [
      new PoolWindow({
        span,
        used,
        weighted,
        ...Option.match(resetsAt, { onNone: () => ({}), onSome: (at) => ({ resetsAt: at }) }),
      }),
    ]
  })
}
