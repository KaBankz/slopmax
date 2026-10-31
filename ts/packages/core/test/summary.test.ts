import { describe, expect, it } from "bun:test"

import { Schema } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { without } from "../src/account.ts"
import type { Entry } from "../src/ledger.ts"
import { NO_ACCOUNT, since, Summary, summarize, Totals, TotalsSchema } from "../src/summary.ts"

const entry = (model: string, input: number): Entry => ({
  at: Timestamp.nowUnsafe(),
  account: "a",
  provider: "claude",
  model,
  status: 200,
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ms: 1,
  attempts: 1,
})

describe("summary", () => {
  it("unpriced_requests_are_counted_apart", () => {
    const prices = {}
    const totals = Totals.empty()
    Totals.add(totals, entry("compat-model", 10), prices)
    expect(Totals.costLabel(totals)).toBe("—")
    Totals.add(totals, entry("claude-opus-5-5", 1_000_000), prices)
    expect(Totals.costLabel(totals)).toBe("$4.00+")
    expect([totals.requests, totals.unpriced]).toEqual([2, 1])

    const priced = Totals.empty()
    Totals.add(priced, entry("claude-opus-5-5", 500_000), prices)
    expect(Totals.costLabel(priced)).toBe("$2.00")
  })

  it("requests_are_the_answers_alone", () => {
    const prices = {}
    const totals = Totals.empty()
    Totals.add(totals, entry("claude-opus-5-5", 100), prices)
    // An agent listing models or counting tokens moves none.
    Totals.add(totals, entry("claude-opus-5-5", 0), prices)
    Totals.add(totals, { ...entry("claude-opus-5-5", 0), status: 429 }, prices)
    expect([totals.requests, totals.failed, totals.input]).toEqual([1, 1, 100])
    expect(totals.unpriced).toBe(0)
  })

  it("ranges_start_at_local_midnight", () => {
    const now = Timestamp.nowUnsafe()
    expect(since("all", now)).toBe(0)
    const today = since("today", now) ?? 0
    const week = since("7d", now) ?? 0
    expect(today <= now && Timestamp.durationSince(now, today) < SignedDuration.fromHours(25)).toBe(true)
    expect(Timestamp.durationSince(today, week)).toBe(SignedDuration.fromHours(24 * 6))
    expect(since("1y", now)).toBeUndefined()
  })
})

const named = (account: string, status = 200): Entry => ({ ...entry("m", 10), account, status })

describe("summary, beyond the Rust tests", () => {
  it("totals_are_written_with_rusts_keys_and_cost_rounded", () => {
    const totals = { ...Totals.empty(), requests: 1, input: 3, cost: 0.22701000000000002 }
    expect(JSON.stringify(Schema.encodeSync(TotalsSchema)(totals))).toBe(
      '{"requests":1,"input":3,"output":0,"cache_read":0,"cache_write":0,"cost":0.22701}',
    )
    expect(JSON.stringify(Schema.encodeSync(TotalsSchema)({ ...Totals.empty(), unpriced: 2, failed: 1 }))).toBe(
      '{"requests":0,"input":0,"output":0,"cache_read":0,"cache_write":0,"cost":0.0,"unpriced":2,"failed":1}',
    )
  })

  it("rows_group_by_model_or_account_in_key_order", () => {
    const entries: ReadonlyArray<Entry> = [
      entry("m-b", 10),
      entry("m-a", 10),
      { ...entry("m-a", 0), status: 429, account: "" },
      without(entry("m-a", 0), "model"),
    ]
    const byModel = summarize(entries, 0, "model", {}, new Map())
    expect([...byModel.rows.keys()]).toEqual(["m-a", "m-b"])
    expect(byModel.total.requests).toBe(2)
    const byAccount = summarize(entries, 0, "account", {}, new Map([["a", "me@x.dev"]]))
    expect([...byAccount.rows.keys()]).toEqual([NO_ACCOUNT, "me@x.dev"])
    expect(byAccount.rows.get(NO_ACCOUNT)?.failed).toBe(1)
    const byDay = summarize(entries, 0, "day", {}, new Map())
    expect([...byDay.rows.keys()][0]).toMatch(/^\d{4}-\d\d-\d\d$/)
    const text = Summary.json(byModel)
    expect(text.startsWith('{"since":"1970-01-01T00:00:00Z","by":"model","rows":{"m-a":')).toBe(true)
  })

  it("rows_named_like_numbers_keep_byte_order", () => {
    // A JS object would put `1` and `2` first; a BTreeMap puts `(` first.
    const names = new Map([
      ["a1", "1"],
      ["a2", "2"],
      ["a10", "10"],
    ])
    const summary = summarize([named("a2"), named("a10"), named("a1"), named("", 429)], 0, "account", {}, names)
    expect([...summary.rows.keys()]).toEqual([NO_ACCOUNT, "1", "10", "2"])
    const row = '{"requests":1,"input":10,"output":0,"cache_read":0,"cache_write":0,"cost":0.0,"unpriced":1}'
    const failed = '{"requests":0,"input":0,"output":0,"cache_read":0,"cache_write":0,"cost":0.0,"failed":1}'
    const total =
      '{"requests":3,"input":30,"output":0,"cache_read":0,"cache_write":0,"cost":0.0,"unpriced":3,"failed":1}'
    expect(Summary.json(summary)).toBe(
      `{"since":"1970-01-01T00:00:00Z","by":"account","rows":{"${NO_ACCOUNT}":${failed},"1":${row},"10":${row},"2":${row}},"total":${total}}`,
    )
  })

  it("pretty_json_is_laid_out_as_serde_json_does", () => {
    const summary = summarize([{ ...entry("m", 10), account: "7" }], 0, "account", {}, new Map())
    const extra = [["left_on_the_table", { windows: 0, accounts: [] }]] as const
    expect(Summary.json(summary, 2, extra)).toBe(
      [
        "{",
        '  "since": "1970-01-01T00:00:00Z",',
        '  "by": "account",',
        '  "rows": {',
        '    "7": {',
        '      "requests": 1,',
        '      "input": 10,',
        '      "output": 0,',
        '      "cache_read": 0,',
        '      "cache_write": 0,',
        '      "cost": 0.0,',
        '      "unpriced": 1',
        "    }",
        "  },",
        '  "total": {',
        '    "requests": 1,',
        '    "input": 10,',
        '    "output": 0,',
        '    "cache_read": 0,',
        '    "cache_write": 0,',
        '    "cost": 0.0,',
        '    "unpriced": 1',
        "  },",
        '  "left_on_the_table": {',
        '    "windows": 0,',
        '    "accounts": []',
        "  }",
        "}",
      ].join("\n"),
    )
    expect(Summary.json({ ...summary, rows: new Map() })).toContain('"rows":{}')
  })
})
