// The arithmetic behind the hand-drawn charts: round value axes, how often a
// bucket is labeled, the cache and first-byte axes, and the words of every
// axis label and tooltip. The SVG itself is in components/charts.tsx.
import type { History, HistoryBucket, HistoryRange } from "@slopmax/client"
import { compact, fixed, grouped, providerTitle } from "@slopmax/client/format"
import { count, dollars } from "./words.ts"

/** A point on a figure's trend line: its bucket's label, its tooltip, and its value, if it has one. */
export interface SparkPoint {
  readonly label: string
  readonly tip: string
  readonly value: number | undefined
}

/** A value axis: from `bottom` to `top`, with `ticks` evenly spaced lines including both ends. */
export interface Axis {
  readonly bottom: number
  readonly top: number
  readonly ticks: number
}

/**
 * The lowest round top for values up to `most`, and how many ticks reach
 * it: three to five even steps of 1, 2, 2.5 or 5 times a power of ten,
 * whichever ends lowest, none finer than `finest`. Steps of whole counts
 * stay whole.
 */
export const axis = (most: number, finest: number): { readonly top: number; readonly ticks: number } => {
  let best: { top: number; ticks: number } | undefined
  for (const steps of [3, 4, 5]) {
    const least = Math.max(most / steps, finest)
    const power = 10 ** Math.floor(Math.log10(least))
    const step =
      [1, 2, 2.5, 5]
        .map((m) => m * power)
        .find((s) => s >= least * (1 - 1e-9) && (finest < 1 || Number.isInteger(s))) ?? 10 * power
    const top = step * steps
    if (best === undefined || top < best.top) best = { top, ticks: steps + 1 }
  }
  return best ?? { top: 1, ticks: 2 }
}

/** The decimal places that tell ticks `step` apart: none for whole steps. */
export const places = (step: number): number => {
  for (const p of [0, 1]) {
    const scaled = step * 10 ** p
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return p
  }
  return 2
}

/** An axis from zero for values up to `most`. */
export const zeroAxis = (most: number, finest: number): Axis => ({ bottom: 0, ...axis(most, finest) })

/**
 * The cache axis, in percent: it ends at 100 and starts at 100 less the
 * smallest of 10, 20, 50 or 100 that keeps the lowest value inside, so a
 * cache that reads well stays readable.
 */
export const cacheAxis = (values: ReadonlyArray<number>): Axis => {
  const lowest = values.length === 0 ? 100 : Math.min(...values)
  const span = [10, 20, 50, 100].find((s) => 100 - s <= lowest - 1) ?? 100
  return { bottom: 100 - span, top: 100, ticks: 3 }
}

/** The values of an axis's ticks, bottom first. */
export const tickValues = (scale: Axis): ReadonlyArray<number> =>
  Array.from({ length: scale.ticks }, (_, i) => scale.bottom + ((scale.top - scale.bottom) * i) / (scale.ticks - 1))

/** Every how-many-th bucket is named beneath a chart, so labels never crowd. */
export const labelEvery = (range: HistoryRange): number => (range === "today" ? 3 : range === "7d" ? 1 : 5)

/** Token counts on an axis: compact, without a trailing `.0`. */
export const tokensTick = (value: number): string => compact(value).replace(".0", "")

/** Counts on an axis. */
export const countTick = (value: number): string => grouped(value)

/** Dollars on an axis: `$5` when whole, else `$2.50`. */
export const moneyTick = (value: number): string =>
  Number.isInteger(value) ? `$${grouped(value)}` : `$${fixed(value, 2)}`

/** A share on an axis: `90%`. */
export const percentTick = (value: number): string => `${fixed(value, 0)}%`

/** Seconds on an axis, with the places its step needs: `0.5 s`. */
export const secondsTick =
  (step: number) =>
  (value: number): string =>
    `${fixed(value, places(step))} s`

/** A bucket's token counts per provider and in all, for the tokens chart's tooltip. */
export const tokensTip = (history: Pick<History, "providers">, bucket: HistoryBucket): string =>
  [
    bucket.label,
    ...history.providers.map((provider, i) => `${providerTitle(provider)}: ${compact(bucket.tokens[i] ?? 0)}`),
    `Total: ${compact(bucket.tokens.reduce((sum, n) => sum + n, 0))}`,
  ].join("\n")

export const requestsTip = (bucket: HistoryBucket): string =>
  [
    bucket.label,
    count(bucket.requests, "request"),
    ...(bucket.failed > 0 ? [`${grouped(bucket.failed)} failed`] : []),
  ].join("\n")

