// A pool over time as the provider page draws it: each window's recorded
// and projected use as chart points, the four numbers under the chart, the
// resets ahead on a lane per account, what each account's windows have
// served, and its last day of requests in half hours. Pure: the detail, the
// names, `now` and the zone come in as arguments.
import type { AccountDetail, HealthCell, PoolDetail, Span, Tone, Trend, WindowSpend } from "@slopmax/client"
import { clock, compact, fixed, grouped, until } from "@slopmax/client/format"
import { DateTime } from "effect"
import { spanTitle } from "./groups.ts"
import { dollars } from "./words.ts"

/** One point of a trend chart: a recorded value, a projected one, or both where they meet (now). */
export interface TrendDatum {
  /** Milliseconds since the epoch. */
  readonly t: number
  readonly recorded?: number
  readonly projected?: number
  readonly tip: string
}

/** A number under the chart, with what it means. */
export interface Figure {
  readonly title: string
  readonly value: string
  readonly detail: string
  readonly tone: Tone
}

/** An account's reset ahead, on the chart's time axis. */
export interface ResetTick {
  readonly t: number
  readonly tip: string
}

export interface TrendView {
  readonly span: Span
  readonly title: string
  /** `56%`. */
  readonly used: string
  readonly data: ReadonlyArray<TrendDatum>
  /** The time axis, in milliseconds: from the first reading shown to the end of the projection. */
  readonly from: number
  readonly to: number
  readonly now: number
  readonly ticks: ReadonlyArray<number>
  readonly resets: ReadonlyArray<ResetTick>
  readonly figures: ReadonlyArray<Figure>
  /** Whether the readings reach back far enough to draw a line, rather than one point. */
  readonly recorded: boolean
  /** Whether the projection runs the pool dry. */
  readonly dry: boolean
}

const ms = (at: DateTime.DateTime): number => DateTime.toEpochMillis(at)

// Intl formatters cost far more to build than to use, so each is kept by zone.
const formats = new Map<string, Intl.DateTimeFormat>()

const formatIn = (zone: DateTime.TimeZone, kind: "time" | "weekday" | "weekdayTime"): Intl.DateTimeFormat => {
  const timeZone = DateTime.zoneToString(zone)
  const key = `${kind} ${timeZone}`
  let format = formats.get(key)
  if (format === undefined) {
    const time = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const
    format = new Intl.DateTimeFormat(
      "en-US",
      kind === "time"
        ? { timeZone, ...time }
        : kind === "weekday"
          ? { timeZone, weekday: "short" }
          : { timeZone, weekday: "short", ...time },
    )
    formats.set(key, format)
  }
  return format
}

const at = (t: number): DateTime.Utc => DateTime.makeUnsafe(t)

const hour = 3_600_000

/** `0.9%/h`, finer below one a tenth. */
export const rate = (perHour: number): string => `${fixed(perHour, perHour < 0.1 ? 2 : 1)}%/h`

/** Ticks on the time axis: every few hours for a day or less, else at each local midnight. */
const timeTicks = (from: number, to: number, zone: DateTime.TimeZone): ReadonlyArray<number> => {
  const length = to - from
  if (length <= 36 * hour) {
    const step = length <= 12 * hour ? 2 * hour : 6 * hour
    const first = Math.ceil(from / step) * step
    return Array.from({ length: Math.floor((to - first) / step) + 1 }, (_, i) => first + i * step)
  }
  const ticks: Array<number> = []
  let day = DateTime.startOf(DateTime.setZone(at(from), zone), "day")
  while (ms(day) <= to) {
    if (ms(day) >= from) ticks.push(ms(day))
    day = DateTime.add(day, { days: 1 })
  }
  return ticks
}

/** A tick's words: `18:00` within a day, else the weekday, `Tue`. */
export const tickLabel = (t: number, span: Span, zone: DateTime.TimeZone): string => {
  return DateTime.formatIntl(at(t), formatIn(zone, span === "5h" ? "time" : "weekday"))
}

const when = (t: number, zone: DateTime.TimeZone): string => DateTime.formatIntl(at(t), formatIn(zone, "weekdayTime"))

