import { describe, expect, test } from "bun:test"
import { Condition, LimitReset, Note, PoolView, Report, Window } from "@slopmax/client"
import { DateTime } from "effect"
import { across, credits, gauge, groups, slots, status, windowTitle } from "../../src/view/groups.ts"
import { account, fixtureReport } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")
const at = (minutes: number) => DateTime.add(now, { minutes })

const report = fixtureReport(now)
const byProvider = (provider: string) => groups(report, now, zone).find((group) => group.provider === provider)

describe("groups", () => {
  test("carry a group per provider in try order, with gauges, status and the pool", () => {
    expect(groups(report, now, zone).map((group) => group.title)).toEqual([
      "Claude",
      "ChatGPT",
      "Anthropic API",
      "Compatible endpoint",
    ])
    const claude = byProvider("claude")
    expect(claude?.subscription).toBe(true)
    expect(claude?.working).toBe(3)
    expect(claude?.enabled).toBe(3)
    expect(claude?.ready).toBe(2)
    expect(claude?.overview.map((w) => [w.title, w.gauge.percent])).toEqual([
      ["5-hour", "54%"],
      ["Weekly", "56%"],
      ["Weekly · opus", "52%"],
    ])
    const ana = claude?.rows[0]
    expect(ana?.gauges[0]).toMatchObject({ percent: "62%", resetsIn: "1h40m", resetsAt: "13:40", tone: "good" })
    expect(ana?.status).toEqual({ text: "● active · 2 sessions", tone: "good" })
    expect(ana?.lastUsed).toBe("used 2m ago")
    const metered = byProvider("anthropic")
    expect(metered?.subscription).toBe(false)
    expect(metered?.columns).toEqual([])
    expect(metered?.rows[0]?.plan).toBe("per token")
  })

  test("give a window for one model a column after the shared ones", () => {
    const accounts = [
      account({ id: "claude-1", provider: "claude", name: "a", windows: [Window.of("7d", 1, undefined, "opus")] }),
      account({ id: "claude-2", provider: "claude", name: "b", windows: [Window.of("7d", 2), Window.of("5h", 3)] }),
    ]
    expect(slots(accounts).map(windowTitle)).toEqual(["5-hour", "Weekly", "Weekly · opus"])
  })

  test("size a weighted pool's segments by plan, and an unweighted one evenly", () => {
    const claude = byProvider("claude")
    expect(claude?.weighted).toBe(true)
    expect(claude?.overview[0]?.shares.map((share) => share.weight)).toEqual([0.66, 0.25, 0.09])
    const codex = byProvider("codex")
    expect(codex?.weighted).toBe(false)
    expect(codex?.overview[0]?.shares.map((share) => share.weight)).toEqual([1, 1])
    // A signed-out account is out of service, so its segment reads as idle.
    expect(codex?.overview[0]?.shares.map((share) => share.idle)).toEqual([false, true])
    expect(across(claude ?? assert())).toBe("Across 3 accounts, weighted by plan")
    expect(across(codex ?? assert())).toBe("Across 1 of 2 accounts, average of accounts; the rest are out of service")
  })

  test("read plans in title case, keys per token, and name the tool a followed login comes from", () => {
    const claude = byProvider("claude")
    expect(claude?.rows.map((row) => row.plan)).toEqual(["Max 20x", "Max 5x", "Pro"])
    const ben = claude?.rows[1]
    expect(ben?.follows).toBe("Claude Code")
    expect(ben?.notes.map((note) => note.text)).toEqual(["follows Claude Code", "342 requests, 9.8M tokens all time"])
  })

  test("say a pin in the status, but not for an account turned off, and give use its period", () => {
    const pinned = account({ id: "claude-1", provider: "claude", name: "a", pinned: true })
    expect(status(pinned, now).text).toBe("ready · pinned")
    const off = account({
      id: "claude-2",
      provider: "claude",
      name: "b",
      pinned: true,
      disabled: true,
      condition: Condition.cases.Disabled.make({}),
    })
    expect(status(off, now)).toEqual({ text: "disabled", tone: "muted" })
    const ana = byProvider("claude")?.rows[0]
    expect(ana?.notes[0]?.text).toBe("1,284 requests, 48.2M tokens all time")
  })

  test("fade an account's other windows while one of them is full", () => {
    const ops = byProvider("claude")?.rows[2]
    expect(ops?.status).toEqual({ text: "limited · back in 52m00s", tone: "warn" })
    expect(ops?.faded).toEqual([false, true, true])
    expect(ops?.gauges[2]).toBeUndefined()
  })

  test("show a gauge's pace only for an account's own window, not for the pool's", () => {
    const own = gauge(Window.of("5h", 90, at(150)), now, zone)
    expect(own.pace?.label).toEqual({ text: "Runs out ~12:16", tone: "warn" })
    expect(own.pace?.elapsed).toBeCloseTo(0.5)
    expect(gauge(Window.of("5h", 90, at(150)), now, zone, false).pace).toBeUndefined()
    // Nothing used: nothing to reset, so no reset time.
    expect(gauge(Window.of("5h", 0, at(150)), now, zone).resetsIn).toBeUndefined()
  })
})

