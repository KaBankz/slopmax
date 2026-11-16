import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { maskEmails, maskReport } from "../../src/view/privacy.ts"
import { fixtureReport } from "../support/fixtures.ts"

describe("hiding email addresses", () => {
  test("keeps each address's first letters and its domain's ending", () => {
    expect(maskEmails("ana@studio.dev")).toBe("a•••@s•••.dev")
    expect(maskEmails("Mail first.last+tag@mail.example.co.uk now")).toBe("Mail f•••@m•••.uk now")
    expect(maskEmails("Team API key")).toBe("Team API key")
  })

  test("masks every account and every nudge of a report, and nothing else", () => {
    const report = fixtureReport(DateTime.makeUnsafe("2026-11-16T12:00:00Z"))
    const masked = maskReport(report)
    expect(masked.accounts.map((a) => a.name)).toContain("a•••@s•••.dev")
    expect(masked.accounts.map((a) => a.name)).toContain("Team API key")
    expect(JSON.stringify(masked)).not.toContain("studio.dev")
    expect(masked.accounts.map((a) => a.id)).toEqual(report.accounts.map((a) => a.id))
  })
})
