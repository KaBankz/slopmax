// Usage windows: the one model every provider's rate-limit headers and usage
// endpoints are read into. Percent used, and when each window resets, drive
// placement, the status report and the nudges. Everything here is pure and
// takes `now` as an argument.
import { DateTime, Option, Schema } from "effect"
import { Instant, Span } from "./ids.ts"

/** Values built from parts already checked skip the schema's checks: readings are made on every answer. */
const unchecked = { disableChecks: true } as const

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
    // Clamped here, so the schema's own range check has nothing left to catch.
    const clamped = Math.min(100, Math.max(0, Number.isFinite(used) ? used : 0))
    // Every answer's headers carry a reading, and most repeat the last one, so
    // the same window is handed out again rather than built anew: windows are
    // values, never changed once made.
    const key = `${span} ${clamped} ${resetsAt === undefined ? "" : resetsAt.epochMilliseconds} ${model ?? ""}`
    const known = recentWindows.get(key)
    if (known !== undefined) return known
    const window = new Window(
      {
        span,
        used: clamped,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(model === undefined ? {} : { model }),
      },
      unchecked,
    )
    if (recentWindows.size >= recentLimit) recentWindows.clear()
    recentWindows.set(key, window)
    return window
  }
}

/** Windows read lately, by what they read; a few accounts' windows at a time, so a small table holds them. */
const recentWindows = new Map<string, Window>()
const recentLimit = 256

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

/** The window's length in minutes, as Codex states it. */
export const spanMinutes = (span: Span): number => (span === "5h" ? 300 : span === "30d" ? 43_200 : 10_080)

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