const figures = (
  trend: Trend,
  names: ReadonlyMap<string, string>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): ReadonlyArray<Figure> => {
  // Whole, as the accounts table names them: two logins can share a user.
  const name = (id: string) => names.get(id) ?? id
  const sustainable = trend.sustainable
  const fast = trend.burn !== undefined && sustainable !== undefined && trend.burn > sustainable * 1.1
  // The pace is the first of the daemon's measures it could take: 3 hours, else 1, else 6.
  const hours = trend.burns.find((b) => b.rate === trend.burn)?.hours
  const over =
    hours === undefined ? "Over the last few hours" : `Over the last ${hours === 1 ? "hour" : `${hours} hours`}`
  const pace: Figure =
    trend.burn === undefined
      ? {
          title: "Pace",
          value: "—",
          detail: "Measured once slopmax has an hour or more of readings",
          tone: "muted",
        }
      : {
          title: "Pace",
          value: rate(trend.burn),
          detail:
            sustainable === undefined
              ? over
              : fast
                ? `${over}, faster than the ${rate(sustainable)} that lasts the window`
                : `${over}, within the ${rate(sustainable)} that lasts the window`,
          tone: fast ? "warn" : "good",
        }
  const dry: Figure =
    trend.runsOutAt === undefined
      ? {
          title: "Runs dry",
          value: "Not at this pace",
          detail: trend.burn === undefined ? "No pace to project yet" : "Resets give back more than it uses",
          tone: "good",
        }
      : {
          title: "Runs dry",
          value: `~${clock(trend.runsOutAt, now, zone)}`,
          detail:
            trend.dryUntil === undefined
              ? `In ${until(trend.runsOutAt, now)}, at the recent pace`
              : `In ${until(trend.runsOutAt, now)} at the recent pace, until a reset at ${clock(trend.dryUntil, now, zone)}`,
          tone: "warn",
        }
  const first: Figure =
    trend.firstOut === undefined
      ? {
          title: "First account out",
          value: "None",
          detail: "No account runs out before it resets",
          tone: "good",
        }
      : {
          title: "First account out",
          value: name(trend.firstOut.account),
          detail: `~${clock(trend.firstOut.at, now, zone)}, in ${until(trend.firstOut.at, now)}, at its recent pace`,
          tone: "warn",
        }
  const soonest = trend.resets[0]
  const next: Figure =
    soonest === undefined
      ? { title: "Next reset", value: "—", detail: "None ahead with use to give back", tone: "muted" }
      : {
          title: "Next reset",
          value: `+${fixed(soonest.givesBack, 0)}%`,
          detail: `${name(soonest.account)}, ${clock(soonest.at, now, zone)}`,
          tone: "muted",
        }
  return [pace, dry, first, next]
}

/** One trend of the pool as its chart and figures. */
export const trendView = (
  trend: Trend,
  names: ReadonlyMap<string, string>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): TrendView => {
  const nowMs = ms(now)
  const recorded: Array<TrendDatum> = trend.recorded.map((point) => ({
    t: ms(point.at),
    recorded: point.used,
    tip: `${when(ms(point.at), zone)}\n${fixed(point.used, 0)}% used`,
  }))
  const last = recorded.at(-1)
  // The lines meet now: the last reading starts the projection.
  const joined: Array<TrendDatum> =
    last === undefined ? [] : [...recorded.slice(0, -1), { ...last, projected: last.recorded ?? 0 }]
  const projected: Array<TrendDatum> = trend.projected.slice(1).map((point) => ({
    t: ms(point.at),
    projected: point.used,
    tip: `${when(ms(point.at), zone)}\n~${fixed(point.used, 0)}% used, projected`,
  }))
  const data = [...joined, ...projected]
  const span = trend.span === "5h" ? 24 * hour : 7 * 24 * hour
  const from = Math.min(data[0]?.t ?? nowMs, nowMs - span / 6)
  const to = Math.max(data.at(-1)?.t ?? nowMs, nowMs + span / 12)
  const full = (id: string) => names.get(id) ?? id
  return {
    span: trend.span,
    title: spanTitle(trend.span),
    used: `${fixed(trend.used, 0)}%`,
    data,
    from,
    to,
    now: nowMs,
    ticks: timeTicks(from, to, zone),
    resets: trend.resets.map((reset) => ({
      t: ms(reset.at),
      tip: `${full(reset.account)} resets ${clock(reset.at, now, zone)}, giving back ${fixed(reset.givesBack, 0)}%`,
    })),
    figures: figures(trend, names, now, zone),
    recorded: trend.recorded.length > 2,
    dry: trend.runsOutAt !== undefined,
  }
}

/** The views of every trend, shortest window first. */
export const trendViews = (
  detail: PoolDetail,
  names: ReadonlyMap<string, string>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): ReadonlyArray<TrendView> => detail.trends.map((trend) => trendView(trend, names, now, zone))

// --- The resets ahead -------------------------------------------------------------------

/** How far ahead the reset lanes reach. */
export const laneDays = 7

/** A reset on an account's lane, placed as a fraction of the lanes' width. */
export interface LaneMark {
  readonly at: number
  /** 0 to 1 along the lane. */
  readonly offset: number
  readonly span: Span
  readonly tip: string
}

export interface Lane {
  readonly id: string
  readonly name: string
  readonly marks: ReadonlyArray<LaneMark>
}

export interface Lanes {
  readonly lanes: ReadonlyArray<Lane>
  /** Each local midnight within the lanes, with its weekday. */
  readonly days: ReadonlyArray<{ readonly offset: number; readonly label: string }>
  /** Resets within the first day, across every account. */
  readonly today: number
}

