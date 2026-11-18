import { describe, expect, test } from "bun:test"
import { AccountDetail, AccountId, Burn, HealthCell, Trend, TrendPoint, WindowSpend } from "@slopmax/client"
import { DateTime } from "effect"
import { health, lanes, rate, spendView, trendView } from "../../src/view/forecast.ts"
import { fixturePool } from "../support/pools.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")
const at = (minutes: number) => DateTime.add(now, { minutes })
const names = new Map([["claude-1a2b3c4d", "ana@studio.dev"]])

const trend = (fields: Partial<ConstructorParameters<typeof Trend>[0]>) =>
  new Trend({
    span: "7d",
    used: 56,
    recorded: [new TrendPoint({ at: at(-120), used: 50 }), new TrendPoint({ at: now, used: 56 })],
    projected: [new TrendPoint({ at: now, used: 56 }), new TrendPoint({ at: at(600), used: 70 })],
    resets: [],
    burns: [],
    ...fields,
  })

describe("a pool's forecast", () => {
  test("joins the recorded line to the projection now", () => {
    const view = trendView(trend({}), names, now, zone)
    const nowMs = DateTime.toEpochMillis(now)
    expect(view.data.find((d) => d.t === nowMs)).toMatchObject({ recorded: 56, projected: 56 })
    expect(view.data.at(-1)).toMatchObject({ projected: 70 })
    expect(view.data.at(-1)?.recorded).toBeUndefined()
    expect(view.from).toBeLessThan(nowMs)
    expect(view.to).toBeGreaterThan(nowMs)
  })

  test("says a pool that runs dry, and which account goes first, as warnings", () => {
    const view = trendView(
      trend({
        burn: 1.2,
        burns: [new Burn({ hours: 1, rate: 2 }), new Burn({ hours: 3, rate: 1.2 })],
        sustainable: 0.6,
        runsOutAt: at(300),
        dryUntil: at(480),
        firstOut: { account: AccountId.make("claude-1a2b3c4d"), at: at(90) },
      }),
      names,
      now,
      zone,
    )
    const [pace, dry, first] = view.figures
    expect(pace).toMatchObject({ value: "1.2%/h", tone: "warn" })
    expect(pace?.detail).toBe("Over the last 3 hours, faster than the 0.6%/h that lasts the window")
    expect(dry).toMatchObject({ value: "~17:00", tone: "warn" })
    expect(dry?.detail).toBe("In 5h00m at the recent pace, until a reset at 20:00")
    expect(first).toMatchObject({ value: "ana@studio.dev", tone: "warn" })
    expect(first?.detail).toBe("~13:30, in 1h30m, at its recent pace")
    expect(view.dry).toBe(true)
  })

  test("before a pace can be measured, says so instead of a number", () => {
    const [pace, dry] = trendView(trend({}), names, now, zone).figures
    expect(pace?.value).toBe("—")
    expect(dry?.value).toBe("Not at this pace")
  })

  test("rates read finer below a tenth", () => {
    expect(rate(0.04)).toBe("0.04%/h")
    expect(rate(1.26)).toBe("1.3%/h")
  })

  test("the fixture week draws for both windows", () => {
    const pool = fixturePool("claude", now, zone)
    expect(pool?.trends.map((t) => t.span)).toEqual(["5h", "7d"])
    for (const t of pool?.trends ?? []) {
      expect(trendView(t, names, now, zone).recorded).toBe(true)
    }
  })
})

describe("the resets ahead", () => {
  test("place each window's reset on its account's lane, a week's twice when it comes round", () => {
    const view = lanes(
      [
        {
          id: "a",
          name: "ana@studio.dev",
          windows: [
            { span: "5h", used: 40, resetsAt: at(60) },
            { span: "7d", used: 50, resetsAt: at(24 * 60) },
            { span: "7d", model: "opus", used: 50, resetsAt: at(24 * 60) },
          ],
        },
      ],
      now,
      zone,
    )
    const marks = view.lanes[0]?.marks ?? []
    expect(marks.map((m) => m.span)).toEqual(["5h", "7d"])
    expect(marks[1]?.offset).toBeCloseTo(1 / 7)
    expect(view.today).toBe(2)
    expect(view.days.length).toBe(7)
  })
})

describe("an account's windows and last day", () => {
  test("a window's spend reads as dollars so far and a percent's worth", () => {
    const spend = new WindowSpend({
      span: "7d",
      since: at(-3 * 24 * 60),
      resetsAt: at(4 * 24 * 60),
      used: 48,
      requests: 1_204,
      tokens: 48_000_000,
      cost: 1_622.4,
      perPercent: 33.8,
    })
    const view = spendView(spend)
    expect(view?.line).toBe("$1,622 so far")
    expect(view?.rate).toBe("$33.80 per 1%")
    expect(view?.tip).toContain("whole window is worth about $3,380")
    expect(spendView(new WindowSpend({ ...spend, requests: 0 }))).toBeUndefined()
  })

  test("health cells take the tone of how the half hour went", () => {
    const detail = new AccountDetail({
      id: AccountId.make("a"),
      windows: [],
      health: [
        new HealthCell({ answered: 0, failed: 0 }),
        new HealthCell({ answered: 9, failed: 0 }),
        new HealthCell({ answered: 9, failed: 1 }),
        new HealthCell({ answered: 1, failed: 3 }),
      ],
    })
    const view = health(detail, now, 30, zone)
    expect(view.cells.map((c) => c.tone)).toEqual(["none", "good", "warn", "bad"])
    expect(view.cells[1]?.tip).toBe("From 12:30: 9 answered")
    expect(view.summary).toBe("19 answered, 4 failed in the last day")
  })
})
