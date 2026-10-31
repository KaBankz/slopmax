import { describe, expect, it } from "bun:test"

import { Account, type limits, pool, report, Tokens, type time } from "@slopmax/core"

import { render } from "../../src/commands/status.ts"

const ts = (secs: number): time.Timestamp => secs * 1000

const claude = (email: string, extra: Partial<Account> = {}): Account =>
  Account.assignId({ ...Account.make("claude", Tokens.empty(), 0), email, orgId: email, ...extra })

const state = (windows: ReadonlyArray<limits.Window>, observedAt: time.Timestamp): pool.AccountState => ({
  ...pool.AccountState.empty(),
  limits: { windows: [...windows], observedAt },
})

describe("commands/status", () => {
  it("pools_get_a_row_of_their_own", () => {
    const now = ts(1_000)
    const accounts = [
      [claude("a@x.dev"), state([{ span: "5h", used: 80.0, resetsAt: ts(4_600) }], now)],
      [claude("b@x.dev"), state([{ span: "5h", used: 20.0, resetsAt: ts(4_600) }], now)],
    ] as const
    const states = new Map(accounts.map(([a, s]) => [a.id, s] as const))
    const r = report.build(
      accounts.map(([a]) => a),
      (id) => states.get(id) ?? pool.AccountState.empty(),
      {},
      new Map(),
      "reset-first",
      true,
      now,
    )
    const text = render(r, now)
    const row = text.split("\n").find((l) => l.includes("pool"))
    expect(row).toContain(" 50%")
    expect(row).toContain("2 accts")
  })

  it("renders_windows_status_and_scoped_limits", () => {
    const account = Account.assignId({
      ...Account.make("claude", Tokens.empty(), 0),
      email: "me@x.dev",
      plan: "max 20x",
      orgId: "org",
    })
    const s = state(
      [
        { span: "5h", used: 100.0, resetsAt: ts(4600) },
        { span: "7d", used: 47.0, resetsAt: ts(90_000) },
        { span: "7d", model: "Fable", used: 58.0, resetsAt: ts(90_000) },
      ],
      ts(1000),
    )
    const r = report.build([account], () => s, {}, new Map(), "reset-first", true, ts(1000))
    const text = render(r, ts(1000))
    expect(text).toContain("CLAUDE")
    expect(text).toContain("me@x.dev")
    expect(text).toContain("max 20x")
    expect(text).toContain("100%")
    expect(text).toContain(" 47%")
    expect(text).toContain("└ 7d Fable")
    expect(text).toContain("limited · back in 1h00m")
  })

  it("empty_report_explains_next_steps", () => {
    const r = report.build([], () => pool.AccountState.empty(), {}, new Map(), "fill-first", false, ts(0))
    expect(render(r, ts(0))).toContain("slopmax login claude")
  })
})

describe("commands/status, beyond the Rust tests", () => {
  it("lays the table out in fixed columns", () => {
    const now = ts(1000)
    const a = claude("me@x.dev", { plan: "pro" })
    const key = Account.make("openai", { accessToken: "sk-1" }, 0)
    const r = report.build(
      [a, key],
      (id) => (id === a.id ? state([{ span: "5h", used: 21, resetsAt: ts(4600) }], now) : pool.AccountState.empty()),
      {},
      new Map(),
      "fill-first",
      false,
      now,
    )
    expect(render(r, now).split("\n")).toEqual([
      "",
      "CLAUDE                    PLAN       5H                      WEEK                    STATUS",
      " 1 me@x.dev               pro        ██░░░░░░░░  21% 1h00m   —                       ready",
      "",
      "OPENAI                    BILLING    MODELS                                          STATUS",
      " 2 OpenAI API key …sk-1   per token  gpt-*, codex-*, o1*, o3*, o4*                   ready",
      "",
      "strategy fill-first · proxy not running (last known state)",
      "",
    ])
  })
})
