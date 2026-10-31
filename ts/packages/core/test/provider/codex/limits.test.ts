import { describe, expect, it } from "bun:test"

import { Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import { Limits, type PoolWindow, Refusal } from "../../../src/limits.ts"
import {
  fromEvent,
  fromHeaders,
  fromUsage,
  poolEvent,
  poolHeaders,
  refusal,
} from "../../../src/provider/codex/limits.ts"

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const at = (value: json.Json, ...path: ReadonlyArray<string>): json.Json | undefined =>
  path.reduce<json.Json | undefined>((v, key) => json.get(v, key), value)

describe("provider/codex/limits", () => {
  it("pool_headers_and_events_describe_the_pool", () => {
    const pool: ReadonlyArray<PoolWindow> = [
      { span: "5h", used: 22.5, resetsAt: ts(4_000) },
      { span: "7d", used: 35.0, resetsAt: undefined },
    ]
    const h = new Headers({
      "x-codex-primary-used-percent": "95",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1234",
      "x-codex-secondary-used-percent": "70",
      "x-codex-credits-has-credits": "true",
    })
    poolHeaders(pool, h)
    const get = (name: string) => h.get(name) ?? undefined
    expect(get("x-codex-primary-used-percent")).toBe("22.5")
    expect(get("x-codex-primary-window-minutes")).toBe("300")
    expect(get("x-codex-primary-reset-at")).toBe("4000")
    expect(get("x-codex-secondary-used-percent")).toBe("35.0")
    expect(get("x-codex-secondary-window-minutes")).toBe("10080")
    expect(get("x-codex-secondary-reset-at")).toBeUndefined()
    expect(get("x-codex-credits-has-credits")).toBe("true")

    const event: json.Json = {
      type: "codex.rate_limits",
      plan_type: "pro",
      rate_limits: {
        allowed: true,
        limit_reached: true,
        primary: { used_percent: 100, window_minutes: 300, reset_at: 9 },
      },
    }
    poolEvent(pool, event)
    expect(json.f64(at(event, "rate_limits", "primary", "used_percent"))).toBe(22.5)
    expect(at(event, "rate_limits", "secondary", "window_minutes")).toBe(10080)
    expect(at(event, "rate_limits", "limit_reached")).toBe(false)
    expect(at(event, "plan_type")).toBe("pro")
  })

  it("websocket_rate_limit_events", () => {
    const event = {
      type: "codex.rate_limits",
      plan_type: "pro",
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 42, window_minutes: 300, reset_at: 9000 },
        secondary: { used_percent: 7, window_minutes: 10080, reset_at: 99000 },
      },
    }
    const limits = fromEvent(event, ts(1000))
    expect(limits?.windows.map((w) => [w.span, w.used])).toEqual([
      ["5h", 42.0],
      ["7d", 7.0],
    ])
    expect(limits?.windows[0]?.resetsAt).toBe(ts(9000))
    expect(fromEvent({ type: "codex.rate_limits", rate_limits: { primary: null } }, ts(0))).toBeUndefined()
  })

  it("codex_headers_classify_by_window_length", () => {
    const h = new Headers({
      "x-codex-primary-used-percent": "29",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "5000",
      "x-codex-secondary-used-percent": "100",
      "x-codex-secondary-window-minutes": "300",
    })
    const limits = fromHeaders(h, ts(1000))
    expect(limits?.windows[0]?.span).toBe("7d")
    expect(limits?.windows[1]?.span).toBe("5h")
    expect(limits !== undefined && Limits.isExhausted(limits, ts(1000))).toBe(true)
  })

  it("codex_usage_reads_windows_plan_and_reset_credits", () => {
    const body = {
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        primary_window: {
          used_percent: 29,
          limit_window_seconds: 604800,
          reset_after_seconds: 498039,
          reset_at: 1791580389,
        },
        secondary_window: null,
      },
      rate_limit_reset_credits: { available_count: 3 },
    }
    const [limits, plan] = fromUsage(body, ts(0))
    expect(plan).toBe("pro")
    expect(limits.windows.length).toBe(1)
    expect(limits.windows[0]?.span).toBe("7d")
    expect(limits.windows[0]?.resetsAt).toBe(ts(1791580389))
    expect(limits.resetCredits).toBe(3)
  })

  it("codex_usage_limit_uses_body_reset", () => {
    const body = bytes('{"error":{"type":"usage_limit_reached","message":"x","resets_at":4000,"plan_type":"pro"}}')
    expect(refusal(429, new Headers(), body, ts(1000))).toEqual(Refusal.Exhausted(ts(4000), undefined))
    const relative = bytes('{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}')
    expect(refusal(429, new Headers(), relative, ts(1000))).toEqual(Refusal.Exhausted(ts(1060), undefined))
  })

  it("codex_rate_limit_is_throttling", () => {
    const body = bytes('{"error":{"type":"rate_limit_exceeded"}}')
    expect(refusal(429, new Headers(), body, ts(0))._tag).toBe("Throttled")
  })
})

describe("provider/codex/limits, beyond the Rust tests", () => {
  it("events say a pool is spent, write floats as serde does, and empty slots are null", () => {
    const event: json.Json = { rate_limits: { primary: { used_percent: 1 } } }
    poolEvent([{ span: "5h", used: 100, resetsAt: undefined }], event)
    expect(JSON.stringify(event)).toBe(
      '{"rate_limits":{"primary":{"used_percent":100.0,"window_minutes":300,"reset_at":null},"secondary":null,"limit_reached":true,"allowed":false}}',
    )
    const untouched: json.Json = { rate_limits: null }
    poolEvent([], untouched)
    expect(untouched).toEqual({ rate_limits: null })
  })

  it("usage spans and seconds are integers, as as_i64 reads them", () => {
    // Read as serde_json reads it, `2592000.0` is a float that `as_i64` refuses.
    const body = json.parse(
      '{"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":2592000.0,"reset_after_seconds":10.0}}}',
    )
    const [floats] = fromUsage(body ?? null, ts(1000))
    expect(floats.windows[0]?.span).toBe("7d")
    expect(floats.windows[0]?.resetsAt).toBeUndefined()
    // An object that happens to have a `rawJSON` key is not a number.
    const [object] = fromUsage(
      { rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: { rawJSON: "60" } } } },
      ts(1000),
    )
    expect(object.windows[0]?.resetsAt).toBeUndefined()
  })

  it("usage resets fall back to the seconds left, and 402s and past resets read the headers", () => {
    const [limits] = fromUsage(
      { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 60 } } },
      ts(1000),
    )
    expect(limits.windows[0]?.span).toBe("5h")
    expect(limits.windows[0]?.resetsAt).toBe(ts(1060))
    expect(limits.resetCredits).toBeUndefined()
    const spent = new Headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": "4000" })
    expect(refusal(402, spent, bytes("{}"), ts(1000))).toEqual(Refusal.Exhausted(ts(4000), undefined))
    const past = bytes('{"error":{"code":"insufficient_quota","resets_at":"1970-01-01T00:00:10Z"}}')
    expect(refusal(429, new Headers({ "retry-after": "5" }), past, ts(1000))).toEqual(
      Refusal.Exhausted(ts(1005), undefined),
    )
  })
})
