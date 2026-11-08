import { describe, expect, test } from "bun:test"
import { Strategy } from "@slopmax/client"
import { Cause, Schema } from "effect"
import {
  autoRedeem,
  count,
  dollars,
  leftLine,
  listed,
  liveDetail,
  minutes,
  patterns,
  pollSteps,
  priced,
  rangeTitle,
  resetsLine,
  routing,
  sentence,
  sentenceCase,
  sessionSteps,
  settingChanged,
  step,
  strategyDetail,
  strategyTitle,
  titleCase,
  updated,
  failureText,
  poolBarTip,
  segmentsShown,
} from "../../src/view/words.ts"

describe("small words", () => {
  test("lists read as English", () => {
    expect(listed([])).toBe("")
    expect(listed(["5-hour"])).toBe("5-hour")
    expect(listed(["5-hour", "weekly"])).toBe("5-hour and weekly")
    expect(listed(["5-hour", "weekly", "monthly"])).toBe("5-hour, weekly, and monthly")
  })

  test("the engine's words read as a sentence, keeping names that have their own case", () => {
    expect(sentence("● active · 2 sessions")).toBe("Active · 2 sessions")
    expect(sentence("limited · back in 52m")).toBe("Limited · back in 52m")
    expect(sentenceCase("slopmax 0.4.0 answers")).toBe("slopmax 0.4.0 answers")
    expect(sentenceCase("api.anthropic.com answers")).toBe("api.anthropic.com answers")
    expect(sentenceCase("lab@studio.dev needs signing in")).toBe("lab@studio.dev needs signing in")
    expect(titleCase("max 20x")).toBe("Max 20x")
  })

  test("counts, money and what requests came to", () => {
    expect(count(1, "request")).toBe("1 request")
    expect(count(1204, "request")).toBe("1,204 requests")
    expect(dollars(412.3)).toBe("$412.30")
    expect(dollars(1204.4)).toBe("$1,204")
    // Every request unpriced reads as a dash; some unpriced, as a floor.
    expect(priced(0, 3, 3)).toBe("—")
    expect(priced(12.3, 1, 5)).toBe("$12.30+")
    expect(priced(12.3, 0, 5)).toBe("$12.30")
  })

  test("the access page's patterns and the history ranges", () => {
    expect(patterns(" gpt-*, claude-*  llama ")).toEqual(["gpt-*", "claude-*", "llama"])
    expect(patterns("")).toEqual([])
    expect(rangeTitle("today")).toBe("Today")
    expect(rangeTitle("7d")).toBe("7 days")
    expect(rangeTitle("30d")).toBe("30 days")
  })

  test("a resets line says when, or that there is nothing to reset", () => {
    expect(resetsLine("2h05m", "22:59")).toBe("Resets in 2h05m · 22:59")
    expect(resetsLine("2h05m", undefined)).toBe("Resets in 2h05m")
    expect(resetsLine(undefined, undefined)).toBe("Nothing to reset")
  })

  test("what resets left on the table reads as a line", () => {
    expect(leftLine(0, 0)).toBe("No weekly window reset in this range")
    expect(leftLine(1, 37.5)).toBe("1 weekly window · 38% unused")
    expect(leftLine(3, 22.5)).toBe("3 weekly windows · 22% unused on average across them")
  })

  test("when the report was made reads coarsely", () => {
    expect(updated(4)).toBe("Updated just now")
    expect(updated(180)).toBe("Updated 3m ago")
    expect(updated(7_300)).toBe("Updated 2h ago")
  })
})

