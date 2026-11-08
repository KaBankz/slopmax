import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Duration, Option } from "effect"
import { Notice, NoticeKind, PoolView, PoolWindow, Report, Window } from "../src/index.ts"
import {
  agentTitle,
  ago,
  clock,
  compact,
  day,
  duration,
  fixed,
  grouped,
  menuBar,
  money,
  noticeBody,
  noticeTitle,
  pace,
  percent,
  providerTitle,
  until,
} from "../src/format.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const utc = DateTime.zoneMakeOffset(0)
const plusTwo = DateTime.zoneMakeOffset(2 * 3_600_000)

describe("durations", () => {
  it("use their two largest units", () => {
    expect(duration(Duration.seconds(42))).toBe("42s")
    expect(duration(Duration.seconds(9 * 60 + 30))).toBe("9m30s")
    expect(duration(Duration.seconds(2 * 3600 + 5 * 60 + 59))).toBe("2h05m")
    expect(duration(Duration.seconds(3 * 86_400 + 4 * 3600 + 120))).toBe("3d4h")
    expect(duration(Duration.seconds(-5))).toBe("0s")
    expect(duration(Duration.millis(1_999))).toBe("1s")
  })

  it("count down to a moment, and say now once it has passed", () => {
    expect(until(ts(900), ts(1_000))).toBe("now")
    expect(until(ts(1_000), ts(1_000))).toBe("now")
    expect(until(ts(1_090), ts(1_000))).toBe("1m30s")
  })
})

describe("numbers", () => {
  it("keep counts to about three figures", () => {
    expect(compact(999)).toBe("999")
    expect(compact(12_345)).toBe("12.3k")
    expect(compact(1_234_567)).toBe("1.2M")
    expect(compact(5_000_000_000)).toBe("5.0B")
  })

  it("round ties to even, so a percent never jumps a point on a tie", () => {
    expect(fixed(2.5, 0)).toBe("2")
    expect(fixed(3.5, 0)).toBe("4")
    expect(fixed(0.125, 2)).toBe("0.12")
    expect(percent(42.5)).toBe("42%")
    expect(percent(99.6)).toBe("100%")
    expect(money(12.5)).toBe("$12.50")
    expect(money(0)).toBe("$0.00")
    expect(grouped(1_234_567)).toBe("1,234,567")
  })
})

describe("times of day", () => {
  it("show the clock today, the weekday this week, and the date after that, in the zone given", () => {
    // 1970-01-01 was a Thursday; 10:00 UTC is 12:00 at +02:00.
    const now = ts(10 * 3600)
    expect(clock(ts(10 * 3600 + 3_540), now, utc)).toBe("10:59")
    expect(clock(ts(10 * 3600 + 3_540), now, plusTwo)).toBe("12:59")
    expect(clock(ts(86_400 + 20 * 3600 + 27 * 60), now, utc)).toBe("Fri 20:27")
    // Late on the first day in UTC is already the next day at +02:00.
    expect(clock(ts(23 * 3600), now, plusTwo)).toBe("Fri 01:00")
    expect(clock(ts(9 * 86_400), now, utc)).toBe("Jan 10")
  })

  it("name the day something happened: today, yesterday, or its date", () => {
    const now = ts(10 * 86_400 + 3600)
    expect(day(ts(10 * 86_400), now, utc)).toBe("today")
    expect(day(ts(9 * 86_400 + 60), now, utc)).toBe("yesterday")
    expect(day(ts(3 * 86_400), now, utc)).toBe("Jan 4")
    // At +02:00, 23:30 UTC the day before is already today.
    expect(day(ts(10 * 86_400 - 1_800), now, plusTwo)).toBe("today")
  })

  it("say coarsely how long ago an account was used", () => {
    const now = ts(100_000)
    expect(ago(ts(99_990), now)).toBe("used just now")
    expect(ago(ts(100_000 - 180), now)).toBe("used 3m ago")
    expect(ago(ts(100_000 - 7_200), now)).toBe("used 2h ago")
    expect(ago(ts(100_000 - 4 * 86_400), now)).toBe("used 4d ago")
    expect(ago(ts(100_010), now)).toBe("used just now")
  })
})

describe("pace", () => {
  it("compares a window's use with spending it evenly until it resets", () => {
    const length = 5 * 3600
    const start = 1_000_000
    // Half the window has passed.
    const now = ts(start + length / 2)
    const resets = ts(start + length)
    const text = (used: number) => Option.map(pace(Window.of("5h", used, resets), now, utc), (p) => p.text)
    expect(text(52)).toEqual(Option.some("On pace"))
    expect(text(30)).toEqual(Option.some("20% in reserve"))
    // At 75% used halfway, the same rate fills the window in another 50 minutes.
    expect(text(75)).toEqual(Option.some(`Runs out ~${clock(ts(start + length / 2 + 3_000), now, utc)}`))
    expect(Option.map(pace(Window.of("5h", 75, resets), now, utc), (p) => p.tone)).toEqual(Option.some("warn"))
    // Too soon to say, already spent, or without a reset: nothing.
    expect(pace(Window.of("5h", 10, ts(start + length)), ts(start + 60), utc)).toEqual(Option.none())
    expect(text(100)).toEqual(Option.none())
    expect(pace(Window.of("5h", 50), now, utc)).toEqual(Option.none())
  })
})

const pool = (provider: "claude" | "codex", windows: ReadonlyArray<PoolWindow>) =>
  new PoolView({ provider, accounts: 1, windows, scoped: [], shares: {} })

describe("the menu bar", () => {
  it("shows each pool's 5-hour use, a dash without one, and the name with no pools", () => {
    const report = (pools: ReadonlyArray<PoolView>) =>
      new Report({
        version: "0",
        live: true,
        generatedAt: ts(0),
        strategy: "reset-first",
        accounts: [],
        pools,
        nudges: [],
      })
    expect(menuBar(report([]), ts(0))).toBe("slopmax")
    const both = report([
      pool("claude", [new PoolWindow({ span: "5h", used: 42.4, resetsAt: ts(100), weighted: false })]),
      pool("codex", [new PoolWindow({ span: "7d", used: 10, weighted: false })]),
    ])
    expect(menuBar(both, ts(0))).toBe("Claude 42% · ChatGPT —")
    // A window whose reset has passed reads as fresh.
    expect(menuBar(both, ts(100))).toBe("Claude 0% · ChatGPT —")
  })
})

describe("notifications", () => {
  it("read plainly: a title for the kind, and the message without backticks", () => {
    const notice = new Notice({
      kind: "reset-expiring",
      key: "reset:a:1",
      account: "codex0",
      message: "A limit reset on codex0 expires; redeem it with `slopmax redeem codex0`.",
      at: ts(1_000_000),
    })
    expect(noticeTitle(notice.kind)).toBe("Limit reset expiring")
    expect(noticeBody(notice)).toBe("A limit reset on codex0 expires; redeem it with slopmax redeem codex0.")
    const titles = Object.fromEntries(NoticeKind.literals.map((kind) => [kind, noticeTitle(kind)]))
    expect(titles).toEqual({
      "reset-expiring": "Limit reset expiring",
      "quota-unused": "Quota going unused",
      exhausted: "Every account is limited",
      recovered: "Accounts are back",
      "signed-out": "Sign in again",
      limited: "Account limited",
      available: "Account available",
      test: "slopmax",
    })
  })

  it("name providers and agents as people know them", () => {
    expect(providerTitle("codex")).toBe("ChatGPT")
    expect(providerTitle("compat")).toBe("Compatible endpoint")
    expect(agentTitle("claude-code")).toBe("Claude Code")
  })
})
