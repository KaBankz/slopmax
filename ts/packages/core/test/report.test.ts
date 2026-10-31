import { describe, expect } from "bun:test"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Schema } from "effect"

import { SignedDuration, type Timestamp } from "@slopmax/common"

import { Account, Store, Tokens, without } from "../src/account.ts"
import { Config } from "../src/config.ts"
import { writeJson } from "../src/fsx.ts"
import { Window } from "../src/limits.ts"
import { AccountState, Inner, Pool, Reason, State, StateSchema } from "../src/pool.ts"
import { ProviderId } from "../src/provider/mod.ts"
import {
  AccountReport,
  build,
  Condition,
  Note,
  offline,
  PoolReport,
  Report,
  ReportSchema,
  Tone,
} from "../src/report.ts"
import { VERSION } from "../src/version.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const ts = (secs: number): Timestamp => secs * 1000

const subscription = (provider: ProviderId, email: string): Account =>
  Account.assignId({ ...Account.make(provider, Tokens.empty(), 0), email })

const windowed = (windows: ReadonlyArray<Window>): AccountState => ({
  ...AccountState.empty(),
  limits: { windows },
})

const scoped = (span: string, model: string, used: number, resetsAt: Timestamp | undefined): Window => ({
  ...Window.make(span, used, resetsAt),
  model,
})

const reportOf = (accounts: ReadonlyArray<Account>, states: ReadonlyMap<string, AccountState>): Report =>
  build(accounts, (id) => states.get(id) ?? AccountState.empty(), {}, new Map(), "fill-first", true, ts(1_000))

