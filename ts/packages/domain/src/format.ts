// Numbers, times and states written for people, the same in every front end:
// the CLI's tables, the dashboard, the desktop window and its menu bar, and
// the messages agents read. Times of day take the zone to show them in, so
// tests and the CLI agree on what "local" is.
import { DateTime, Duration, Option } from "effect"
import { agentFacts } from "./agents.ts"
import type { Window } from "./limits.ts"
import { upcomingReset, usedAt } from "./limits.ts"
import type { Notice, NoticeKind } from "./notice.ts"
import { providerFacts } from "./providers.ts"
import type { Condition, NextReason, Note, Report, Tone } from "./report.ts"

const numbers = new Map<string, Intl.NumberFormat>()

/**
 * `value` with exactly `places` decimals, ties rounded to even (2.5 reads
 * `2`, 0.125 reads `0.12`) so a percent never jumps a point on a tie.
 */
export const fixed = (value: number, places: number): string => {
  const key = String(places)
  let format = numbers.get(key)
  if (format === undefined) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
      roundingMode: "halfEven",
      useGrouping: false,
    })
    numbers.set(key, format)
  }
  return format.format(value)
}

const groupedFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, roundingMode: "halfEven" })

/** A whole number with thousands separated: `1,234,567`. */
export const grouped = (value: number): string => groupedFormat.format(value)

/** A count in about three figures: `999`, `12.3k`, `1.2M`, `5.0B`. */
export const compact = (count: number): string =>
  count >= 1e9
    ? `${fixed(count / 1e9, 1)}B`
    : count >= 1e6
      ? `${fixed(count / 1e6, 1)}M`
      : count >= 1e3
        ? `${fixed(count / 1e3, 1)}k`
        : String(Math.trunc(count))

/** Dollars to the cent: `$12.50`. */
export const money = (dollars: number): string => `$${fixed(dollars, 2)}`

/** A percentage to the point: `42%`. */
export const percent = (used: number): string => `${fixed(used, 0)}%`

const two = (n: number) => String(n).padStart(2, "0")

/** A duration in its two largest units: `42s`, `9m30s`, `2h05m`, `3d4h`. Below zero reads `0s`. */
export const duration = (length: Duration.Duration): string => {
  const total = Math.max(0, Math.trunc(Duration.toSeconds(length)))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${two(minutes)}m`
  if (minutes > 0) return `${minutes}m${two(seconds)}s`
  return `${seconds}s`
}

/** The time left until `at`, or `now` once it has passed. */
export const until = (at: DateTime.DateTime, now: DateTime.DateTime): string =>
  DateTime.isGreaterThan(at, now) ? duration(DateTime.distance(now, at)) : "now"

interface ClockFormats {
  readonly time: Intl.DateTimeFormat
  readonly weekday: Intl.DateTimeFormat
  readonly monthDay: Intl.DateTimeFormat
}

// Building an Intl formatter costs far more than using one, and a window
// shows many times in the same zone, so each zone's formatters are kept.
const clockFormats = new Map<string, ClockFormats>()

const formatsIn = (zone: DateTime.TimeZone): ClockFormats => {
  const timeZone = DateTime.zoneToString(zone)
  let formats = clockFormats.get(timeZone)
  if (formats === undefined) {
    formats = {
      time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      weekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }),
      monthDay: new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }),
    }
    clockFormats.set(timeZone, formats)
  }
  return formats
}

/** How many calendar days in `zone` lie from `from`'s date to `to`'s. */
const daysBetween = (from: DateTime.DateTime, to: DateTime.DateTime, zone: DateTime.TimeZone): number => {
  const dayOf = (at: DateTime.DateTime) => DateTime.startOf(DateTime.setZone(at, zone), "day")
  // A day with a clock change is 23 or 25 hours long.
  return Math.round(Duration.toDays(DateTime.distance(dayOf(from), dayOf(to))))
}

/**
 * When `at` comes, on the clock in `zone`: `22:59` on today's date there,
 * `Wed 20:27` within the next six days, `Nov 3` otherwise.
 */
export const clock = (at: DateTime.DateTime, now: DateTime.DateTime, zone: DateTime.TimeZone): string => {
  const formats = formatsIn(zone)
  const time = DateTime.formatIntl(at, formats.time)
  const ahead = daysBetween(now, at, zone)
  if (ahead === 0) return time
  if (ahead >= 1 && ahead <= 6) return `${DateTime.formatIntl(at, formats.weekday)} ${time}`
  return DateTime.formatIntl(at, formats.monthDay)
}

/** The day `at` fell on, in `zone`: `today`, `yesterday`, or `Sep 21`. */
export const day = (at: DateTime.DateTime, now: DateTime.DateTime, zone: DateTime.TimeZone): string => {
  const back = daysBetween(at, now, zone)
  return back === 0 ? "today" : back === 1 ? "yesterday" : DateTime.formatIntl(at, formatsIn(zone).monthDay)
}

/** When an account was last used, coarsely: `used just now`, `used 3m ago`, `used 2h ago`, `used 4d ago`. */
export const ago = (at: DateTime.DateTime, now: DateTime.DateTime): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(at, now))))
  if (seconds < 60) return "used just now"
  if (seconds < 3_600) return `used ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `used ${Math.floor(seconds / 3_600)}h ago`
  return `used ${Math.floor(seconds / 86_400)}d ago`
}

