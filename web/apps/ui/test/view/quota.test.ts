// Account-level reset decisions stay separate from pool means and request totals.
import { expect, test } from "bun:test"
import { Condition, Report, Window } from "@slopmax/client"
import { DateTime } from "effect"
import { requiredPace, resetOpportunities } from "../../src/view/quota.ts"
import { account, emptyReport } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-11-20T12:00:00Z")
const inSixHours = DateTime.add(now, { hours: 6 })

test("ranks actionable resets and calculates the pace from the actual deadline", () => {
  const current = account({
    id: "claude-1a2b3c4d",
    provider: "claude",
    name: "work",
    windows: [
      Window.of("7d", 40, inSixHours),
      Window.of("7d", 5, inSixHours, "opus"),
      Window.of("5h", 20, DateTime.add(now, { hours: 2 })),
      Window.of("30d", 60),
    ],
  })
  const expired = account({
    id: "codex-1a2b3c4d",
    provider: "codex",
    name: "old",
    windows: [Window.of("7d", 0, now)],
  })
  const blocked = account({
    id: "codex-9a2b3c4d",
    provider: "codex",
    name: "blocked",
    condition: Condition.cases.Limited.make({ until: inSixHours }),
    windows: [Window.of("7d", 0, inSixHours)],
  })
  const report = new Report({
    ...emptyReport(now),
    accounts: [expired, blocked, current],
  })
  const opportunities = resetOpportunities(report, now, "long")
  expect(opportunities.map(({ account: name, span, left }) => [name, span, left])).toEqual([["work", "7d", 60]])
  for (const entry of opportunities) {
    expect(requiredPace(entry, now)).toBe("10.0")
    expect(requiredPace(entry, DateTime.subtract(inSixHours, { minutes: 2 }))).toBeUndefined()
  }
  expect(resetOpportunities(report, now, "5h").map(({ left }) => left)).toEqual([80])
})
