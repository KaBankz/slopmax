import { describe, expect, test } from "bun:test"
import { Condition, LimitReset, Notice, Report, Window } from "@slopmax/client"
import { DateTime } from "effect"
import { attention, firstSentence, standing, worstTone } from "../../src/view/attention.ts"
import { account, emptyReport, fixtureReport } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")
const at = (minutes: number) => DateTime.add(now, { minutes })
const report = fixtureReport(now)

const withAccounts = (accounts: Report["accounts"], nudges: Report["nudges"] = []) =>
  new Report({ ...emptyReport(now), accounts, nudges })

describe("how the accounts stand", () => {
  test("a headline, what keeps the rest, and the worst tone", () => {
    expect(standing(report)).toEqual({
      headline: "5 of 7 accounts are ready",
      detail: "1 limited · 1 needs signing in",
      tone: "bad",
    })
    expect(standing(emptyReport(now)).headline).toBe("No accounts yet")
    const one = withAccounts([account({ id: "claude-1", provider: "claude", name: "a" })])
    expect(standing(one)).toEqual({ headline: "Your account is ready", tone: "good" })
    const off = withAccounts([
      account({
        id: "claude-1",
        provider: "claude",
        name: "a",
        disabled: true,
        condition: Condition.cases.Disabled.make({}),
      }),
    ])
    expect(standing(off)).toEqual({ headline: "Every account is turned off", detail: "1 turned off", tone: "good" })
    const limited = withAccounts([
      account({ id: "claude-1", provider: "claude", name: "a" }),
      account({ id: "claude-2", provider: "claude", name: "b", condition: Condition.cases.Throttled.make({}) }),
    ])
    expect(standing(limited)).toEqual({ headline: "1 of 2 accounts are ready", detail: "1 limited", tone: "warn" })
  })
})

describe("what wants a look", () => {
  test("lists what is broken first, then limit resets about to lapse and quota about to go unused", () => {
    const items = attention(report, now, zone)
    expect(items.map((item) => [item.text, item.tone, item.remedy])).toEqual([
      ["lab@studio.dev needs signing in again", "bad", "sign-in"],
      ["A limit reset on ana@studio.dev expires in 1d6h · Sun 18:00", "warn", "redeem"],
      [
        "ana@studio.dev's week resets in 19h50m · Sun 07:50 with 45% of it unused, about $90 of its plan",
        "warn",
        "look",
      ],
    ])
    // The short form for the menu bar's panel.
    expect(items.map((item) => [item.who, item.what])).toEqual([
      ["lab", "sign in again"],
      ["ana", "reset expires in 1d6h"],
      ["ana", "week ends in 19h50m, 45% unused"],
    ])
    expect(worstTone(items, "codex")).toBe("bad")
    expect(worstTone(items, "claude")).toBeUndefined()
  })

  test("a limited account wants a look only when it holds a limit reset to redeem", () => {
    const limited = (resets: ReadonlyArray<LimitReset>) =>
      account({
        id: "codex-1",
        provider: "codex",
        name: "a@x.dev",
        condition: Condition.cases.Limited.make({ until: at(90) }),
        resets,
      })
    expect(attention(withAccounts([limited([])]), now, zone)).toEqual([])
    const holding = attention(withAccounts([limited([new LimitReset({ id: "r", expiresAt: at(20_000) })])]), now, zone)
    expect(holding.map((item) => [item.text, item.what, item.remedy])).toEqual([
      ["a@x.dev is limited until 13:30, and holds 1 limit reset", "limited until 13:30, 1 held", "redeem"],
    ])
  })

  test("a window running out before it resets wants a look", () => {
    const fast = account({
      id: "claude-1",
      provider: "claude",
      name: "a@x.dev",
      windows: [Window.of("5h", 90, at(150))],
    })
    expect(attention(withAccounts([fast]), now, zone).map((item) => item.text)).toEqual([
      "a@x.dev's 5-hour window runs out ~12:16",
    ])
  })

  test("nudges join the list once, and only for accounts in the report", () => {
    const nudge = (kind: Notice["kind"], name: string) =>
      new Notice({
        kind,
        key: `${kind}|${name}`,
        provider: "codex",
        account: name,
        until: at(600),
        message: `A limit reset on ${name} expires in 10h00m (22:00). Run \`slopmax redeem ${name}\`.`,
        at: now,
      })
    const plain = account({ id: "codex-1", provider: "codex", name: "a@x.dev" })
    const items = attention(
      withAccounts([plain], [nudge("reset-expiring", "a@x.dev"), nudge("reset-expiring", "gone@x.dev")]),
      now,
      zone,
    )
    expect(items.map((item) => [item.text, item.what, item.remedy])).toEqual([
      ["A limit reset on a@x.dev expires in 10h00m · 22:00", "reset expires in 10h00m", "redeem"],
    ])
  })

  test("a limit reset already offered is not offered twice, and says when auto-redeem is off", () => {
    const holding = account({
      id: "codex-1",
      provider: "codex",
      name: "a@x.dev",
      resets: [new LimitReset({ id: "r", expiresAt: at(600) })],
    })
    const nudge = new Notice({
      kind: "reset-expiring",
      key: "k",
      provider: "codex",
      account: "a@x.dev",
      until: at(600),
      message: "A limit reset on a@x.dev expires soon.",
      at: now,
    })
    const items = attention(withAccounts([holding], [nudge]), now, zone)
    expect(items.map((item) => item.text)).toEqual([
      "A limit reset on a@x.dev expires in 10h00m · 22:00; auto-redeem is off",
    ])
  })

  test("a notice's first sentence reads without its marks", () => {
    expect(firstSentence("Your week resets in 3h (19:12). Run `slopmax use a`.")).toBe("Your week resets in 3h · 19:12")
  })
})
