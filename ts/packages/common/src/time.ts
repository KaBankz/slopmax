// Wall-clock time: UTC instants and signed durations, with RFC 3339 and
// HTTP-date parsing. Exactly what slopmax needs, without a date library.
//
// Both are plain millisecond numbers: a `Timestamp` is milliseconds since
// the Unix epoch, a `SignedDuration` a signed count of milliseconds (which
// is also a `Duration.Input`, so it goes straight to `Effect.sleep` and
// `Schedule`). The Rust counts nanoseconds; text with more digits is read
// and cut to the millisecond. The range is the Rust's (years 1678–2261),
// and arithmetic saturates at its ends as the Rust's does.
import process from "node:process"

import { Clock, Data, Effect, Result, Schema, SchemaGetter, SchemaIssue } from "effect"

import { zeroPad } from "./fmt.ts"
import { trim } from "./text.ts"

// i64::MAX nanoseconds, in whole milliseconds.
const LIMIT = 9_223_372_036_854
// i64::MIN nanoseconds as a timestamp reads its milliseconds (`div_euclid`
// rounds down); a duration's `as_millis` rounds toward zero, to `-LIMIT`.
const EARLIEST = -9_223_372_036_855
const SECS_PER_DAY = 86_400

// Whole milliseconds, saturating at the Rust's range; NaN reads as zero,
// as Rust's `as i64` does.
const clamp = (ms: number, low: number): number => (ms !== ms ? 0 : Math.max(low, Math.min(LIMIT, Math.trunc(ms))) + 0)
const saturate = (ms: number): number => clamp(ms, -LIMIT)
const saturateAt = (ms: number): number => clamp(ms, EARLIEST)

const div = (a: number, b: number): number => Math.floor(a / b)
const mod = (a: number, b: number): number => a - Math.floor(a / b) * b

/** A signed span of time in whole milliseconds. */
export type SignedDuration = number

export const SignedDuration = {
  ZERO: 0 as SignedDuration,
  fromSecs: (secs: number): SignedDuration => saturate(secs * 1_000),
  fromMins: (mins: number): SignedDuration => saturate(mins * 60_000),
  fromHours: (hours: number): SignedDuration => saturate(hours * 3_600_000),
  fromMillis: (millis: number): SignedDuration => saturate(millis),
  /** Fractional seconds; out-of-range values saturate. */
  fromSecsF64: (secs: number): SignedDuration => saturate(secs * 1_000),
  /** Whole seconds, rounded toward zero. */
  asSecs: (d: SignedDuration): number => Math.trunc(d / 1_000) + 0,
  asMillis: (d: SignedDuration): number => d,
  isPositive: (d: SignedDuration): boolean => d > 0,
} as const

/** A UTC instant in milliseconds since the Unix epoch, covering the years 1678–2261. */
export type Timestamp = number

/** The text is not an RFC 3339 timestamp with an offset. */
export class ParseError extends Data.TaggedError("ParseError")<{}> {
  override get message(): string {
    return "invalid RFC 3339 timestamp"
  }
}

// One shared failure: `ParseError` carries nothing, and building an Error
// (with its stack) on every parse would cost more than the parse.
const FAIL: Result.Result<never, ParseError> = Result.fail(new ParseError())

