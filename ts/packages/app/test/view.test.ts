import { describe, expect } from "bun:test"

import { it } from "@slopmax/test"

import {
  Account,
  type agent,
  Config,
  config as configs,
  daemon,
  type limits,
  type notify,
  type pool,
  report,
  type service,
  time,
  Tokens,
} from "@slopmax/core"

import { Doctor, Proxy, Setting, type SignIn, type Snapshot, Step } from "../src/lib.ts"
import * as view from "../src/view.ts"

type Timestamp = time.Timestamp
const { SignedDuration } = time
type Window = limits.Window

const ts = (secs: number): Timestamp => secs * 1_000

const window = (span: string, used: number, resetsAt: number): Window => ({ span, used, resetsAt: ts(resetsAt) })

const stateOf = (windows: ReadonlyArray<Window>, now: Timestamp): pool.AccountState => ({
  limits: { windows, observedAt: now },
  modelBlocks: [],
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
})

/** Claude accounts with these windows each. */
const reportOf = (now: Timestamp, list: ReadonlyArray<readonly [string, ReadonlyArray<Window>]>): report.Report => {
  const made = list.map(
    ([email, windows]) =>
      [Account.assignId({ ...Account.make("claude", Tokens.empty(), now), email, orgId: email }), windows] as const,
  )
  const windows = new Map(made.map(([a, w]) => [a.id, w] as const))
  return report.build(
    made.map(([a]) => a),
    (id) => stateOf(windows.get(id) ?? [], now),
    {},
    new Map(),
    "fill-first",
    true,
    now,
  )
}

const reportAt = (now: Timestamp): report.Report =>
  reportOf(
    now,
    (
      [
        ["a@x.dev", 80.0],
        ["b@x.dev", 20.0],
      ] as const
    ).map(([email, used]) => [email, [window("5h", used, 4_600), window("7d", 10.0, 90_000)]] as const),
  )

const first = <A>(list: ReadonlyArray<A>): A => {
  const head = list[0]
  if (head === undefined) throw new Error("empty")
  return head
}

const at = <A>(list: ReadonlyArray<A>, i: number): A => {
  const item = list[i]
  if (item === undefined) throw new Error(`nothing at ${i}`)
  return item
}

// Edits the report's accounts, as the Rust tests assign to them.
const withAccount = (
  self: report.Report,
  i: number,
  change: (a: report.AccountReport) => report.AccountReport,
): report.Report => ({ ...self, accounts: self.accounts.map((a, j) => (j === i ? change(a) : a)) })

const withPool = (self: report.Report, change: (p: report.PoolReport) => report.PoolReport): report.Report => ({
  ...self,
  pools: self.pools.map((p, j) => (j === 0 ? change(p) : p)),
})

const snapshot = (proxy: Proxy): Snapshot => ({
  proxy,
  address: "http://127.0.0.1:7567",
  report: undefined,
  agents: [],
  service: undefined,
  signIn: undefined,
  notice: undefined,
  history: undefined,
  today: undefined,
  redeeming: undefined,
  config: Config.default(),
  notifications: true,
  newKey: undefined,
  doctor: Doctor.NotRun,
})

const percents = (row: view.Row): Array<string | undefined> => row.limits.map((g) => g?.percent)

const say = (c: Config): string | undefined => view.autoRedeem(c, "ChatGPT")

const agentWith = (wiring: agent.Wiring) => ({ id: "codex", title: "Codex", wiring })

const serviceStatus = (installed: boolean, running: boolean): service.Status => ({
  installed,
  running,
  lingering: undefined,
})

const signingIn = (step: Step): SignIn => ({ provider: "claude", step, notes: ["That address was not it."] })

