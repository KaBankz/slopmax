// ChatGPT's usage windows: response headers, the usage endpoint, and
// refusals.
import { fmt, num, SignedDuration, Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import {
  headerF64,
  headerTime,
  Limits,
  parseTime,
  PoolWindow,
  Refusal,
  retryAfter,
  spanFor,
  Window,
} from "../../limits.ts"
import { insert } from "../../proxy/headers.ts"
import { i64 } from "../../serde.ts"

/** `as i64` on a finite `f64`: toward zero, saturating. */
const asI64 = (x: number): number => Math.trunc(Math.max(-9.3e18, Math.min(9.3e18, x)))

/** Codex: `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`. */
export const fromHeaders = (headers: Headers, now: Timestamp): Limits | undefined => {
  const windows: Array<Window> = []
  for (const slot of ["primary", "secondary"]) {
    const used = headerF64(headers, `x-codex-${slot}-used-percent`)
    if (used === undefined) continue
    const minutes = headerF64(headers, `x-codex-${slot}-window-minutes`)
    const reset = headerTime(headers, `x-codex-${slot}-reset-at`)
    const span = minutes === undefined ? "7d" : spanFor(asI64(minutes * 60.0))
    windows.push(Window.make(span, used, reset))
  }
  return Limits.observed(windows, now)
}

const POOL_FIELDS = [
  "used-percent",
  "window-minutes",
  "reset-at",
  "reset-after-seconds",
  "over-secondary-limit-percent",
] as const

/**
 * Puts the pool's standing in place of the serving account's in
 * `x-codex-{primary,secondary}-*`, shortest window first, so Codex's limit
 * display and warnings describe the pool as one account.
 */
export const poolHeaders = (windows: ReadonlyArray<PoolWindow>, headers: Headers): void => {
  let next = 0
  for (const slot of ["primary", "secondary"]) {
    for (const field of POOL_FIELDS) headers.delete(`x-codex-${slot}-${field}`)
    const window = windows[next++]
    if (window === undefined) continue
    const set = (field: string, value: string): void => insert(headers, `x-codex-${slot}-${field}`, value)
    set("used-percent", fmt.fixed(window.used, 1))
    set("window-minutes", String(PoolWindow.minutes(window)))
    if (window.resetsAt !== undefined) set("reset-at", String(Timestamp.asSecond(window.resetsAt)))
  }
}

/** The same for a `codex.rate_limits` socket event. */
export const poolEvent = (windows: ReadonlyArray<PoolWindow>, event: json.Json): void => {
  const limits = json.get(event, "rate_limits")
  if (!json.isObject(limits)) return
  let next = 0
  for (const slot of ["primary", "secondary"]) {
    const w = windows[next++]
    limits[slot] =
      w === undefined
        ? null
        : {
            used_percent: json.f64Value(num.round(w.used * 10.0) / 10.0),
            window_minutes: PoolWindow.minutes(w),
            reset_at: w.resetsAt === undefined ? null : Timestamp.asSecond(w.resetsAt),
          }
  }
  const full = windows.some((w) => w.used >= 100.0)
  limits.limit_reached = full
  limits.allowed = !full
}

/**
 * A `codex.rate_limits` event, which ChatGPT sends over WebSockets in
 * place of the rate-limit headers.
 */
export const fromEvent = (event: json.Json, now: Timestamp): Limits | undefined => {
  const limits = json.get(event, "rate_limits")
  if (limits === undefined) return undefined
  const windows: Array<Window> = []
  for (const slot of ["primary", "secondary"]) {
    const w = json.get(limits, slot)
    if (!json.isObject(w)) continue
    const used = json.f64(json.get(w, "used_percent"))
    if (used === undefined) continue
    const minutes = json.f64(json.get(w, "window_minutes"))
    const reset = parseTime(json.get(w, "reset_at"))
    const span = minutes === undefined ? "7d" : spanFor(asI64(minutes * 60.0))
    windows.push(Window.make(span, used, reset))
  }
  return Limits.observed(windows, now)
}

/** Codex `GET /backend-api/wham/usage`. Returns the limits and the plan. */
export const fromUsage = (body: json.Json, now: Timestamp): readonly [Limits, string | undefined] => {
  const rateLimit = json.get(body, "rate_limit")
  const windows: Array<Window> = []
  for (const key of ["primary_window", "secondary_window", "tertiary_window"]) {
    if (rateLimit === undefined) break
    const w = json.get(rateLimit, key)
    if (w === undefined) continue
    const used = json.f64(json.get(w, "used_percent"))
    if (used === undefined) continue
    const seconds = i64(json.get(w, "limit_window_seconds"))
    let reset = parseTime(json.get(w, "reset_at"))
    if (reset === undefined) {
      const after = i64(json.get(w, "reset_after_seconds"))
      if (after !== undefined) reset = Timestamp.add(now, SignedDuration.fromSecs(after))
    }
    windows.push(Window.make(seconds === undefined ? "7d" : spanFor(seconds), used, reset))
  }
  const available = json.u64(json.get(json.get(body, "rate_limit_reset_credits"), "available_count"))
  // `n as u32` keeps the low 32 bits.
  const resetCredits = available === undefined ? undefined : Number(BigInt.asUintN(32, BigInt(available)))
  const plan = json.str(json.get(body, "plan_type"))
  const limits: Limits = { windows, observedAt: now, ...(resetCredits === undefined ? {} : { resetCredits }) }
  return [limits, plan]
}

const EXHAUSTED_KINDS = ["usage_limit_reached", "usage_limit_exceeded", "usage_not_included", "insufficient_quota"]

/**
 * Classifies a Codex 429/402. `usage_limit_reached` means the account is
 * spent; its body carries `resets_at` (unix seconds) or `resets_in_seconds`.
 */
export const refusal = (status: number, headers: Headers, body: Uint8Array, now: Timestamp): Refusal => {
  const value = json.parse(body) ?? null
  const error = json.or(json.get(value, "error"), value) ?? null
  const kind = json.str(json.get(error, "type")) ?? json.str(json.get(error, "code")) ?? ""

  const exhausted = status === 402 || EXHAUSTED_KINDS.includes(kind)
  if (!exhausted) return Refusal.Throttled(retryAfter(headers, now))
  let fromBody = parseTime(json.get(error, "resets_at"))
  if (fromBody === undefined) {
    const secs = i64(json.get(error, "resets_in_seconds"))
    if (secs !== undefined) fromBody = Timestamp.add(now, SignedDuration.fromSecs(secs))
  }
  if (fromBody !== undefined && fromBody > now) return Refusal.Exhausted(fromBody, undefined)
  const read = fromHeaders(headers, now)
  const until = (read === undefined ? undefined : Limits.exhaustedUntil(read, now)) ?? retryAfter(headers, now)
  return Refusal.Exhausted(until, undefined)
}
