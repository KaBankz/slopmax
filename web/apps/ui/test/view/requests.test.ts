import { describe, expect, test } from "bun:test"
import { AccountId, LedgerRecord, RequestPage, RequestFacets, RequestRow, Usage } from "@slopmax/client"
import { DateTime } from "effect"
import { allRequests, csv, facts, narrowed, refine, rowView, totalsLine } from "../../src/view/requests.ts"

const now = DateTime.makeUnsafe("2026-11-16T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")
const name = (id: string) => (id === "claude-1" ? "ana@studio.dev" : id)

const row = (fields: Partial<Parameters<typeof LedgerRecord.cases.Request.make>[0]> = {}, extra = {}) =>
  new RequestRow({
    record: LedgerRecord.cases.Request.make({
      at: DateTime.subtract(now, { minutes: 5 }),
      account: AccountId.make("claude-1"),
      provider: "claude",
      model: "claude-opus-5-5",
      status: 200,
      usage: new Usage({ requests: 1, input: 1_000, output: 500, cacheRead: 20_000, cacheWrite: 0 }),
      ms: 4_200,
      firstByteMs: 900,
      attempts: 1,
      agent: "claude-code",
      via: "http",
      ...fields,
    }),
    cost: 0.0425,
    ...extra,
  })

describe("the request filter", () => {
  test("changes one part at a time, and an undefined part means any", () => {
    const narrow = refine(allRequests, { account: "claude-1", outcome: "failed" })
    expect(narrow).toEqual({ span: "live", outcome: "failed", account: "claude-1" })
    expect(narrowed(narrow)).toBe(true)
    const wide = refine(narrow, { account: undefined, outcome: "all", span: "7d" })
    expect(wide).toEqual({ span: "7d", outcome: "all" })
    expect(narrowed(wide)).toBe(false)
  })
})

describe("a request", () => {
  test("reads as a row: when, who, where, and what it moved and cost", () => {
    const view = rowView(row({ attempts: 2 }), 0, name, now, zone)
    expect(view).toMatchObject({
      time: "11:55:00",
      who: "Claude Code",
      account: "ana@studio.dev",
      tokens: "21.5k",
      cost: "$0.04",
      took: "900 ms · 4.20 s",
      failed: false,
    })
    expect(view.notes).toEqual(["after failover"])
    expect(rowView(row({ at: DateTime.subtract(now, { days: 2 }) }), 0, name, now, zone).time).toBe("Nov 14, 12:00:00")
  })

  test("a request broken off counts as failed; one the agent hung up on does not", () => {
    expect(rowView(row({}, { end: "stalled" }), 0, name, now, zone).failed).toBe(true)
    expect(rowView(row({}, { end: "client-gone" }), 0, name, now, zone)).toMatchObject({
      failed: false,
      notes: ["interrupted"],
    })
  })

  test("its sheet says how it went in words", () => {
    const groups = facts(row({ status: 529, attempts: 3 }), name, zone)
    const outcome = groups.find((g) => g.title === "Outcome")?.facts ?? []
    expect(outcome.find((f) => f.title === "Status")?.value).toBe("529, overloaded")
    expect(outcome.find((f) => f.title === "Accounts tried")?.value).toBe("3, none could answer")
  })
})

const page = (failed: number, rescued: number) =>
  new RequestPage({
    range: "7d",
    since: now,
    rows: [],
    offset: 0,
    matched: 1_204,
    failed,
    rescued,
    tokens: 48_200_000,
    cost: 412.2,
    facets: new RequestFacets({ accounts: [], models: [], agents: [] }),
  })

describe("what a range came to", () => {
  test("names failures and failover only when there are any", () => {
    expect(totalsLine(page(12, 3))).toBe(
      "1,204 requests · 12 failed · 3 saved by failover · 48.2M tokens · $412.20 at API prices",
    )
    expect(totalsLine(page(0, 0))).toBe("1,204 requests · 48.2M tokens · $412.20 at API prices")
  })

  test("exports as CSV with a header, quoting what needs it", () => {
    const text = csv([row({ session: 'a,"b"' })], (id) => (id === "claude-1" ? "Ana, Team" : id))
    const [header, line] = text.trim().split("\n")
    expect(header?.startsWith("time,agent,provider,model,account,status")).toBe(true)
    expect(line).toContain('"Ana, Team"')
    expect(line).toContain('"a,""b"""')
    expect(line).toContain("0.042500")
  })
})
