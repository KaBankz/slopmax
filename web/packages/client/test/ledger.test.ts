import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Schema } from "effect"
import {
  AccountId,
  History,
  LedgerRecord,
  LeftOnTheTable,
  type RequestRecord,
  Summary,
  Totals,
  Usage,
} from "../src/index.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const decodeLine = (line: string) => Schema.decodeUnknownSync(LedgerRecord)(JSON.parse(line))
const encodeLine = (record: LedgerRecord) => JSON.stringify(Schema.encodeSync(LedgerRecord)(record))

const request = (status: number, usage: Partial<Usage> = {}): RequestRecord =>
  LedgerRecord.cases.Request.make({
    at: ts(1_000),
    provider: "codex",
    status,
    usage: new Usage({ ...Usage.zero, ...usage }),
    ms: 120,
    attempts: 1,
    via: "http",
  })

describe("Usage", () => {
  it("adds up requests and tokens, every kind of token counting toward the total", () => {
    const a = new Usage({ requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 7 })
    const sum = a.plus(a).plus(Usage.zero)
    expect([sum.requests, sum.input, sum.output, sum.cacheRead, sum.cacheWrite]).toEqual([2, 20, 10, 200, 14])
    expect(a.tokens).toBe(122)
    expect(Schema.decodeUnknownSync(Usage)({})).toEqual(Usage.zero)
  })
})

describe("ledger records", () => {
  it("read a request line, taking defaults for what it leaves out", () => {
    const record = decodeLine(
      '{"_tag":"Request","at":"2026-10-04T07:20:00.25Z","provider":"claude","status":200,"ms":5}',
    )
    if (record._tag !== "Request") throw new Error("expected a request")
    expect(record.attempts).toBe(1)
    expect(record.via).toBe("http")
    expect(record.usage).toEqual(Usage.zero)
    expect(record.account).toBeUndefined()
    expect(DateTime.formatIso(record.at)).toBe("2026-10-04T07:20:00.250Z")
  })

  it("write a line per request that reads back the same", () => {
    const record = LedgerRecord.cases.Request.make({
      at: ts(1_000),
      account: AccountId.make("codex-1a2b3c4d"),
      provider: "codex",
      model: "gpt-6-sol",
      status: 200,
      usage: new Usage({ requests: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
      ms: 900,
      firstByteMs: 120,
      attempts: 2,
      agent: "codex",
      session: "s-1",
      via: "socket",
    })
    const line = encodeLine(record)
    expect(line).not.toContain("\n")
    expect(decodeLine(line)).toEqual(record)
    // Warmups are sent by slopmax itself.
    expect(decodeLine(encodeLine({ ...request(200), agent: "slopmax" }))).toMatchObject({ agent: "slopmax" })
    expect(() =>
      decodeLine('{"_tag":"Request","at":"2026-10-04T07:20:00Z","provider":"gemini","status":200,"ms":5}'),
    ).toThrow()
  })

  it("record a window that ended with how much of it was used", () => {
    const ended = LedgerRecord.cases.WindowEnded.make({
      at: ts(50_000),
      account: AccountId.make("claude-1a2b3c4d"),
      provider: "claude",
      plan: "max 20x",
      span: "7d",
      used: 61.5,
    })
    const line = encodeLine(ended)
    expect(JSON.parse(line)).toEqual({
      _tag: "WindowEnded",
      at: "1970-01-01T13:53:20Z",
      account: "claude-1a2b3c4d",
      provider: "claude",
      plan: "max 20x",
      span: "7d",
      used: 61.5,
    })
    expect(decodeLine(line)).toEqual(ended)
  })
})

describe("usage views", () => {
  it("decode with every total present, and their tokens add up", () => {
    const totals = new Totals({ ...Totals.zero, input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 1.5 })
    expect(totals.tokens).toBe(18)
    const summary = new Summary({
      range: "7d",
      by: "model",
      since: ts(0),
      rows: [{ key: "gpt-6-sol", totals }],
      total: totals,
    })
    const back = Schema.decodeUnknownSync(Summary)(JSON.parse(JSON.stringify(Schema.encodeSync(Summary)(summary))))
    expect(back).toEqual(summary)
    expect(Schema.decodeUnknownSync(Totals)({})).toEqual(Totals.zero)
    expect(() => Schema.decodeUnknownSync(Summary)({ ...Schema.encodeSync(Summary)(summary), range: "1y" })).toThrow(
      "range is today, 7d, 30d, or all",
    )
  })

  it("chart history and the quota left on the table", () => {
    const history = new History({
      range: "today",
      buckets: [
        {
          label: "14:00",
          tokens: [1_000],
          requests: 3,
          failed: 1,
          rescued: 1,
          sessions: 1,
          cost: 0.2,
          firstByte: [300, 900],
        },
      ],
      providers: ["claude"],
      total: Totals.zero,
      rescued: 1,
      unplaced: 0,
      billed: 0,
      left: LeftOnTheTable.none,
      cacheSaved: 0,
      sessions: 1,
      activity: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
      models: [],
      accounts: [],
      agents: [{ name: "Claude Code", totals: Totals.zero }],
      speeds: [{ model: "claude-opus-5-5", provider: "claude", tokensPerSecond: 80 }],
    })
    const back = Schema.decodeUnknownSync(History)(JSON.parse(JSON.stringify(Schema.encodeSync(History)(history))))
    expect(back).toEqual(history)
    expect(LeftOnTheTable.none.accounts).toEqual([])
  })
})