describe("view", () => {
  it("groups_carry_gauges_status_and_the_pool", () => {
    const now = ts(1_000)
    const groups = view.groups(reportAt(now), now)
    expect(groups.length).toBe(1)
    const claude = first(groups)
    expect(claude.title).toBe("Claude")
    expect(claude.limits).toEqual(["5-hour", "Weekly"])
    expect(claude.accounts.length).toBe(2)
    const busy = first(claude.accounts)
    const fiveHour = first(busy.limits)
    expect(fiveHour?.percent).toBe("80%")
    expect(fiveHour?.resetsIn).toBe("1h00m")
    expect(fiveHour?.tone).toBe("warn")
    expect(busy.status.text).toBe("ready")
    expect(claude.working).toBe(2)
    const pool = first(claude.overview)
    expect(pool.title).toBe("5-hour")
    expect(pool.gauge.percent).toBe("50%")
    expect(pool.shares.map((s) => s.fraction)).toEqual([0.8, 0.2])
  })

  it("a_window_for_one_model_gets_a_column_after_the_shared_ones", () => {
    const now = ts(1_000)
    const fable: Window = { ...window("7d", 30.0, 90_000), model: "Fable" }
    const self = reportOf(now, [
      ["a@x.dev", [fable, window("5h", 10.0, 4_600)]],
      ["b@x.dev", [window("7d", 5.0, 90_000)]],
    ])
    const claude = first(view.groups(self, now))
    expect(claude.limits).toEqual(["5-hour", "Weekly", "Weekly · Fable"])
    expect(percents(at(claude.accounts, 0))).toEqual(["10%", undefined, "30%"])
    expect(percents(at(claude.accounts, 1))).toEqual([undefined, "5%", undefined])
  })

  it("resets_read_on_the_local_clock", () => {
    // 1970-01-01 00:16:40 UTC, a Thursday.
    const now = ts(1_000)
    const utc = SignedDuration.ZERO
    expect(view.clock(ts(1_000 + 22 * 3_600), now, utc)).toBe("22:16")
    expect(view.clock(ts(1_000 + 2 * 86_400), now, utc)).toBe("Sat 00:16")
    expect(view.clock(ts(1_000 + 10 * 86_400), now, utc)).toBe("Jan 11")
    // Five hours west, `now` is still Wednesday evening, so 00:16 UTC the
    // next morning lands on Thursday there.
    const west = SignedDuration.fromSecs(-5 * 3_600)
    expect(view.clock(ts(1_000 + 5 * 3_600), now, west)).toBe("Thu 00:16")
  })

  it("pace_compares_use_with_an_even_spend", () => {
    const now = ts(100_000)
    // Halfway through a 5-hour window.
    const half = (used: number): Window => window("5h", used, 100_000 + 9_000)
    const label = (used: number): view.Label => {
      const found = view.pace(half(used), used, now)
      if (found === undefined) throw new Error("no pace")
      return found.label
    }
    expect(view.pace(half(50), 50, now)?.elapsed).toBe(0.5)
    expect(label(52).text).toBe("On pace")
    expect(label(20).text).toBe("30% in reserve")
    const ahead = label(70)
    expect(ahead.text.startsWith("Runs out ~")).toBe(true)
    expect(ahead.tone).toBe("warn")
    // Too soon to say, and nothing left to pace.
    expect(view.pace(window("5h", 10, 100_000 + 17_900), 10, now)).toBeUndefined()
    expect(view.pace(half(100), 100, now)).toBeUndefined()
  })

  it("last_use_reads_coarsely", () => {
    const now = ts(100_000)
    expect(view.ago(ts(99_990), now)).toBe("used just now")
    expect(view.ago(ts(100_000 - 180), now)).toBe("used 3m ago")
    expect(view.ago(ts(100_000 - 7_300), now)).toBe("used 2h ago")
    expect(view.ago(ts(100_000 - 200_000), now)).toBe("used 2d ago")
  })

  it("reset_credits_show_their_dates_and_what_they_clear", () => {
    // Midday, so the dates hold on any local clock.
    const day = 86_400
    const noon = (n: number): number => n * day + day / 2
    const now = ts(noon(100))
    const account = Account.assignId({
      ...Account.make("codex", Tokens.empty(), now),
      email: "c@x.dev",
      accountId: "c",
    })
    const credit = (id: string, granted: number, expires: number) => ({
      id,
      grantedAt: ts(granted),
      expiresAt: ts(expires),
    })
    const state: pool.AccountState = {
      ...stateOf([window("5h", 100.0, noon(100) + 3_600), window("7d", 64.0, noon(102))], now),
      limits: {
        windows: [window("5h", 100.0, noon(100) + 3_600), window("7d", 64.0, noon(102))],
        observedAt: now,
        resetCredits: 2,
      },
      credits: {
        credits: [credit("soon", noon(71), noon(102)), credit("later", noon(99), noon(129))],
        listedAt: now,
        counted: 2,
      },
    }
    const self = report.build([account], () => state, {}, new Map(), "fill-first", true, now)
    const chatgpt = first(view.groups(self, now))
    expect(chatgpt.credits).toBe("2 limit resets · the next expires in 2d0h")
    const row = first(chatgpt.accounts)
    // Shown apart from the notes, where they can be redeemed.
    expect(row.notes.every((n) => !n.text.includes("reset"))).toBe(true)
    const credits = row.credits
    if (credits === undefined) throw new Error("no credits")
    expect(credits.title).toBe("2 limit resets")
    expect(credits.clears).toBe("5-hour and weekly")
    expect(credits.held).toBeUndefined()
    const soon = at(credits.credits, 0)
    expect(soon.left).toBe("in 2d0h")
    expect(soon.granted).toBe("Granted Mar 13")
    expect(soon.tone).toBe("warn")
    const later = at(credits.credits, 1)
    expect(later.expires).toBe("Expires May 10")
    expect(later.granted).toBe("Granted yesterday")
    expect(later.tone).toBe("muted")
  })

  it("status_and_attention_say_what_wants_a_look", () => {
    const now = ts(10_000)
    let self = reportOf(now, [
      ["out@x.dev", [window("5h", 10.0, 10_000 + 9_000)]],
      // Ninety percent used with three of five hours to go.
      ["busy@x.dev", [window("5h", 90.0, 10_000 + 10_800)]],
      ["calm@x.dev", [window("5h", 10.0, 10_000 + 9_000)]],
    ])
    self = withAccount(self, 0, (a) => ({ ...a, authError: "revoked" }))
    self = withAccount(self, 2, (a) => ({ ...a, disabled: true }))
    const status = view.status(self, now)
    expect(status.headline).toBe("1 of 2 accounts are ready")
    expect(status.detail).toBe("1 needs signing in · 1 turned off")
    expect(status.tone).toBe("bad")

    const found = view.attention(self, now).map((a) => [a.text, a.remedy] as const)
    // The signed-out account first; a turned-off one wants nothing.
    expect(found[0]).toEqual(["out@x.dev needs signing in again", "SignIn"])
    expect(found.length).toBe(2)
    expect(at(found, 1)[0].startsWith("busy@x.dev's 5-hour window runs out ~")).toBe(true)
    expect(at(found, 1)[1]).toBe("Look")

    expect(view.status({ ...self, accounts: [] }, now).headline).toBe("No accounts yet")
  })

  it("the_menu_bar_shows_each_pool", () => {
    const now = ts(1_000)
    expect(view.menuBar(reportAt(now), now)).toBe("Claude 50%")
    // Once the window resets, its use is gone.
    expect(view.menuBar(reportAt(now), ts(5_000))).toBe("Claude 0%")
  })

  it("a_pool_says_where_new_sessions_go", () => {
    const now = ts(1_000)
    let self = reportAt(now)
    const b = at(self.accounts, 1).id
    self = withPool(self, (p) => ({
      ...p,
      next: { account: b, reason: "resets-soonest", why: "its quota resets soonest" },
    }))
    const group = first(view.groups(self, now))
    expect(group.next).toEqual({ text: "New sessions → b@x.dev · its quota resets soonest", tone: "muted" })
    expect(group.nextShort.text).toBe("New sessions → b · its quota resets soonest")
    expect(group.accounts.map((row) => row.next)).toEqual([false, true])
  })

  it("with_no_account_free_it_says_when_one_is_back", () => {
    const now = ts(1_000)
    // No preview of the next session: nothing can take one.
    const group = first(view.groups(reportAt(now), now))
    expect(group.next.tone).toBe("warn")
    expect(group.next.text).toBe("No account can take a new session")
    expect(group.accounts.every((row) => !row.next)).toBe(true)

    const limited = reportOf(now, [
      ["a@x.dev", [window("5h", 100.0, 4_600)]],
      ["b@x.dev", [window("5h", 100.0, 9_000)]],
    ])
    const line = first(view.groups(limited, now)).next
    expect(line.text.startsWith("No account can take a new session until ")).toBe(true)
    expect(line.text.endsWith(", when a@x.dev is back")).toBe(true)
  })

  it("a_pin_reads_in_the_status_and_use_says_its_period", () => {
    const now = ts(1_000)
    let self = reportAt(now)
    self = withAccount(self, 0, (a) => ({
      ...a,
      pinned: true,
      state: {
        ...a.state,
        usage: {
          requests: 120,
          inputTokens: 5_000_000,
          outputTokens: 150_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 50_000,
        },
      },
    }))
    self = withAccount(self, 1, (a) => ({ ...a, disabled: true }))
    const rows = first(view.groups(self, now)).accounts
    expect(at(rows, 0).status.text).toBe("ready · pinned")
    expect(at(rows, 0).notes.map((n) => n.text)).toEqual(["120 requests, 5.2M tokens all time"])
    expect(view.grouped(1_312)).toBe("1,312")
    expect(view.grouped(999)).toBe("999")
    expect(view.grouped(1_000_000)).toBe("1,000,000")
    expect(at(rows, 1).status.text).toBe("disabled")
  })

  it("nudges_join_what_wants_a_look_once", () => {
    const now = ts(1_000)
    const nudge = (event: notify.Kind, account: string, message: string): notify.Event => ({
      event,
      provider: "claude",
      account,
      until: ts(60_000),
      message,
      at: now,
    })
    const self: report.Report = {
      ...reportAt(now),
      nudges: [
        nudge(
          "quota-unused",
          "b@x.dev",
          "b@x.dev's week resets in 19h59m (19:12) with 79% of it unused, about $4 of its plan. Work sent there before then costs nothing extra.",
        ),
        nudge(
          "reset-expiring",
          "a@x.dev",
          "A limit reset on a@x.dev expires in 18h (18:10); redeem it with `slopmax redeem a@x.dev` before it is lost.",
        ),
        nudge("quota-unused", "nobody@x.dev", "Gone."),
      ],
    }
    const items = view.attention(self, now)
    const unused = items.find((a) => a.remedy === "Look")
    if (unused === undefined) throw new Error("no unused nudge")
    // Its words are the window's own, its time with the day it falls on, as
    // every other line has it.
    expect(unused.text.startsWith("b@x.dev's week resets in 16h23m · ")).toBe(true)
    expect(unused.text.endsWith(" with 90% of it unused")).toBe(true)
    expect(unused.who).toBe("b")
    expect(unused.what).toBe("week ends in 16h23m, 90% unused")
    // Amber, as on the dashboard.
    expect(unused.tone).toBe("warn")
    expect(unused.account).toBe(at(self.accounts, 1).id)
    const reset = items.find((a) => a.remedy === "Redeem")
    if (reset === undefined) throw new Error("no reset nudge")
    expect(reset.text.includes("`")).toBe(false)
    expect(reset.account).toBe(at(self.accounts, 0).id)
    // An account it cannot find is left out.
    expect(items.length).toBe(2)
  })

  it("a_reset_already_offered_is_not_offered_twice", () => {
    const now = ts(1_000)
    const self: report.Report = {
      ...reportAt(now),
      nudges: [
        {
          event: "reset-expiring",
          provider: "claude",
          account: "a@x.dev",
          until: ts(60_000),
          message: "A limit reset on a@x.dev expires soon.",
          at: now,
        },
      ],
    }
    const already: view.Attention = {
      provider: "claude",
      account: at(self.accounts, 0).id,
      text: "already offered",
      who: "a",
      what: "reset expires in 1h",
      tone: "warn",
      remedy: "Redeem",
    }
    const found = [already]
    view.addNudges(found, self, now)
    expect(found).toEqual([already])
    // Without it, the nudge is offered.
    const fresh: Array<view.Attention> = []
    view.addNudges(fresh, self, now)
    expect(fresh.length).toBe(1)
    expect(first(fresh).remedy).toBe("Redeem")
  })

  it("advanced_settings_step_and_read", () => {
    expect(view.step(view.SESSION_TTL_STEPS, 60, true)).toBe(120)
    expect(view.step(view.SESSION_TTL_STEPS, 60, false)).toBe(30)
    // Set by hand between two steps, it goes to the nearer one each way.
    expect(view.step(view.SESSION_TTL_STEPS, 45, true)).toBe(60)
    expect(view.step(view.SESSION_TTL_STEPS, 45, false)).toBe(30)
    expect(view.step(view.SESSION_TTL_STEPS, 1_440, true)).toBeUndefined()
    expect(view.step(view.POLL_STEPS, 0, false)).toBeUndefined()
    expect(view.step(view.POLL_STEPS, 0, true)).toBe(1)
    expect(view.minutes(45)).toBe("45 min")
    expect(view.minutes(120)).toBe("2 h")
    expect(view.minutes(1_440)).toBe("1 day")
    expect(view.liveDetail("session_ttl_mins")).toBe("Idle minutes before a session's account is forgotten.")
    expect(view.liveDetail("no_such_setting")).toBe("")
    expect(view.settingChanged(Setting.PollMins(0))).toBe("slopmax no longer polls usage.")
    expect(view.settingChanged(Setting.SessionTtlMins(120))).toBe("A session keeps its account through 2 h idle.")
    for (const setting of [
      Setting.WarmWindows(true),
      Setting.WarmWindows(false),
      Setting.PaidOverflow(true),
      Setting.PaidOverflow(false),
      Setting.PollMins(5),
    ]) {
      expect(view.settingChanged(setting).endsWith(".")).toBe(true)
    }
  })

  it("what_resets_left_reads_as_a_line", () => {
    expect(view.leftLine(0, 0)).toBe("No weekly window reset in this range")
    expect(view.leftLine(1, 38.4)).toBe("1 weekly window · 38% unused")
    expect(view.leftLine(4, 26)).toBe("4 weekly windows · 26% unused on average across them")
  })

  it("a_weighted_pool_sizes_its_segments_by_plan", () => {
    const now = ts(1_000)
    let self = reportAt(now)
    let group = first(view.groups(self, now))
    expect(group.weighted).toBe(false)
    expect(view.poolBasis(group)).toBe("average of accounts")
    expect(first(group.overview).shares.every((s) => s.weight === 1.0)).toBe(true)

    const [a, b] = [at(self.accounts, 0).id, at(self.accounts, 1).id]
    self = withPool(self, (p) => ({ ...p, shares: { [a]: 20.0 / 25.0, [b]: 5.0 / 25.0 } }))
    group = first(view.groups(self, now))
    expect(group.weighted).toBe(true)
    expect(view.poolBasis(group)).toBe("weighted by plan")
    expect(view.segmentsTip(group).includes("plan")).toBe(true)
    expect(first(group.overview).shares.map((s) => s.weight)).toEqual([0.8, 0.2])
  })

  it("plans_read_in_title_case_and_a_followed_login_names_its_tool", () => {
    const now = ts(1_000)
    const self = withAccount(reportAt(now), 0, (a) => ({ ...a, plan: "max 20x", follows: "Claude Code" }))
    const rows = first(view.groups(self, now)).accounts
    expect(at(rows, 0).plan).toBe("Max 20x")
    expect(at(rows, 0).follows).toBe("Claude Code")
    expect(at(rows, 1).follows).toBeUndefined()
  })

  it("small_words_for_the_access_page_and_ranges", () => {
    expect(view.patterns("claude-*, gpt-6-sol  local-*,,")).toEqual(["claude-*", "gpt-6-sol", "local-*"])
    expect(view.patterns("  ")).toEqual([])
    expect(view.rangeTitle("week")).toBe("7 days")
    expect(view.rangeTitle("month")).toBe("30 days")
    expect(view.levelTone("ok")).toBe("good")
    expect(view.levelTone("note")).toBe("muted")
    expect(view.levelTone("warn")).toBe("warn")
    expect(view.levelTone("fail")).toBe("bad")
  })

  it("the_menu_bar_without_pools_shows_the_name", () => {
    expect(view.menuBar(reportOf(ts(1_000), []), ts(1_000))).toBe("slopmax")
  })

  it("every_strategy_has_a_name_and_a_sentence", () => {
    expect(configs.Strategy.ALL.map(view.strategyTitle)).toEqual([
      "Reset first",
      "Fill first",
      "Least used",
      "Round robin",
    ])
    for (const strategy of configs.Strategy.ALL) {
      const detail = view.strategyDetail(strategy)
      expect(detail.endsWith(".") && !detail.endsWith("..")).toBe(true)
      expect(detail.startsWith(configs.Strategy.summary(strategy))).toBe(true)
    }
  })

  it("routing_reads_as_a_line", () => {
    const config = Config.default()
    expect(view.routing(config)).toBe("Reset first · sessions keep their account")
    expect(view.routing({ ...config, strategy: "round-robin", sessionAffinity: false })).toBe(
      "Round robin · sessions move between accounts",
    )
  })

  it("changing_a_setting_says_what_it_does_now", () => {
    expect(view.settingChanged(Setting.Strategy("fill-first"))).toBe("slopmax now routes fill first.")
    const said = [
      Setting.SessionAffinity(true),
      Setting.SessionAffinity(false),
      Setting.RedeemExpiringCredits(true),
      Setting.RedeemExpiringCredits(false),
      Setting.RedeemWhenExhausted(true),
      Setting.RedeemWhenExhausted(false),
    ].map(view.settingChanged)
    said.forEach((text, i) => {
      expect(text.endsWith(".")).toBe(true)
      // Not said twice.
      expect(said.slice(0, i).includes(text)).toBe(false)
    })
    expect(view.AFFINITY.includes("prompt cache")).toBe(true)
    expect(view.AFFINITY_HEADER.includes("x-slopmax-affinity")).toBe(true)
    const lead = SignedDuration.asSecs(daemon.CREDIT_EXPIRY_LEAD) / 3_600
    expect(view.redeemExpiringDetail().includes(`${lead} hours`)).toBe(true)
  })

  it("auto_redeem_follows_the_config", () => {
    let config: Config = { ...Config.default(), redeemExpiringCredits: false, redeemWhenExhausted: false }
    expect(say(config)).toBeUndefined()
    config = { ...config, redeemWhenExhausted: true }
    expect(say(config)).toBe("slopmax redeems one by itself when every ChatGPT account is spent.")
    config = { ...config, redeemExpiringCredits: true }
    const both = say(config) ?? ""
    expect(both.includes("every ChatGPT account is spent") && both.includes("hours before")).toBe(true)
    config = { ...config, redeemWhenExhausted: false }
    const expiring = say(config) ?? ""
    expect(expiring.includes("before it would expire unused")).toBe(true)
    expect(expiring.includes("spent")).toBe(false)
  })

  it("lists_read_as_english", () => {
    expect(view.listed([])).toBe("")
    expect(view.listed(["a"])).toBe("a")
    expect(view.listed(["a", "b"])).toBe("a and b")
    expect(view.listed(["a", "b", "c"])).toBe("a, b, and c")
  })

  it("the_proxy_line_says_how_it_stands", () => {
    expect(view.proxyLine(snapshot(Proxy.Running("0.3.0")))).toBe("Running 0.3.0 at http://127.0.0.1:7567")
    expect(view.proxyLine(snapshot(Proxy.Stopped))).toBe("Stopped: agents cannot reach slopmax")
    expect(view.proxyLine(snapshot(Proxy.Checking))).toBe("Looking for the proxy…")
    expect(view.proxyLine(snapshot(Proxy.Starting))).toBe("Starting the proxy…")
  })

  it("agents_and_the_service_read_plainly", () => {
    expect(view.agentLine(agentWith({ _tag: "Slopmax" }))).toEqual(["Goes through slopmax", true])
    expect(view.agentLine(agentWith({ _tag: "Elsewhere", target: "http://elsewhere" }))).toEqual([
      "Goes to http://elsewhere",
      false,
    ])
    expect(view.agentLine(agentWith({ _tag: "Direct" }))[1]).toBe(false)

    // With no service manager, the switch is off and cannot change.
    const none = view.login(undefined)
    expect(!none.on && !none.available).toBe(true)
    expect(none.detail.includes("no login service")).toBe(true)
    const on = view.login(serviceStatus(true, true))
    expect(on.on && on.available).toBe(true)
    expect(on.detail.startsWith("Runs the proxy whenever you log in")).toBe(true)
    expect(view.login(serviceStatus(true, false)).detail.includes("not running now")).toBe(true)
    const off = view.login(serviceStatus(false, false))
    expect(!off.on && off.available).toBe(true)
  })

  it("a_sign_in_says_what_to_do_next", () => {
    const starting = view.signIn(signingIn(Step.Starting))
    expect(starting.title).toBe("Signing in to Claude")
    expect(starting.notes).toBe("That address was not it.")
    expect([starting.link, starting.code]).toEqual([undefined, undefined])

    const url = "https://example.invalid/authorize"
    const opened = view.signIn(signingIn(Step.Authorize(url, true)))
    expect(opened.detail.includes("in your browser")).toBe(true)
    expect(opened.link).toBe(url)
    const closed = view.signIn(signingIn(Step.Authorize(url, false)))
    expect(closed.detail.startsWith("Open this address")).toBe(true)

    const device = view.signIn(signingIn(Step.DeviceCode(url, "ABCD-1234")))
    expect(device.code).toBe("ABCD-1234")
    expect(device.link).toBeUndefined()
    expect(device.detail.includes(url)).toBe(true)
  })
})

