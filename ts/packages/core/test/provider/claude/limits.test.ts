import { describe, expect, it } from "bun:test"

import { Timestamp } from "@slopmax/common"

import { Limits, type PoolWindow, Refusal, Window } from "../../../src/limits.ts"
import { fastModeRefused, fromHeaders, fromUsage, poolHeaders, refusal } from "../../../src/provider/claude/limits.ts"

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

const parse = (text: string): Timestamp => {
  const parsed = Timestamp.parse(text)
  if (parsed._tag === "Failure") throw new Error(text)
  return parsed.success
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe("provider/claude/limits", () => {
  it("pool_headers_replace_the_accounts", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-5h-utilization": "0.97",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "request-id": "req_1",
    })
    const reset = ts(5_000)
    const pool: ReadonlyArray<PoolWindow> = [
      { span: "5h", used: 48.5, resetsAt: reset },
      { span: "7d", used: 30.0, resetsAt: undefined },
    ]
    poolHeaders(pool, headers)
    const get = (name: string) => headers.get(name) ?? undefined
    expect(get("anthropic-ratelimit-unified-status")).toBe("allowed")
    expect(get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.48")
    expect(get("anthropic-ratelimit-unified-5h-reset")).toBe("5000")
    expect(get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.30")
    expect(get("anthropic-ratelimit-unified-reset")).toBe("5000")
    expect(get("anthropic-ratelimit-unified-representative-claim")).toBeUndefined()
    expect(get("anthropic-ratelimit-unified-overage-status")).toBeUndefined()
    expect(get("request-id")).toBe("req_1")

    // A pool running low warns as one account would.
    poolHeaders([{ span: "7d", used: 96.0, resetsAt: reset }], headers)
    expect(get("anthropic-ratelimit-unified-status")).toBe("allowed_warning")
    expect(get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day")
    expect(get("anthropic-ratelimit-unified-7d-surpassed-threshold")).toBe("0.95")
    expect(get("anthropic-ratelimit-unified-5h-utilization")).toBeUndefined()
  })

  it("claude_headers_convert_fractions_to_percent", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.53",
      "anthropic-ratelimit-unified-5h-reset": "2000",
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
    })
    const limits = fromHeaders(h, ts(1000))
    expect(limits?.windows[0]?.span).toBe("5h")
    expect(Math.abs((limits?.windows[0]?.used ?? 0) - 53.0)).toBeLessThan(1e-9)
    expect(limits?.windows[0]?.resetsAt).toBe(ts(2000))
    expect(limits?.windows[1]?.resetsAt).toBeUndefined()
    expect(fromHeaders(new Headers(), ts(0))).toBeUndefined()
  })

  it("claude_usage_reads_shared_and_scoped_windows", () => {
    const body = {
      five_hour: { utilization: 33.0, resets_at: "2026-10-04T07:20:00.250378+00:00" },
      seven_day: { utilization: 47.0, resets_at: "2026-10-05T04:00:00+00:00" },
      seven_day_opus: null,
      limits: [
        { kind: "session", percent: 33 },
        {
          kind: "weekly_scoped",
          percent: 58,
          resets_at: "2026-10-05T04:00:00+00:00",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    }
    const limits = fromUsage(body, ts(0))
    expect(limits.windows.map(Window.label)).toEqual(["5h", "7d", "7d Fable"])
    // Scoped windows do not drive the score.
    expect(Limits.score(limits, ts(0))).toBe(47.0)
  })

  it("claude_refusal_blocks_until_latest_rejected_reset", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": "3000",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-reset": "9000",
      "retry-after": "60",
    })
    expect(refusal(h, "claude-x", ts(1000))).toEqual(Refusal.Exhausted(ts(3000), undefined))
  })

  it("claude_overage_only_refusal_scopes_to_model", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-status": "rejected",
      "anthropic-ratelimit-unified-7d_oi-reset": "7000",
    })
    expect(refusal(h, "claude-fable-5", ts(1000))).toEqual(Refusal.Exhausted(ts(7000), "claude-fable-5"))
  })

  it("fast_mode_credit_refusals_are_told_apart", () => {
    const body = bytes(
      '{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}',
    )
    expect(fastModeRefused(new Headers(), body)).toBe(true)
    const spent = new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected" })
    // A spent window comes first.
    expect(fastModeRefused(spent, body)).toBe(false)
    const limit = bytes('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}')
    expect(fastModeRefused(new Headers(), limit)).toBe(false)
  })

  it("claude_plain_429_is_throttling", () => {
    expect(refusal(new Headers({ "retry-after": "5" }), undefined, ts(1000))).toEqual(Refusal.Throttled(ts(1005)))
  })
})

describe("provider/claude/limits, beyond the Rust tests", () => {
  it("unified rejections without overage block the account, and past resets are dropped", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "500",
    })
    expect(refusal(h, "claude-x", ts(1000))).toEqual(Refusal.Exhausted(undefined, undefined))
    h.set("anthropic-ratelimit-unified-representative-claim", "seven_day_overage")
    h.set("anthropic-ratelimit-unified-reset", "4000")
    expect(refusal(h, "claude-x", ts(1000))).toEqual(Refusal.Exhausted(ts(4000), "claude-x"))
  })

  it("legacy per-model windows give way to scoped ones and fast mode reads plain bodies", () => {
    const body = {
      seven_day_opus: { utilization: 10 },
      seven_day_sonnet: { utilization: 20, resets_at: 2000 },
      limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Opus" } } }],
    }
    const limits = fromUsage(body, parse("2026-10-01T00:00:00Z"))
    expect(limits.windows.map((w) => [Window.label(w), w.used, w.resetsAt])).toEqual([
      ["7d Opus", 5, undefined],
      ["7d Sonnet", 20, ts(2000)],
    ])
    expect(fastModeRefused(new Headers(), bytes("Fast Request Rejected"))).toBe(true)
    // Utilization stays below 1 while requests are still served.
    const headers = new Headers()
    poolHeaders([{ span: "5h", used: 120, resetsAt: undefined }], headers)
    expect(headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.99")
    expect(headers.get("anthropic-ratelimit-unified-5h-surpassed-threshold")).toBe("0.95")
  })
})