/**
 * Every account's resets over the next week on a lane of its own: each
 * window's next reset, and a weekly window's again a week later.
 */
export const lanes = (
  accounts: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly windows: ReadonlyArray<{
      readonly span: Span
      readonly model?: string
      readonly used: number
      readonly resetsAt?: DateTime.Utc
    }>
  }>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): Lanes => {
  const from = ms(now)
  const length = laneDays * 24 * hour
  const offset = (t: number) => (t - from) / length
  const all: Array<Lane> = accounts.map((account) => {
    const marks: Array<LaneMark> = []
    for (const window of account.windows) {
      if (window.model !== undefined || window.resetsAt === undefined) continue
      const first = ms(window.resetsAt)
      if (first <= from) continue
      const repeat = window.span === "7d" ? 7 * 24 * hour : window.span === "30d" ? 30 * 24 * hour : undefined
      const times = repeat === undefined ? [first] : [first, first + repeat]
      times.forEach((t, i) => {
        if (t > from + length) return
        const what = `${account.name}'s ${spanTitle(window.span).toLowerCase()} window`
        marks.push({
          at: t,
          offset: offset(t),
          span: window.span,
          tip:
            i === 0
              ? `${what} resets ${clock(at(t), now, zone)}, in ${until(at(t), now)}; ${fixed(window.used, 0)}% used`
              : `${what} resets again ${clock(at(t), now, zone)}`,
        })
      })
    }
    return { id: account.id, name: account.name, marks: marks.toSorted((a, b) => a.at - b.at) }
  })
  const days = timeTicks(from, from + length, zone)
    .map((t) => ({ offset: offset(t), label: tickLabel(t, "7d", zone) }))
    .filter((day) => day.offset > 0.02 && day.offset < 0.98)
  const today = all.flatMap((lane) => lane.marks).filter((mark) => mark.at - from <= 24 * hour).length
  return { lanes: all, days, today }
}

// --- Each account -----------------------------------------------------------------------

/** What a window has served, in a line and in full. */
export interface SpendView {
  /** `$412 so far`. */
  readonly line: string
  /** `$8.40 a percent`, once enough of the window is used. */
  readonly rate?: string
  readonly tip: string
}

export const spendView = (spend: WindowSpend): SpendView | undefined => {
  if (spend.requests === 0) return undefined
  const window = spanTitle(spend.span).toLowerCase()
  const worth = spend.perPercent === undefined ? undefined : spend.perPercent * 100
  return {
    line: `${dollars(spend.cost)} so far`,
    ...(spend.perPercent === undefined ? {} : { rate: `${dollars(spend.perPercent)} a percent` }),
    tip: [
      `This ${window} window has answered ${grouped(spend.requests)} requests, ${compact(spend.tokens)} tokens, worth ${dollars(spend.cost)} at API prices.`,
      worth === undefined ? undefined : `At that rate the whole window is worth about ${dollars(worth)}.`,
    ]
      .filter((line) => line !== undefined)
      .join(" "),
  }
}

/** A half hour of an account's requests, as a cell of its health strip. */
export interface HealthView {
  readonly tone: "none" | "good" | "warn" | "bad"
  readonly tip: string
}

export interface Health {
  readonly cells: ReadonlyArray<HealthView>
  /** `412 answered, 3 failed in the last day`. */
  readonly summary: string
  readonly failed: number
}

const cellTone = (cell: HealthCell): HealthView["tone"] => {
  const all = cell.answered + cell.failed
  if (all === 0) return "none"
  if (cell.failed === 0) return "good"
  return cell.failed / all >= 0.5 ? "bad" : "warn"
}

export const health = (
  account: AccountDetail,
  since: DateTime.Utc,
  minutes: number,
  zone: DateTime.TimeZone,
): Health => {
  const cells = account.health.map((cell, i): HealthView => {
    const start = DateTime.add(since, { minutes: i * minutes })
    const time = DateTime.formatIntl(start, formatIn(zone, "time"))
    const words =
      cell.answered + cell.failed === 0
        ? "no requests"
        : cell.failed === 0
          ? `${grouped(cell.answered)} answered`
          : `${grouped(cell.answered)} answered, ${grouped(cell.failed)} failed`
    return { tone: cellTone(cell), tip: `From ${time}: ${words}` }
  })
  const answered = account.health.reduce((sum, cell) => sum + cell.answered, 0)
  const failed = account.health.reduce((sum, cell) => sum + cell.failed, 0)
  return {
    cells,
    summary:
      answered + failed === 0
        ? "No requests in the last day"
        : failed === 0
          ? `${grouped(answered)} answered in the last day, none failed`
          : `${grouped(answered)} answered, ${grouped(failed)} failed in the last day`,
    failed,
  }
}