export const costTip = (bucket: HistoryBucket): string => `${bucket.label}\n${dollars(bucket.cost)} at API prices`

export const reliabilityTip = (bucket: HistoryBucket): string =>
  `${bucket.label}\n${grouped(bucket.rescued)} saved by failover\n${grouped(bucket.failed)} failed`

export const cacheTip = (bucket: HistoryBucket): string =>
  bucket.cached === undefined
    ? `${bucket.label}\nNo input`
    : `${bucket.label}\n${fixed(bucket.cached * 100, 0)}% from cache`

export const firstByteTip = (bucket: HistoryBucket): string =>
  bucket.firstByte === undefined
    ? `${bucket.label}\nNo answers`
    : `${bucket.label}\nMedian ${fixed(bucket.firstByte[0] / 1000, 2)} s\nSlowest 5% ${fixed(bucket.firstByte[1] / 1000, 2)} s`

/** A cell's level in the "When you work" grid: 0 for none, else 1 to 4. */
export type Level = 0 | 1 | 2 | 3 | 4

/**
 * The "When you work" grid's levels, as a contribution graph has them: 0
 * for an hour with no request, else 1 to 4 by where the hour ranks among
 * the busy ones, so a single burst does not wash every other hour out.
 * The busiest hours are 4; hours alike share a level.
 */
export const levels = (activity: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<ReadonlyArray<Level>> => {
  // Ranked among the distinct counts, so many quiet hours alike can't share the peak's level.
  const busy = [...new Set(activity.flat().filter((n) => n > 0))]
  const level = (n: number): Level => {
    if (n <= 0) return 0
    const atMost = busy.filter((v) => v <= n).length
    const step = Math.max(1, Math.min(4, Math.ceil((4 * atMost) / busy.length)))
    return step === 1 ? 1 : step === 2 ? 2 : step === 3 ? 3 : 4
  }
  return activity.map((hours) => hours.map(level))
}

/** The levels beside the grid, from least to most. */
export const levelScale: ReadonlyArray<Level> = [0, 1, 2, 3, 4]

export const weekdays: ReadonlyArray<string> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const weekdayNames: ReadonlyArray<string> = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]

/** The parts of a day, six hours each, for when most of the work falls. */
const dayParts: ReadonlyArray<string> = ["Nights", "Mornings", "Afternoons", "Evenings"]

/** A fact beside the grid: what it is, its figure, and a line under it. */
export interface RhythmFact {
  readonly title: string
  readonly value: string
  readonly note: string
}

const share = (part: number, whole: number): string => `${fixed(whole === 0 ? 0 : (part / whole) * 100, 0)}%`

/**
 * What the grid says in words: the busiest hour, the busiest day, the part
 * of the day most requests fall in, and the weekends' share. None when no
 * request was made.
 */
export const rhythm = (activity: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<RhythmFact> => {
  const total = activity.flat().reduce((sum, n) => sum + n, 0)
  if (total === 0) return []
  let hour = { day: 0, hour: 0, n: -1 }
  activity.forEach((hours, day) =>
    hours.forEach((n, h) => {
      if (n > hour.n) hour = { day, hour: h, n }
    }),
  )
  const days = activity.map((hours) => hours.reduce((sum, n) => sum + n, 0))
  const day = days.reduce((best, n, i) => ((days[best] ?? 0) >= n ? best : i), 0)
  const parts = dayParts.map((_, part) =>
    activity.reduce((sum, hours) => sum + hours.slice(part * 6, part * 6 + 6).reduce((s, n) => s + n, 0), 0),
  )
  const part = parts.reduce((best, n, i) => ((parts[best] ?? 0) >= n ? best : i), 0)
  const weekend = (days[5] ?? 0) + (days[6] ?? 0)
  return [
    {
      title: "Busiest hour",
      value: `${weekdays[hour.day] ?? ""} ${String(hour.hour).padStart(2, "0")}:00`,
      note: count(hour.n, "request"),
    },
    { title: "Busiest day", value: weekdayNames[day] ?? "", note: `${share(days[day] ?? 0, total)} of requests` },
    { title: "Most active", value: dayParts[part] ?? "", note: `${share(parts[part] ?? 0, total)} of requests` },
    { title: "Weekends", value: share(weekend, total), note: "of requests" },
  ]
}

/** A cell's tooltip: `Tue 14:00 | 12 requests`. */
export const activityTip = (day: number, hour: number, n: number): string =>
  `${weekdays[day] ?? ""} ${String(hour).padStart(2, "0")}:00 | ${count(n, "request")}`
