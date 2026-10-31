// Claude's usage windows: response headers, the usage endpoint, and 429s.
import { fmt, Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import {
  header,
  headerF64,
  headerTime,
  Limits,
  parseTime,
  type PoolWindow,
  Refusal,
  retryAfter,
  Window,
} from "../../limits.ts"
import { insert } from "../../proxy/headers.ts"

const UNIFIED = "anthropic-ratelimit-unified-"

/**
 * Claude: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`.
 * Utilization is a 0–1 fraction; resets are unix seconds.
 */
export const fromHeaders = (headers: Headers, now: Timestamp): Limits | undefined => {
  const windows: Array<Window> = []
  for (const key of ["5h", "7d"]) {
    const fraction = headerF64(headers, `anthropic-ratelimit-unified-${key}-utilization`)
    if (fraction === undefined) continue
    const reset = headerTime(headers, `anthropic-ratelimit-unified-${key}-reset`)
    windows.push(Window.make(key, fraction * 100.0, reset))
  }
  return Limits.observed(windows, now)
}

/**
 * Puts the pool's standing in place of the serving account's, so the agent
 * sees one account. This follows Claude Code's contract for gateways:
 * strip the upstream's `anthropic-ratelimit-unified-*` headers and report
 * the caller's own standing, warning past 75% and again past 95%.
 */
export const poolHeaders = (windows: ReadonlyArray<PoolWindow>, headers: Headers): void => {
  const upstream = [...headers.keys()].filter((name) => name.startsWith(UNIFIED))
  for (const name of upstream) headers.delete(name)
  const set = (name: string, value: string): void => insert(headers, name, value)
  let fullest: readonly [PoolWindow, string] | undefined
  for (const window of windows) {
    let key: string
    let claim: string
    if (window.span === "5h") [key, claim] = ["5h", "five_hour"]
    else if (window.span === "7d") [key, claim] = ["7d", "seven_day"]
    else continue
    // Below 1 while requests are still served.
    const fraction = Math.min(0.99, Math.max(0.0, window.used / 100.0))
    const passed = [0.95, 0.75].find((t) => fraction >= t)
    set(`${UNIFIED}${key}-utilization`, fmt.fixed(fraction, 2))
    set(`${UNIFIED}${key}-status`, passed !== undefined ? "allowed_warning" : "allowed")
    if (window.resetsAt !== undefined) set(`${UNIFIED}${key}-reset`, String(Timestamp.asSecond(window.resetsAt)))
    if (passed !== undefined) set(`${UNIFIED}${key}-surpassed-threshold`, fmt.display(passed))
    if (fullest === undefined || window.used > fullest[0].used) fullest = [window, claim]
  }
  if (fullest === undefined) return
  const [window, claim] = fullest
  const warning = window.used >= 75.0
  set(`${UNIFIED}status`, warning ? "allowed_warning" : "allowed")
  if (warning) set(`${UNIFIED}representative-claim`, claim)
  if (window.resetsAt !== undefined) set(`${UNIFIED}reset`, String(Timestamp.asSecond(window.resetsAt)))
}

/**
 * Claude `GET /api/oauth/usage`: `five_hour`, `seven_day`, and model-scoped
 * weekly limits, with utilization in percent and ISO reset times.
 */
export const fromUsage = (body: json.Json, now: Timestamp): Limits => {
  const window = (key: string, span: string): Window | undefined => {
    const w = json.get(body, key)
    const used = json.f64(json.get(w, "utilization"))
    if (used === undefined) return undefined
    return Window.make(span, used, parseTime(json.get(w, "resets_at")))
  }
  const windows: Array<Window> = []
  for (const w of [window("five_hour", "5h"), window("seven_day", "7d")]) if (w !== undefined) windows.push(w)

  const scoped = (json.array(json.get(body, "limits")) ?? []).filter(
    (l) => json.str(json.get(l, "kind")) === "weekly_scoped",
  )
  for (const limit of scoped) {
    const model = json.str(json.get(json.get(json.get(limit, "scope"), "model"), "display_name"))
    const used = json.f64(json.get(limit, "percent"))
    if (model !== undefined && used !== undefined) {
      const reset = parseTime(json.get(limit, "resets_at"))
      windows.push({ ...Window.make("7d", used, reset), model })
    }
  }
  // Older payloads carry per-model weekly windows as top-level keys.
  for (const [key, model] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ] as const) {
    if (windows.some((w) => w.model === model)) continue
    const w = window(key, "7d")
    if (w !== undefined) windows.push({ ...w, model })
  }
  return { windows, observedAt: now }
}

const decoder = new TextDecoder()

/**
 * Whether a 429 refuses fast mode for want of usage credits rather than
 * for a spent window. That belongs to the request: every account would
 * answer the same, and all of them stay healthy for ordinary requests.
 */
export const fastModeRefused = (headers: Headers, body: Uint8Array): boolean => {
  const windowRejected = ["5h-", "7d-"].some(
    (key) => header(headers, `anthropic-ratelimit-unified-${key}status`) === "rejected",
  )
  if (windowRejected) return false
  const parsed = json.parse(body)
  const fromError = parsed === undefined ? undefined : json.str(json.get(json.get(parsed, "error"), "message"))
  const message = (fromError ?? decoder.decode(body)).toLowerCase()
  return (
    message.includes("fast request rejected") ||
    (message.includes("fast") && (message.includes("usage credits") || message.includes("credits are required")))
  )
}

const latest = (times: ReadonlyArray<Timestamp | undefined>, now: Timestamp): Timestamp | undefined => {
  let best: Timestamp | undefined
  for (const at of times) if (at !== undefined && at > now && (best === undefined || at > best)) best = at
  return best
}

/**
 * Classifies a Claude 429 from its unified rate-limit headers.
 *
 * A rejected 5h or 7d window blocks the whole account until the latest of
 * the rejected resets. A rejection that only involves the overage-included
 * window (`7d_oi`) or extra usage caps one model, not the account.
 */
export const refusal = (headers: Headers, model: string | undefined, now: Timestamp): Refusal => {
  const status = (key: string) => header(headers, `anthropic-ratelimit-unified-${key}status`)
  const rejected = (key: string) => status(key) === "rejected"
  const reset = (key: string) => headerTime(headers, `anthropic-ratelimit-unified-${key}reset`)

  const shared = ["5h-", "7d-"].filter(rejected)
  if (shared.length > 0) {
    const until = latest([...shared.map(reset), retryAfter(headers, now), reset("")], now)
    return Refusal.Exhausted(until, undefined)
  }
  if (rejected("")) {
    const overageOnly =
      rejected("7d_oi-") ||
      status("overage-") === "rejected" ||
      (header(headers, "anthropic-ratelimit-unified-representative-claim")?.includes("overage") ?? false)
    const until = latest([reset("7d_oi-"), reset(""), retryAfter(headers, now)], now)
    return Refusal.Exhausted(until, overageOnly ? model : undefined)
  }
  return Refusal.Throttled(retryAfter(headers, now))
}
