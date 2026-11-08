import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Schema } from "effect"
import {
  AccountId,
  AccountView,
  Condition,
  conditionTone,
  LimitReset,
  NextView,
  Note,
  noteTone,
  Notice,
  PoolView,
  PoolWindow,
  RedeemResult,
  Report,
  toneOfUse,
  Usage,
  Window,
} from "../src/index.ts"
import { conditionText, nextReasonText, noteText } from "../src/format.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const id = (text: string) => AccountId.make(text)

describe("conditions", () => {
  it("conditions read the same in every front end", () => {
    const now = ts(1_000)
    const cases: ReadonlyArray<readonly [Condition, string, string]> = [
      [Condition.cases.SignInNeeded.make({ error: "revoked" }), "sign in again (revoked)", "bad"],
      [Condition.cases.Disabled.make({}), "disabled", "muted"],
      [Condition.cases.Limited.make({ until: ts(1_090) }), "limited · back in 1m30s", "warn"],
      [Condition.cases.Throttled.make({}), "throttled", "warn"],
      [Condition.cases.Active.make({ sessions: 1 }), "● active · 1 session", "good"],
      [Condition.cases.Active.make({ sessions: 3 }), "● active · 3 sessions", "good"],
      [Condition.cases.Ready.make({}), "ready", "good"],
    ]
    for (const [condition, text, tone] of cases) {
      expect(conditionText(condition, now)).toBe(text)
      expect([text, conditionTone(condition)]).toEqual([text, tone])
    }
  })
})

describe("notes", () => {
  it("notes read the same in every front end", () => {
    const cases: ReadonlyArray<readonly [Note, string, string]> = [
      [Note.cases.Pinned.make({}), "pinned", "accent"],
      [Note.cases.Priority.make({ value: -2 }), "priority -2", "muted"],
      [Note.cases.Follows.make({ tool: "cliproxyapi" }), "follows cliproxyapi", "muted"],
      [Note.cases.Resets.make({ count: 1 }), "1 limit reset", "accent"],
      [Note.cases.Resets.make({ count: 4 }), "4 limit resets", "accent"],
      [Note.cases.Served.make({ requests: 12, tokens: 1_500_000 }), "12 req · 1.5M tok", "muted"],
      [Note.cases.LastError.make({ text: "boom" }), "last error: boom", "muted"],
    ]
    for (const [note, text, tone] of cases) {
      expect(noteText(note)).toBe(text)
      expect([text, noteTone(note)]).toEqual([text, tone])
    }
  })
})

describe("tones", () => {
  it("turn use yellow at 70 percent and red at 90", () => {
    expect(toneOfUse(69.9)).toBe("good")
    expect(toneOfUse(70)).toBe("warn")
    expect(toneOfUse(89.9)).toBe("warn")
    expect(toneOfUse(90)).toBe("bad")
  })
})

describe("next reasons", () => {
  it("say in a phrase why a new session would get an account", () => {
    expect(nextReasonText("pinned")).toBe("pinned for new sessions")
    expect(nextReasonText("only-one")).toBe("the only account ready")
    expect(nextReasonText("week-ending")).toBe("its week resets within the day with quota to spare")
    expect(nextReasonText("resets-first")).toBe("its quota resets soonest")
    expect(nextReasonText("fills-first")).toBe("first in priority order")
    expect(nextReasonText("most-room")).toBe("the most room left")
    expect(nextReasonText("turn")).toBe("next in turn")
  })
})

const sampleReport = (): Report => {
  const account = new AccountView({
    id: id("claude-1a2b3c4d"),
    provider: "claude",
    name: "a@x.com",
    email: "a@x.com",
    plan: "max 20x",
    disabled: false,
    priority: 0,
    pinned: true,
    tokenExpiresAt: ts(9_000),
    models: [],
    sessions: 1,
    condition: Condition.cases.Active.make({ sessions: 1 }),
    notes: [Note.cases.Pinned.make({})],
    windows: [Window.of("5h", 25, ts(5_000)), Window.of("7d", 60, undefined, "opus")],
    resets: [new LimitReset({ id: "r1", expiresAt: ts(20_000) })],
    served: new Usage({ requests: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }),
  })
  return new Report({
    version: "0.4.0",
    live: true,
    generatedAt: ts(1_000),
    strategy: "reset-first",
    accounts: [account],
    pools: [
      new PoolView({
        provider: "claude",
        accounts: 1,
        windows: [new PoolWindow({ span: "5h", used: 25, resetsAt: ts(5_000), weighted: false })],
        scoped: [Window.of("7d", 60, undefined, "opus")],
        shares: { [account.id]: 1 },
        next: new NextView({ account: account.id, reason: "pinned", why: nextReasonText("pinned") }),
      }),
    ],
    nudges: [
      new Notice({
        kind: "reset-expiring",
        key: "reset:claude-1a2b3c4d:r1",
        provider: "claude",
        account: "a@x.com",
        until: ts(20_000),
        message: "A limit reset on a@x.com expires; redeem it with `slopmax redeem a@x.com`.",
        at: ts(1_000),
      }),
    ],
  })
}

describe("Report", () => {
  it("survives a JSON round trip", () => {
    const report = sampleReport()
    const json = JSON.stringify(Schema.encodeSync(Report)(report))
    const back = Schema.decodeUnknownSync(Report)(JSON.parse(json))
    expect(back).toEqual(report)
    expect(back.accounts[0]?.windows).toHaveLength(2)
    expect(JSON.stringify(Schema.encodeSync(Report)(back))).toBe(json)
    // Times are RFC 3339 on the wire, and absent fields are left out.
    const encoded = JSON.parse(json)
    expect(encoded.generatedAt).toBe("1970-01-01T00:16:40Z")
    expect("follows" in encoded.accounts[0]).toBe(false)
    expect(encoded.accounts[0].condition).toEqual({ _tag: "Active", sessions: 1 })
  })

  it("carries a redemption's outcome with the report after it", () => {
    const result = new RedeemResult({ outcome: "nothing-to-reset", report: sampleReport() })
    const back = Schema.decodeUnknownSync(RedeemResult)(
      JSON.parse(JSON.stringify(Schema.encodeSync(RedeemResult)(result))),
    )
    expect(back.outcome).toBe("nothing-to-reset")
    expect(() => Schema.decodeUnknownSync(RedeemResult)({ outcome: "maybe", report: {} })).toThrow()
  })
})
