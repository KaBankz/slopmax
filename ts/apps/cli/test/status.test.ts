import { describe, expect } from "bun:test"
import { Report } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Schema } from "effect"
import { nameWidth, renderReport, reportJson, statusCell, windowCell } from "../src/commands/status.ts"
import { paint } from "../src/print.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const inHours = (hours: number) => DateTime.formatIso(DateTime.add(now, { hours }))
const plain = paint(false)

const account = (fields: Record<string, unknown>) => ({
  provider: "claude",
  disabled: false,
  priority: 0,
  pinned: false,
  models: [],
  sessions: 0,
  condition: { _tag: "Ready" },
  notes: [],
  windows: [],
  resets: [],
  served: {},
  ...fields,
})

const report = (fields: Record<string, unknown>): Report =>
  Schema.decodeUnknownSync(Report)({
    version: "0.4.0",
    live: false,
    generatedAt: DateTime.formatIso(now),
    strategy: "reset-first",
    accounts: [],
    pools: [],
    nudges: [],
    ...fields,
  })

const named = (name: string) => report({ accounts: [account({ id: "x", name })] }).accounts

describe("status", () => {
  it("explains how to add the first account when there is none", () => {
    expect(renderReport(report({}), now, plain)).toEqual([
      "No accounts yet. Connect one with `slopmax login claude` or `slopmax login codex`,",
      "or bring existing logins over with `slopmax import`.",
    ])
  })

  it("shows each account's windows, its plan and how it stands, numbered as `slopmax use` takes them", () => {
    const lines = renderReport(
      report({
        accounts: [
          account({
            id: "claude-1",
            name: "a@x.dev",
            plan: "max 20x",
            windows: [
              { span: "5h", used: 42, resetsAt: inHours(2) },
              { span: "7d", used: 91, resetsAt: inHours(30) },
              { span: "7d", model: "Fable", used: 10, resetsAt: inHours(30) },
            ],
            condition: { _tag: "Limited", until: inHours(2) },
            notes: [{ _tag: "Pinned" }],
          }),
          account({
            id: "codex-1",
            provider: "codex",
            name: "b@x.dev",
            plan: "pro",
            windows: [{ span: "5h", used: 0, resetsAt: inHours(3) }],
          }),
          account({
            id: "openai-1",
            provider: "openai",
            name: "OpenAI API key …abcd",
            models: ["gpt-*", "codex-*", "o1*", "o3*", "o4*"],
          }),
        ],
      }),
      now,
      plain,
    )
    const text = lines.join("\n")
    expect(text).toContain("CLAUDE")
    expect(text).toContain("PLAN       5H                      WEEK                    STATUS")
    expect(text).toContain(
      " 1 a@x.dev                max 20x    ████░░░░░░ 42% 2h00m    █████████░ 91% 1d6h     limited · back in 2h00m · pinned",
    )
    // The weekly cap on one model sits under the week column.
    expect(text).toContain("   └ 7d Fable")
    expect(lines.find((line) => line.includes("└ 7d Fable"))?.indexOf("█")).toBe(
      lines.find((line) => line.includes(" 1 a@x.dev"))?.lastIndexOf("█████████░"),
    )
    // No countdown on a window with nothing used.
    expect(text).toContain(" 2 b@x.dev                pro        ░░░░░░░░░░  0%          —                       ready")
    expect(text).toContain("OPENAI")
    expect(text).toContain("BILLING    MODELS")
    expect(text).toContain(" 3 OpenAI API key …abcd")
    expect(text).toContain("per token  gpt-*, codex-*, o1*, o3*, o4*")
    expect(lines.at(-1)).toBe("strategy reset-first · proxy not running (last known state)")
  })

  it("gives a provider's pool a row of its own when it has more than one account, and names the next", () => {
    const text = renderReport(
      report({
        live: true,
        accounts: [
          account({ id: "claude-1", name: "a@x.dev", windows: [{ span: "5h", used: 20, resetsAt: inHours(1) }] }),
          account({ id: "claude-2", name: "b@x.dev", windows: [{ span: "5h", used: 60, resetsAt: inHours(4) }] }),
        ],
        pools: [
          {
            provider: "claude",
            accounts: 2,
            windows: [{ span: "5h", used: 40, resetsAt: inHours(1), weighted: false }],
            scoped: [{ span: "7d", model: "Fable", used: 5 }],
            shares: {},
            next: { account: "claude-1", reason: "resets-first", why: "its quota resets soonest" },
          },
        ],
        nudges: [
          {
            kind: "quota-unused",
            key: "k",
            message: "a@x.dev's week resets in 3h with 60% unused",
            at: DateTime.formatIso(now),
          },
        ],
      }),
      now,
      plain,
    ).join("\n")
    expect(text).toContain(
      "   pool      2 accts    ████░░░░░░ 40% 1h00m    —                       what the agents see",
    )
    expect(text).toContain("   └ 7d Fable")
    expect(text).toContain("   next session → a@x.dev, its quota resets soonest")
    expect(text).toContain("• a@x.dev's week resets in 3h with 60% unused")
    expect(text).toContain("strategy reset-first · proxy running")
  })

  it("keeps a lone account's pool to itself", () => {
    const text = renderReport(
      report({
        accounts: [account({ id: "claude-1", name: "a@x.dev" })],
        pools: [{ provider: "claude", accounts: 1, windows: [], scoped: [], shares: {} }],
      }),
      now,
      plain,
    ).join("\n")
    expect(text).not.toContain("pool")
  })

  it("sizes the name column to the widest name, within reason", () => {
    expect(nameWidth(named("a"))).toBe(7)
    expect(nameWidth(named("someone@example.com"))).toBe(19)
    expect(nameWidth(named("x".repeat(80)))).toBe(36)
  })

  it("counts a window whose reset has passed as unused, and colors use by how full it is", () => {
    expect(windowCell({ used: 80, resetsAt: DateTime.add(now, { minutes: -1 }) }, now, plain).trim()).toBe(
      "░░░░░░░░░░  0%",
    )
    expect(windowCell({ used: 95 }, now, paint(true))).toContain("\x1b[31m")
    expect(windowCell(undefined, now, plain).trim()).toBe("—")
  })

  it("says a condition and its notes in their tones, joined by dots", () => {
    const [view] = report({
      accounts: [
        account({ id: "c", name: "c", condition: { _tag: "Disabled" }, notes: [{ _tag: "Priority", value: 2 }] }),
      ],
    }).accounts
    if (view === undefined) throw new Error("no account")
    expect(statusCell(view, now, plain)).toBe("disabled · priority 2")
  })

  it("prints the report as JSON in the domain's shape", () => {
    const built = report({ accounts: [account({ id: "claude-1", name: "a@x.dev" })] })
    const parsed: unknown = JSON.parse(reportJson(built))
    expect(Schema.decodeUnknownSync(Report)(parsed)).toEqual(built)
    expect(reportJson(built)).toContain('\n  "accounts": [')
  })
})