describe("settings words", () => {
  test("every strategy has a name and a sentence", () => {
    for (const strategy of Strategy.literals) {
      expect(strategyTitle(strategy)).toMatch(/^[A-Z][a-z]+ [a-z]+$/)
    }
    expect(strategyTitle("reset-first")).toBe("Reset first")
    expect(strategyTitle("round-robin")).toBe("Round robin")
    expect(strategyDetail("Take turns across accounts")).toBe("Take turns across accounts.")
  })

  test("routing reads as a line", () => {
    expect(routing({ strategy: "fill-first", sessionAffinity: true })).toBe("Fill first · sessions keep their account")
    expect(routing({ strategy: "least-used", sessionAffinity: false })).toBe(
      "Least used · sessions move between accounts",
    )
    // Before the settings are read, it does not guess whether sessions keep their account.
    expect(routing({ strategy: "fill-first" })).toBe("Fill first")
  })

  test("changing a setting says what it does now", () => {
    expect(settingChanged({ strategy: "least-used" })).toBe("slopmax now routes least used.")
    expect(settingChanged({ sessionAffinity: false })).toBe("The strategy now places every request.")
    expect(settingChanged({ redeemExpiring: true })).toBe("Limit resets are redeemed before they expire.")
    expect(settingChanged({ redeemWhenExhausted: false })).toBe(
      "Once every account is spent, the pool waits for a reset.",
    )
    expect(settingChanged({ sessionMinutes: 120 })).toBe("A session keeps its account through 2 h idle.")
    expect(settingChanged({ warmWindows: true })).toBe("Idle ChatGPT windows start as they reset.")
    expect(settingChanged({ paidOverflow: false })).toBe(
      "API keys serve a subscription's models only when asked for by name.",
    )
    expect(settingChanged({ pollMinutes: 0 })).toBe("slopmax no longer polls usage.")
    expect(settingChanged({ pollMinutes: 5 })).toBe("slopmax polls usage every 5 min.")
  })

  test("auto-redeem follows the settings", () => {
    const off = { redeemExpiring: false, redeemWhenExhausted: false }
    expect(autoRedeem(off, "ChatGPT")).toBeUndefined()
    expect(autoRedeem({ ...off, redeemExpiring: true }, "ChatGPT")).toBe(
      "slopmax redeems one by itself 3 hours before it would expire unused, if the account has quota to reset.",
    )
    expect(autoRedeem({ ...off, redeemWhenExhausted: true }, "ChatGPT")).toBe(
      "slopmax redeems one by itself when every ChatGPT account is spent.",
    )
    expect(autoRedeem({ redeemExpiring: true, redeemWhenExhausted: true }, "ChatGPT")).toBe(
      "slopmax redeems one by itself when every ChatGPT account is spent, and 3 hours before one would expire unused.",
    )
  })

  test("advanced settings step through their stops and read as durations", () => {
    expect(step(sessionSteps, 60, true)).toBe(120)
    expect(step(sessionSteps, 60, false)).toBe(30)
    // A value set by hand between stops moves to the nearer stop that way.
    expect(step(sessionSteps, 45, true)).toBe(60)
    expect(step(sessionSteps, 45, false)).toBe(30)
    expect(step(sessionSteps, 1440, true)).toBeUndefined()
    expect(step(pollSteps, 0, false)).toBeUndefined()
    expect(minutes(1440)).toBe("1 day")
    expect(minutes(120)).toBe("2 h")
    expect(minutes(45)).toBe("45 min")
    expect(liveDetail("warmWindows", [{ name: "warmWindows", summary: "start idle windows as they reset" }])).toBe(
      "Start idle windows as they reset.",
    )
    expect(liveDetail("warmWindows", [])).toBe("")
  })
})

describe("the pool's bar and failures", () => {
  test("past a dozen accounts the pool's bar reads as one, and says so", () => {
    expect(poolBarTip(3, true)).toBe("One segment per account, as wide as its plan's share of the pool")
    expect(poolBarTip(segmentsShown + 19, true)).toBe("The pool's use across 31 accounts, weighted by plan")
    expect(poolBarTip(segmentsShown + 1, false)).toBe("The pool's use across 13 accounts")
  })

  test("a failure reads as its own words, without a field's path or a schema's", () => {
    const refused = Schema.decodeUnknownExit(
      Schema.Struct({
        url: Schema.String.check(Schema.makeFilter((u) => u.startsWith("http") || "Url is a base URL")),
      }),
    )({ url: "x" })
    if (refused._tag !== "Failure") throw new Error("expected a failure")
    expect(failureText(refused.cause)).toBe("Url is a base URL")
    const unread = Schema.decodeUnknownExit(Schema.Struct({ version: Schema.String }))({})
    if (unread._tag !== "Failure") throw new Error("expected a failure")
    expect(failureText(unread.cause)).toBe("slopmax answered in a form this page does not read; reload it")
    expect(failureText(Cause.fail(new Error("ChatGPT answered 503")))).toBe("ChatGPT answered 503")
    expect(failureText(Cause.fail(42))).toBe("it failed")
  })
})