describe("report", () => {
  it("conditions_put_the_most_pressing_first", () => {
    const now = ts(1_000)
    const account = { ...Account.make("codex", Tokens.empty(), 0), disabled: true, authError: "refresh token rejected" }
    const report = build(
      [account],
      () => ({ ...AccountState.empty(), throttledUntil: ts(1_030) }),
      {},
      new Map(),
      "fill-first",
      false,
      now,
    )
    let a = report.accounts[0] as AccountReport
    expect(AccountReport.condition(a, now)._tag).toBe("SignInNeeded")
    a = without(a, "authError")
    expect(AccountReport.condition(a, now)).toEqual(Condition.Disabled)
    a = { ...a, disabled: false }
    expect(AccountReport.condition(a, now)).toEqual(Condition.Throttled)
    a = { ...a, state: AccountState.empty(), sessions: 2 }
    expect(AccountReport.condition(a, now)).toEqual(Condition.Active(2))
  })

  it("use_turns_yellow_at_70_and_red_at_90_percent", () => {
    expect(Tone.ofUse(69.9)).toBe("good")
    expect(Tone.ofUse(70.0)).toBe("warn")
    expect(Tone.ofUse(90.0)).toBe("bad")
  })

  it("conditions_read_the_same_in_every_front_end", () => {
    const now = ts(1_000)
    const cases: ReadonlyArray<readonly [Condition, string, Tone]> = [
      [Condition.SignInNeeded("revoked"), "sign in again (revoked)", "bad"],
      [Condition.Disabled, "disabled", "muted"],
      [Condition.Limited(ts(1_090)), "limited · back in 1m30s", "warn"],
      [Condition.Throttled, "throttled", "warn"],
      [Condition.Active(1), "● active · 1 session", "good"],
      [Condition.Active(3), "● active · 3 sessions", "good"],
      [Condition.Ready, "ready", "good"],
    ]
    for (const [condition, text, tone] of cases) {
      expect(Condition.describe(condition, now)).toBe(text)
      expect(Condition.tone(condition)).toBe(tone)
    }
  })

  it("notes_read_the_same_in_every_front_end", () => {
    const cases: ReadonlyArray<readonly [Note, string, Tone]> = [
      [Note.Pinned, "pinned", "accent"],
      [Note.Priority(-2), "priority -2", "muted"],
      [Note.Follows("cliproxyapi"), "follows cliproxyapi", "muted"],
      [Note.ResetCredits(1), "1 limit reset", "accent"],
      [Note.ResetCredits(4), "4 limit resets", "accent"],
      [Note.Served(12, 1_500_000), "12 req · 1.5M tok", "muted"],
      [Note.LastError("boom"), "last error: boom", "muted"],
    ]
    for (const [note, text, tone] of cases) {
      expect(Note.describe(note)).toBe(text)
      expect(Note.tone(note)).toBe(tone)
    }
  })

  it("limits_and_idle_accounts_have_their_own_conditions", () => {
    const now = ts(1_000)
    const account = subscription("claude", "a@x.com")
    const full = windowed([Window.make("5h", 100.0, ts(4_600))])
    const report = reportOf([account], new Map([[account.id, full]]))
    let a = report.accounts[0] as AccountReport
    expect(AccountReport.condition(a, now)).toEqual(Condition.Limited(ts(4_600)))
    a = { ...a, state: AccountState.empty() }
    expect(AccountReport.condition(a, now)).toEqual(Condition.Ready)
    // A throttle that has passed no longer counts.
    a = { ...a, state: { ...a.state, throttledUntil: ts(900) } }
    expect(AccountReport.condition(a, now)).toEqual(Condition.Ready)
  })

  it("notes_come_in_order_and_skip_errors_the_condition_explains", () => {
    const now = ts(1_000)
    const account: Account = {
      ...subscription("codex", "a@x.com"),
      priority: 5,
      link: { tool: "cliproxyapi", path: "/tmp/x.json" },
    }
    const state: AccountState = {
      ...AccountState.empty(),
      limits: { windows: [], resetCredits: 2 },
      usage: { requests: 3, inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      lastError: "upstream 500",
    }
    const report = build(
      [account],
      () => state,
      { codex: account.id },
      new Map([[account.id, 2]]),
      "fill-first",
      true,
      now,
    )
    let a = report.accounts[0] as AccountReport
    expect(a.pinned).toBe(true)
    expect(a.sessions).toBe(2)
    expect(a.follows).toBe("cliproxyapi")
    expect(AccountReport.notes(a, now)).toEqual([
      Note.Pinned,
      Note.Priority(5),
      Note.Follows("cliproxyapi"),
      Note.ResetCredits(2),
      Note.Served(3, 1_200),
      Note.LastError("upstream 500"),
    ])

    const lastErrors = (r: AccountReport) => AccountReport.notes(r, now).filter((n) => n._tag === "LastError")
    // Signed out: the condition says so, so the last error is dropped.
    expect(lastErrors({ ...a, authError: "revoked" })).toEqual([])
    // Limited: likewise.
    expect(lastErrors({ ...a, state: { ...a.state, blockedUntil: ts(2_000) } })).toEqual([])

    // A plain account has no notes at all.
    a = without({ ...a, state: AccountState.empty(), pinned: false, priority: 0 }, "follows")
    expect(AccountReport.notes(a, now)).toEqual([])
  })

  it("windows_are_found_by_span_and_scope", () => {
    const account = subscription("claude", "a@x.com")
    const state = windowed([
      Window.make("5h", 10.0, undefined),
      scoped("7d", "opus", 80.0, undefined),
      Window.make("30d", 30.0, undefined),
    ])
    const report = reportOf([account], new Map([[account.id, state]]))
    const a = report.accounts[0] as AccountReport
    expect(AccountReport.window(a, "5h")?.used).toBe(10.0)
    // The model's own weekly window is not the shared one.
    expect(AccountReport.window(a, "7d")).toBeUndefined()
    expect(AccountReport.longWindow(a)?.span).toBe("30d")
    const windows = AccountReport.scopedWindows(a)
    expect(windows.length).toBe(1)
    expect(windows[0]?.model).toBe("opus")
  })

  it("keys_report_their_endpoint_and_models_and_get_no_pool", () => {
    const key = Account.make("xai", { accessToken: "xai-secret" }, 0)
    const compat = Account.assignId({
      ...Account.make("compat", { accessToken: "k" }, 0),
      endpoint: { baseUrl: "http://localhost:1234/v1", dialect: "chat", models: ["llama-*"] },
    })
    const sub = subscription("claude", "a@x.com")
    const report = reportOf([key, compat, sub], new Map())

    const k = report.accounts[0] as AccountReport
    expect(k.endpoint).toBe(ProviderId.spec("xai").api)
    expect(k.models).toEqual([...ProviderId.spec("xai").models])
    const c = report.accounts[1] as AccountReport
    expect(c.endpoint).toBe("http://localhost:1234/v1")
    expect(c.models).toEqual(["llama-*"])
    const s = report.accounts[2] as AccountReport
    expect(s.endpoint).toBeUndefined()
    expect(s.models).toEqual([])

    // Only subscriptions are pooled, and only those with an account.
    expect(report.pools.length).toBe(1)
    expect(report.pools[0]?.provider).toBe("claude")
    expect(report.live).toBe(true)
    expect(report.version).toBe(VERSION)
  })

  it("pools_average_working_accounts_and_their_model_windows", () => {
    const now = ts(1_000)
    const a = subscription("claude", "a@x.com")
    const b = subscription("claude", "b@x.com")
    const off = { ...subscription("claude", "off@x.com"), disabled: true }
    const out = { ...subscription("claude", "out@x.com"), authError: "revoked" }
    const states = new Map<string, AccountState>([
      [
        a.id,
        windowed([
          Window.make("5h", 20.0, ts(5_000)),
          Window.make("7d", 50.0, ts(90_000)),
          scoped("7d", "opus", 60.0, ts(80_000)),
        ]),
      ],
      [
        b.id,
        windowed([
          Window.make("5h", 40.0, ts(3_000)),
          Window.make("7d", 30.0, ts(70_000)),
          // Already reset: counts as unused, and its reset is past.
          scoped("7d", "opus", 90.0, ts(500)),
        ]),
      ],
      // Neither of these may sway the pool.
      [off.id, windowed([Window.make("5h", 100.0, undefined)])],
      [out.id, windowed([Window.make("5h", 100.0, undefined)])],
    ])
    const report = reportOf([a, b, off, out], states)
    expect(report.pools.length).toBe(1)
    const pool = report.pools[0] as PoolReport
    expect(pool.accounts).toBe(2)
    expect(PoolReport.window(pool, "5h")?.used).toBe(30.0)
    expect(PoolReport.longWindow(pool)?.span).toBe("7d")
    const opus = PoolReport.scopedWindows(pool)
    expect(opus.length).toBe(1)
    expect(opus[0]?.model).toBe("opus")
    expect(opus[0]?.used).toBe(30.0)
    expect(opus[0]?.resetsAt).toBe(ts(80_000))
    expect(Window.usedAt(opus[0] as Window, now)).toBeGreaterThan(0.0)

    // A pool with only a monthly window reads it as the long one.
    const c = subscription("codex", "c@x.com")
    const monthly = reportOf([c], new Map([[c.id, windowed([Window.make("30d", 10.0, undefined)])]]))
    expect(PoolReport.longWindow(monthly.pools[0] as PoolReport)?.span).toBe("30d")
  })

  it("a_pool_with_no_working_account_is_left_out", () => {
    const off = { ...subscription("codex", "off@x.com"), disabled: true }
    expect(reportOf([off], new Map()).pools).toEqual([])
  })

  it.effect("with_next_names_the_account_a_new_session_gets_and_why", () =>
    Effect.gen(function* () {
      const now = ts(1_000)
      const a = subscription("claude", "a@x.com")
      const pool = yield* Pool.make("fill-first", SignedDuration.fromHours(1), State.empty())
      yield* pool.sync([a], {})
      const inner = yield* pool.get
      const report = build([a], (id) => Inner.state(inner, id), {}, new Map(), "fill-first", false, now)
      const next = Report.withNext(report, inner, now).pools[0]?.next
      expect(next?.account).toBe(a.id)
      expect(next?.why).toBe(Reason.text(next?.reason ?? "pinned"))
    }),
  )

  it("reports_survive_a_json_round_trip", () => {
    const account = subscription("claude", "a@x.com")
    const state = windowed([Window.make("5h", 25.0, ts(5_000)), scoped("7d", "opus", 60.0, undefined)])
    const report = reportOf([account], new Map([[account.id, state]]))
    const text = JSON.stringify(Schema.encodeSync(ReportSchema)(report))
    const back = Schema.decodeUnknownSync(ReportSchema)(JSON.parse(text))
    expect(back.accounts.length).toBe(1)
    expect(back.accounts[0]?.email).toBe("a@x.com")
    expect(back.accounts[0]?.state.limits.windows.length).toBe(2)
    expect(back.pools[0]?.windows.length).toBe(report.pools[0]?.windows.length)
    expect(JSON.stringify(Schema.encodeSync(ReportSchema)(back))).toBe(text)
  })
})

describe("report, beyond the Rust tests", () => {
  it("reports_are_written_with_rusts_keys_and_omissions", () => {
    const account = subscription("claude", "a@x.com")
    const report = reportOf([account], new Map())
    const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(ReportSchema)(report)))
    expect(Object.keys(encoded)).toEqual(["version", "strategy", "live", "generated_at", "accounts", "pools"])
    expect(Object.keys(encoded.accounts[0])).toEqual([
      "id",
      "provider",
      "name",
      "email",
      "disabled",
      "priority",
      "pinned",
      "sessions",
      "state",
    ])
    expect(encoded.pools[0]).toEqual({ provider: "claude", accounts: 1, windows: [] })
  })

  it("pools_weigh_accounts_by_plan_when_every_plan_is_known", () => {
    const a = { ...subscription("claude", "a@x.com"), plan: "max 20x" }
    const b = { ...subscription("claude", "b@x.com"), plan: "pro" }
    const states = new Map([
      [a.id, windowed([Window.make("5h", 0.0, undefined)])],
      [b.id, windowed([Window.make("5h", 42.0, ts(5_000))])],
    ])
    const pool = reportOf([a, b], states).pools[0] as PoolReport
    expect(PoolReport.window(pool, "5h")?.used).toBeCloseTo(2.0, 9)
    expect(Object.keys(pool.shares)).toEqual([a.id, b.id].toSorted())
    expect(pool.shares[a.id]).toBeCloseTo(20 / 21, 12)
  })

  it.live("offline_reads_the_state_and_pins_from_the_home", () =>
    Effect.gen(function* () {
      const home = tempDir("report")
      const store = Store.at(join(home, "accounts"))
      const a = subscription("claude", "a@x.com")
      yield* store.save(a)
      const state: State = {
        ...State.empty(),
        accounts: { [a.id]: { ...AccountState.empty(), lastError: "boom" } },
      }
      yield* writeJson(join(home, "state.json"), StateSchema, state)
      yield* writeJson(join(home, "pins.json"), Schema.Record(Schema.String, Schema.String), { claude: a.id })
      const config = Config.default()
      const report = yield* offline(config, store, false).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SLOPMAX_HOME: home }))),
      )
      expect(report.live).toBe(false)
      expect(report.accounts[0]?.pinned).toBe(true)
      expect(report.accounts[0]?.state.lastError).toBe("boom")
      expect(report.pools[0]?.next).toEqual({ account: a.id, reason: "pinned", why: "pinned for new sessions" })
    }),
  )
})