/** The months as RFC 2822 abbreviates them, January first. */
export const MONTHS: ReadonlyArray<string> = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/** A proleptic Gregorian date and time of day. */
interface Civil {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const isLeap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeap(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31

/** Days since 1970-01-01 (Howard Hinnant's `days_from_civil`). */
export const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = div(y, 400)
  const yearOfEra = mod(y, 400)
  const monthFromMarch = (month + 9) % 12
  const dayOfYear = div(153 * monthFromMarch + 2, 5) + day - 1
  const dayOfEra = yearOfEra * 365 + div(yearOfEra, 4) - div(yearOfEra, 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

/** The date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`). */
export const civilFromDays = (days: number): readonly [year: number, month: number, day: number] => {
  const shifted = days + 719_468
  const era = div(shifted, 146_097)
  const dayOfEra = mod(shifted, 146_097)
  const yearOfEra = div(dayOfEra - div(dayOfEra, 1_460) + div(dayOfEra, 36_524) - div(dayOfEra, 146_096), 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + div(yearOfEra, 4) - div(yearOfEra, 100))
  const monthFromMarch = div(5 * dayOfYear + 2, 153)
  const day = dayOfYear - div(153 * monthFromMarch + 2, 5) + 1
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day]
}

// The instant a local time denotes at `offset` seconds east of UTC, plus
// `nanos`, or undefined if a field is out of range or the instant is outside
// what the Rust's i64 of nanoseconds holds.
const toTimestamp = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offset: number,
  nanos: number,
): Timestamp | undefined => {
  const valid =
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour < 24 && minute < 60 && second < 60
  if (!valid) return undefined
  const secs = daysFromCivil(year, month, day) * SECS_PER_DAY + hour * 3_600 + minute * 60 + second - offset
  // i64::MAX is 9_223_372_036.854_775_807 seconds; i64::MIN one nanosecond further.
  if (secs > 9_223_372_036 || secs < -9_223_372_036 || (secs === 9_223_372_036 && nanos > 854_775_807)) {
    return undefined
  }
  return secs * 1_000 + Math.floor(nanos / 1_000_000)
}

const civil = (t: Timestamp): readonly [Civil, number] => {
  const secs = div(t, 1_000)
  const millis = t - secs * 1_000
  const [year, month, day] = civilFromDays(div(secs, SECS_PER_DAY))
  const ofDay = mod(secs, SECS_PER_DAY)
  return [{ year, month, day, hour: div(ofDay, 3_600), minute: div(ofDay, 60) % 60, second: ofDay % 60 }, millis]
}

const dateTime = (c: Civil): string =>
  `${zeroPad(c.year, 4)}-${zeroPad(c.month, 2)}-${zeroPad(c.day, 2)}T${zeroPad(c.hour, 2)}:${zeroPad(c.minute, 2)}:${zeroPad(c.second, 2)}`

// Rust's `str::parse::<u32>()` (and `i64` when `signed`): ASCII digits after
// an optional `+` (or `-`), nothing else.
const UNSIGNED = /^\+?[0-9]+$/
const SIGNED = /^[+-]?[0-9]+$/
const integer = (text: string | undefined, signed: boolean): number | undefined =>
  text !== undefined && (signed ? SIGNED : UNSIGNED).test(text) ? Number(text) : undefined

const isDigit = (c: number): boolean => c >= 48 && c <= 57

// The number in the ASCII digits `b[from..to]`, or -1 when one is missing or
// not a digit.
const digitsAt = (b: string, from: number, to: number): number => {
  if (b.length < to) return -1
  let n = 0
  for (let i = from; i < to; i++) {
    const c = b.charCodeAt(i)
    if (!isDigit(c)) return -1
    n = n * 10 + (c - 48)
  }
  return n
}

/** RFC 3339: `2026-10-04T07:20:00.250378+00:00`, `2026-10-04 07:20:00Z`. */
const parse = (text: string): Result.Result<Timestamp, ParseError> => {
  // All accepted text is ASCII, so UTF-16 positions are the Rust's byte positions.
  const b = trim(text)
  // `-`, `-`, `T`/`t`/space, `:`, `:` at 4, 7, 10, 13, 16 (charCodeAt past the end is NaN).
  const t = b.charCodeAt(10)
  if (
    b.charCodeAt(4) !== 45 ||
    b.charCodeAt(7) !== 45 ||
    (t !== 84 && t !== 116 && t !== 32) ||
    b.charCodeAt(13) !== 58 ||
    b.charCodeAt(16) !== 58
  ) {
    return FAIL
  }
  const year = digitsAt(b, 0, 4)
  const month = digitsAt(b, 5, 7)
  const day = digitsAt(b, 8, 10)
  const hour = digitsAt(b, 11, 13)
  const minute = digitsAt(b, 14, 16)
  const second = digitsAt(b, 17, 19)
  if (year < 0 || month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0) return FAIL

  let at = 19
  let nanos = 0
  if (b.charCodeAt(at) === 46) {
    let digits = 0
    while (isDigit(b.charCodeAt(at + 1 + digits))) digits++
    if (digits === 0) return FAIL
    for (let i = 0; i < Math.min(digits, 9); i++) nanos += (b.charCodeAt(at + 1 + i) - 48) * 10 ** (8 - i)
    at += 1 + digits
  }
  let offset: number
  const rest = b.length - at
  const s = b.charCodeAt(at)
  if (rest === 1 && (s === 90 || s === 122)) {
    offset = 0
  } else {
    // `±HH:MM` or `±HHMM`.
    const colon = rest === 6 && b.charCodeAt(at + 3) === 58
    if ((s !== 43 && s !== 45) || !(colon || rest === 5)) return FAIL
    const hours = digitsAt(b, at + 1, at + 3)
    const mins = colon ? digitsAt(b, at + 4, at + 6) : digitsAt(b, at + 3, at + 5)
    if (hours < 0 || mins < 0 || hours > 23 || mins > 59) return FAIL
    const secs = hours * 3_600 + mins * 60
    offset = s === 45 ? -secs : secs
  }
  const instant = toTimestamp(year, month, day, hour, minute, Math.min(second, 59), offset, nanos)
  return instant === undefined ? FAIL : Result.succeed(instant)
}

export const Timestamp = {
  UNIX_EPOCH: 0 as Timestamp,
  /** Later than any real instant; useful as a sort key for "never". */
  MAX: LIMIT as Timestamp,

  /** The current instant, from `Clock` (so `TestClock` drives it). */
  now: Clock.currentTimeMillis,

  /** The current instant from the system clock, for code outside Effect. */
  nowUnsafe: (): Timestamp => Date.now(),

  /** Seconds since the Unix epoch, or undefined when out of range. */
  fromSecond: (secs: number): Timestamp | undefined =>
    Math.abs(secs) <= 9_223_372_036 ? Math.trunc(secs) * 1_000 + 0 : undefined,

  /** Milliseconds since the Unix epoch, or undefined when out of range. */
  fromMillisecond: (millis: number): Timestamp | undefined =>
    Math.abs(millis) <= LIMIT ? Math.trunc(millis) + 0 : undefined,

  /** Whole seconds since the Unix epoch, rounded down. */
  asSecond: (t: Timestamp): number => div(t, 1_000),

  asMillisecond: (t: Timestamp): number => t,

  /** `t + d`, saturating. */
  add: (t: Timestamp, d: SignedDuration): Timestamp => saturateAt(t + d),

  /** `t - d`, saturating. */
  sub: (t: Timestamp, d: SignedDuration): Timestamp => saturateAt(t - d),

  /** `self - earlier`; negative when `earlier` is actually later. */
  durationSince: (self: Timestamp, earlier: Timestamp): SignedDuration => saturate(self - earlier),

  /** Parses an IMF-fixdate HTTP date such as `Sun, 06 Nov 1994 08:49:37 GMT`. */
  fromHttpDate: (text: string): Timestamp | undefined => {
    const trimmed = trim(text)
    const comma = trimmed.indexOf(", ")
    if (comma < 0) return undefined
    const parts = trimmed.slice(comma + 2).split(" ")
    if (parts.length !== 5 || parts[4] !== "GMT") return undefined
    const day = integer(parts[0], false)
    const month = MONTHS.indexOf(parts[1] ?? "") + 1
    const year = integer(parts[2], true)
    const clock = (parts[3] ?? "").split(":")
    if (clock.length !== 3) return undefined
    const hour = integer(clock[0], false)
    const minute = integer(clock[1], false)
    const second = integer(clock[2], false)
    if (day === undefined || month === 0 || year === undefined) return undefined
    if (hour === undefined || minute === undefined || second === undefined) return undefined
    return toTimestamp(year, month, day, hour, minute, second, 0, 0)
  },

  /** RFC 3339 text with any offset, or `ParseError`. */
  parse,

  /**
   * RFC 3339 in UTC, with only as many fractional digits as needed:
   * `2026-10-04T07:20:00Z`, `2026-10-04T07:20:00.25Z`. This is also the JSON form.
   */
  display: (t: Timestamp): string => {
    const [c, millis] = civil(t)
    if (millis === 0) return `${dateTime(c)}Z`
    return `${dateTime(c)}.${zeroPad(millis, 3).replace(/0+$/, "")}Z`
  },

  /**
   * RFC 3339 in UTC with exactly three fractional digits, for aligned log
   * lines: `2026-10-04T07:20:00.250Z`.
   */
  displayMillis: (t: Timestamp): string => {
    const [c, millis] = civil(t)
    return `${dateTime(c)}.${zeroPad(millis, 3)}Z`
  },

  /** The calendar date `[year, month, day]` at this instant, `offset` east of UTC. */
  date: (t: Timestamp, offset: SignedDuration): readonly [year: number, month: number, day: number] => {
    const [c] = civil(saturateAt(t + offset))
    return [c.year, c.month, c.day]
  },

  /** The wall-clock `[hour, minute]` at this instant, `offset` east of UTC. */
  timeOfDay: (t: Timestamp, offset: SignedDuration): readonly [hour: number, minute: number] => {
    const [c] = civil(saturateAt(t + offset))
    return [c.hour, c.minute]
  },

  /** Midnight starting `(year, month, day)`, `offset` east of UTC. */
  midnight: (year: number, month: number, day: number, offset: SignedDuration): Timestamp | undefined =>
    toTimestamp(year, month, day, 0, 0, 0, SignedDuration.asSecs(offset), 0),

  /**
   * This machine's UTC offset at this instant (daylight saving included),
   * or zero where it cannot be read. Windows reads as zero, as in the Rust,
   * whose offset comes from `localtime_r`.
   */
  localOffset: (t: Timestamp): SignedDuration => {
    if (process.platform === "win32") return 0
    // The local fields read back as UTC, less the instant. Unlike
    // `getTimezoneOffset`, which counts whole minutes, this keeps the seconds
    // of old local-mean-time offsets (Monrovia's -0:44:30), as `tm_gmtoff` does.
    const d = new Date(t)
    const local = Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
    )
    const offset = local - t
    return offset === offset ? saturate(offset) : 0
  },
} as const

/**
 * A `Timestamp` as JSON and on disk: RFC 3339 text (`Timestamp.display`),
 * read with `Timestamp.parse`. A malformed value fails with
 * `invalid RFC 3339 timestamp`. Encoding checks the number is a whole
 * millisecond, so a fractional or NaN value fails instead of being written
 * as text that would not read back.
 */
export const TimestampFromString: Schema.decodeTo<Schema.Int, Schema.String> = Schema.String.pipe(
  Schema.decodeTo(Schema.Int, {
    decode: SchemaGetter.transformEffect((text: string, options) =>
      Result.match(parse(text), {
        onSuccess: (t) => Effect.succeed(t),
        onFailure: (e) => Effect.fail(new SchemaIssue.InvalidValue({ message: e.message }, text, options)),
      }),
    ),
    encode: SchemaGetter.transform(Timestamp.display),
  }),
)