const limited = (id: string, name: string, minutes: number) =>
  account({ id, provider: "claude", name, condition: Condition.cases.Limited.make({ until: at(minutes) }) })

describe("where new sessions go", () => {
  test("a pool says which account takes the next session, and why", () => {
    const claude = byProvider("claude")
    expect(claude?.next).toEqual({ text: "New sessions → ben@studio.dev · its quota resets soonest", tone: "muted" })
    expect(claude?.nextShort.text).toBe("New sessions → ben · its quota resets soonest")
    expect(claude?.rows.map((row) => row.next)).toEqual([false, true, false])
  })

  test("with no account free, it says when one is back", () => {
    const stuck = new Report({
      ...report,
      accounts: [limited("claude-1", "late@x.dev", 300), limited("claude-2", "soon@x.dev", 90)],
      pools: [new PoolView({ provider: "claude", accounts: 2, windows: [], scoped: [], shares: {} })],
    })
    const claude = groups(stuck, now, zone)[0]
    expect(claude?.next).toEqual({
      text: "No account can take a new session until 13:30, when soon@x.dev is back",
      tone: "warn",
    })
    expect(claude?.nextShort.text).toBe("No account can take a new session until 13:30, when soon is back")
    const none = new Report({ ...stuck, accounts: [account({ id: "claude-3", provider: "claude", name: "x" })] })
    expect(groups(none, now, zone)[0]?.next.text).toBe("No account can take a new session")
  })
})

describe("limit resets", () => {
  test("show their dates, soonest first, and what one clears", () => {
    const codex = byProvider("codex")
    const found = codex?.rows[0]?.credits
    expect(found?.title).toBe("2 limit resets")
    expect(found?.clears).toBe("5-hour and weekly")
    expect(found?.held).toBeUndefined()
    expect(found?.credits.map((c) => [c.line, c.granted, c.tone])).toEqual([
      ["Expires in 1d6h · Sun 18:00", "Granted Oct 23", "warn"],
      ["Expires in 9d0h · Nov 9", "Granted Oct 29", "muted"],
    ])
    expect(codex?.credits).toBe("2 limit resets · the next expires in 1d6h")
  })

  test("say why none can be redeemed: signed out, turned off, or nothing used", () => {
    const base = {
      id: "codex-1",
      provider: "codex" as const,
      name: "a",
      resets: [new LimitReset({ id: "r", expiresAt: at(600) })],
    }
    const used = [Window.of("5h", 30, at(60))]
    const signedOut = account({ ...base, windows: used, condition: Condition.cases.SignInNeeded.make({ error: "x" }) })
    expect(credits(signedOut, now, zone)?.held).toBe("Sign in again to redeem one")
    expect(credits(account({ ...base, windows: used, disabled: true }), now, zone)?.held).toBe(
      "Turn it on to redeem one",
    )
    expect(credits(account({ ...base, windows: [Window.of("5h", 0, at(60))] }), now, zone)?.held).toBe(
      "Nothing to reset yet",
    )
    // Counted by its usage before slopmax has listed them.
    const counted = account({
      id: "codex-2",
      provider: "codex",
      name: "b",
      notes: [Note.cases.Resets.make({ count: 1 })],
    })
    expect(credits(counted, now, zone)).toMatchObject({ count: 1, title: "1 limit reset", credits: [] })
    // Keys bill by the token: no limit resets to show.
    expect(credits(account({ ...base, provider: "anthropic" }), now, zone)).toBeUndefined()
  })
})

const assert = (): never => {
  throw new Error("missing group")
}