describe("view, beyond the Rust tests", () => {
  it("the status headline counts what is ready", () => {
    const now = ts(1_000)
    const self = reportAt(now)
    expect(view.status(self, now)).toEqual({ headline: "All 2 accounts are ready", detail: undefined, tone: "good" })
    const one = reportOf(now, [["a@x.dev", [window("5h", 10, 4_600)]]])
    expect(view.status(one, now).headline).toBe("Your account is ready")
    const off = withAccount(one, 0, (a) => ({ ...a, disabled: true }))
    expect(view.status(off, now)).toEqual({
      headline: "Every account is turned off",
      detail: "1 turned off",
      tone: "good",
    })
    const limited = reportOf(now, [
      ["a@x.dev", [window("5h", 100, 4_600)]],
      ["b@x.dev", [window("5h", 10, 4_600)]],
    ])
    expect(view.status(limited, now)).toEqual({
      headline: "1 of 2 accounts are ready",
      detail: "1 limited",
      tone: "warn",
    })
  })

  it("past days read as a date, the week ahead by its weekday", () => {
    const now = ts(10 * 86_400 + 43_200)
    const utc = SignedDuration.ZERO
    expect(view.clock(ts(9 * 86_400 + 43_200), now, utc)).toBe("Jan 10")
    // Six days ahead still names the weekday.
    expect(view.clock(ts(16 * 86_400 + 43_200), now, utc)).toBe("Sat 12:00")
  })

  it("a lone account without a pool has its own overview", () => {
    const now = ts(1_000)
    const self = { ...reportOf(now, [["a@x.dev", [window("5h", 40, 4_600)]]]), pools: [] }
    const group = first(view.groups(self, now))
    expect(first(group.overview).gauge.percent).toBe("40%")
    expect(first(group.overview).gauge.pace).toBeUndefined()
    expect(group.working).toBe(1)
  })
})