/** A window's use against spending it evenly until it resets. */
export interface Pace {
  /** How much of the window has passed, 0 to 1. */
  readonly elapsed: number
  readonly text: string
  readonly tone: Tone
}

const spanSeconds = { "5h": 5 * 3_600, "7d": 7 * 86_400, "30d": 30 * 86_400 } as const

/** Within this many points of an even spend counts as on pace. */
const onPace = 5

/**
 * How a window is being spent: `On pace`, `Runs out ~Wed 20:27` when ahead
 * of an even spend, or `12% in reserve` when behind. Nothing before 3% of
 * the window has passed (too soon to say), nor once it is spent.
 */
export const pace = (window: Window, now: DateTime.DateTime, zone: DateTime.TimeZone): Option.Option<Pace> => {
  const utcNow = DateTime.toUtc(now)
  const used = usedAt(window, utcNow)
  const length = spanSeconds[window.span]
  return Option.flatMap(upcomingReset(window, utcNow), (resets): Option.Option<Pace> => {
    const passed = length - Math.trunc(Duration.toSeconds(DateTime.distance(now, resets)))
    const elapsed = passed / length
    if (elapsed < 0.03 || elapsed >= 1 || used >= 100) return Option.none()
    const ahead = used - elapsed * 100
    if (Math.abs(ahead) < onPace) return Option.some({ elapsed, text: "On pace", tone: "muted" })
    if (ahead > 0) {
      // Ahead of an even spend, the same rate fills the window before it resets.
      const rate = used / passed
      const out = DateTime.addDuration(now, Duration.seconds(Math.trunc((100 - used) / rate)))
      return Option.some({ elapsed, text: `Runs out ~${clock(out, now, zone)}`, tone: "warn" })
    }
    return Option.some({ elapsed, text: `${fixed(-ahead, 0)}% in reserve`, tone: "muted" })
  })
}

/** The menu bar's title: each pool's 5-hour use, `Claude 42% · ChatGPT —`, or `slopmax` with no pools. */
export const menuBar = (report: Report, now: DateTime.DateTime): string => {
  const parts = report.pools.map((pool) => {
    const title = providerFacts[pool.provider].title
    const window = pool.windows.find((w) => w.span === "5h")
    if (window === undefined) return `${title} —`
    const passed = window.resetsAt !== undefined && DateTime.isLessThanOrEqualTo(window.resetsAt, now)
    return `${title} ${percent(passed ? 0 : window.used)}`
  })
  return parts.length === 0 ? "slopmax" : parts.join(" · ")
}

/** An account's condition as every front end words it. */
export const conditionText = (condition: Condition, now: DateTime.DateTime): string => {
  switch (condition._tag) {
    case "SignInNeeded":
      return `sign in again (${condition.error})`
    case "Disabled":
      return "disabled"
    case "Limited":
      return `limited · back in ${until(condition.until, now)}`
    case "Throttled":
      return "throttled"
    case "Active":
      return condition.sessions === 1 ? "● active · 1 session" : `● active · ${condition.sessions} sessions`
    case "Ready":
      return "ready"
  }
}

/** A note beside an account, as every front end words it. */
export const noteText = (note: Note): string => {
  switch (note._tag) {
    case "Pinned":
      return "pinned"
    case "Priority":
      return `priority ${note.value}`
    case "Follows":
      return `follows ${note.tool}`
    case "Resets":
      return note.count === 1 ? "1 limit reset" : `${note.count} limit resets`
    case "Served":
      return `${note.requests} req · ${compact(note.tokens)} tok`
    case "LastError":
      return `last error: ${note.text}`
  }
}

const nextReasons: { readonly [K in NextReason]: string } = {
  pinned: "pinned for new sessions",
  "only-one": "the only account ready",
  "week-ending": "its week resets within the day with quota to spare",
  "resets-first": "its quota resets soonest",
  "fills-first": "first in priority order",
  "most-room": "the most room left",
  turn: "next in turn",
}

/** Why a new session would get an account, in a phrase. */
export const nextReasonText = (reason: NextReason): string => nextReasons[reason]

const noticeTitles: { readonly [K in NoticeKind]: string } = {
  "reset-expiring": "Limit reset expiring",
  "quota-unused": "Quota going unused",
  exhausted: "Every account is limited",
  recovered: "Accounts are back",
  "signed-out": "Sign in again",
  limited: "Account limited",
  available: "Account available",
  test: "slopmax",
}

/** A notification's title for a kind of notice. */
export const noticeTitle = (kind: NoticeKind): string => noticeTitles[kind]

/** A notification's body: the notice's message without the backticks around commands. */
export const noticeBody = (notice: Notice): string => notice.message.replaceAll("`", "")

/** A provider's name for people. */
export const providerTitle = (id: keyof typeof providerFacts): string => providerFacts[id].title

/** An agent's name for people. */
export const agentTitle = (id: keyof typeof agentFacts): string => agentFacts[id].title
