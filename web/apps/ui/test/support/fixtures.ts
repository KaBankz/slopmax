// A believable slopmax to draw: three Claude accounts pooled by plan, two
// ChatGPT accounts (one holding limit resets, one signed out), an API key and
// a local endpoint, with a week of history. Every time is relative to the
// `now` it is given, so tests pin it and the dev server uses the clock.
import {
  AccountId,
  AccountTotals,
  AccountView,
  AgentWiring,
  Condition,
  defaultSettings,
  Finding,
  History,
  HistoryBucket,
  type HistoryRange,
  KeyInfo,
  KeyName,
  LeftAccount,
  LeftOnTheTable,
  LimitReset,
  NamedTotals,
  NextView,
  Note,
  Notice,
  PoolView,
  PoolWindow,
  type ProviderId,
  Report,
  Section,
  settingsView,
  type SettingsView,
  Speed,
  Totals,
  Usage,
  Window,
} from "@slopmax/client"
import { DateTime, Duration } from "effect"

export const ownerKey = "sm-dev-owner-key-0000000000000000000000000000"
export const version = "0.4.0"

const id = (text: string): AccountId => AccountId.make(text)

/** `now` moved by some minutes. */
const shift = (now: DateTime.Utc, minutes: number): DateTime.Utc => DateTime.add(now, { minutes })

const usage = (requests: number, tokens: number): Usage =>
  new Usage({
    requests,
    input: Math.round(tokens * 0.08),
    output: Math.round(tokens * 0.04),
    cacheRead: Math.round(tokens * 0.82),
    cacheWrite: Math.round(tokens * 0.06),
  })

interface AccountSpec {
  readonly id: string
  readonly provider: ProviderId
  readonly name: string
  readonly email?: string
  readonly plan?: string
  readonly condition?: Condition
  readonly windows?: ReadonlyArray<Window>
  readonly resets?: ReadonlyArray<LimitReset>
  readonly notes?: ReadonlyArray<Note>
  readonly pinned?: boolean
  readonly disabled?: boolean
  readonly priority?: number
  readonly follows?: string
  readonly sessions?: number
  readonly lastUsed?: DateTime.Utc
  readonly endpoint?: string
  readonly models?: ReadonlyArray<string>
  readonly served?: Usage
}

export const account = (spec: AccountSpec): AccountView =>
  new AccountView({
    id: id(spec.id),
    provider: spec.provider,
    name: spec.name,
    ...(spec.email === undefined ? {} : { email: spec.email }),
    ...(spec.plan === undefined ? {} : { plan: spec.plan }),
    disabled: spec.disabled ?? false,
    priority: spec.priority ?? 0,
    pinned: spec.pinned ?? false,
    ...(spec.follows === undefined ? {} : { follows: spec.follows }),
    ...(spec.endpoint === undefined ? {} : { endpoint: spec.endpoint }),
    models: spec.models ?? [],
    sessions: spec.sessions ?? 0,
    condition: spec.condition ?? Condition.cases.Ready.make({}),
    notes: spec.notes ?? [],
    windows: spec.windows ?? [],
    resets: spec.resets ?? [],
    ...(spec.lastUsed === undefined ? {} : { lastUsed: spec.lastUsed }),
    served: spec.served ?? Usage.zero,
  })

/** A window that resets `minutes` from now. */
const window = (span: Window["span"], used: number, now: DateTime.Utc, minutes: number, model?: string): Window =>
  Window.of(span, used, shift(now, minutes), model)

const served = (requests: number, tokens: number) => Note.cases.Served.make({ requests, tokens })

/** The accounts of a busy week. */
export const fixtureAccounts = (now: DateTime.Utc): ReadonlyArray<AccountView> => [
  account({
    id: "claude-1a2b3c4d",
    provider: "claude",
    name: "ana@studio.dev",
    email: "ana@studio.dev",
    plan: "max 20x",
    condition: Condition.cases.Active.make({ sessions: 2 }),
    sessions: 2,
    windows: [window("5h", 62, now, 100), window("7d", 48, now, 4_560), window("7d", 71, now, 4_560, "opus")],
    notes: [served(1_284, 48_200_000)],
    lastUsed: shift(now, -2),
    served: usage(1_284, 48_200_000),
  }),
  account({
    id: "claude-5e6f7a8b",
    provider: "claude",
    name: "ben@studio.dev",
    email: "ben@studio.dev",
    plan: "max 5x",
    follows: "Claude Code",
    windows: [window("5h", 18, now, 230), window("7d", 81, now, 1_560), window("7d", 22, now, 1_560, "opus")],
    notes: [Note.cases.Follows.make({ tool: "Claude Code" }), served(342, 9_800_000)],
    lastUsed: shift(now, -47),
    served: usage(342, 9_800_000),
  }),
  account({
    id: "claude-9c0d1e2f",
    provider: "claude",
    name: "ops@studio.dev",
    email: "ops@studio.dev",
    plan: "pro",
    condition: Condition.cases.Limited.make({ until: shift(now, 52) }),
    windows: [window("5h", 100, now, 52), window("7d", 64, now, 6_200)],
    notes: [Note.cases.Priority.make({ value: -1 }), served(611, 12_400_000)],
    priority: -1,
    lastUsed: shift(now, -68),
    served: usage(611, 12_400_000),
  }),
  account({
    id: "codex-3a4b5c6d",
    provider: "codex",
    name: "ana@studio.dev",
    email: "ana@studio.dev",
    plan: "pro",
    windows: [window("5h", 34, now, 170), window("7d", 55, now, 1_190)],
    resets: [
      new LimitReset({
        id: "rst_1",
        title: "Limit reset",
        grantedAt: shift(now, -12_000),
        expiresAt: shift(now, 1_800),
      }),
      new LimitReset({
        id: "rst_2",
        title: "Limit reset",
        grantedAt: shift(now, -3_000),
        expiresAt: shift(now, 13_000),
      }),
    ],
    notes: [Note.cases.Resets.make({ count: 2 }), served(905, 21_700_000)],
    lastUsed: shift(now, -5),
    served: usage(905, 21_700_000),
  }),
  account({
    id: "codex-7e8f9a0b",
    provider: "codex",
    name: "lab@studio.dev",
    email: "lab@studio.dev",
    plan: "plus",
    condition: Condition.cases.SignInNeeded.make({ error: "the refresh token was revoked" }),
    windows: [window("5h", 0, now, 300), window("7d", 12, now, 8_000)],
    lastUsed: shift(now, -2_900),
  }),
  account({
    id: "anthropic-1f2e3d4c",
    provider: "anthropic",
    name: "Team API key",
    notes: [served(57, 1_100_000)],
    lastUsed: shift(now, -180),
    served: usage(57, 1_100_000),
  }),
  account({
    id: "compat-5b6a7980",
    provider: "compat",
    name: "Local models",
    endpoint: "http://127.0.0.1:11434/v1",
    models: ["llama-*", "qwen-*"],
  }),
]

const poolWindow = (span: PoolWindow["span"], used: number, now: DateTime.Utc, minutes: number, weighted: boolean) =>
  new PoolWindow({ span, used, resetsAt: shift(now, minutes), weighted })

export const fixturePools = (now: DateTime.Utc): ReadonlyArray<PoolView> => [
  new PoolView({
    provider: "claude",
    accounts: 3,
    windows: [poolWindow("5h", 54, now, 52, true), poolWindow("7d", 56, now, 1_560, true)],
    scoped: [window("7d", 52, now, 1_560, "opus")],
    shares: { [id("claude-1a2b3c4d")]: 0.66, [id("claude-5e6f7a8b")]: 0.25, [id("claude-9c0d1e2f")]: 0.09 },
    next: new NextView({ account: id("claude-5e6f7a8b"), reason: "resets-first", why: "its quota resets soonest" }),
  }),
  new PoolView({
    provider: "codex",
    accounts: 1,
    windows: [poolWindow("5h", 34, now, 170, false), poolWindow("7d", 55, now, 1_190, false)],
    scoped: [],
    shares: {},
    next: new NextView({ account: id("codex-3a4b5c6d"), reason: "only-one", why: "the only account ready" }),
  }),
]

export const fixtureNudges = (now: DateTime.Utc): ReadonlyArray<Notice> => [
  new Notice({
    kind: "quota-unused",
    key: "quota-unused|codex-3a4b5c6d",
    provider: "codex",
    account: "ana@studio.dev",
    until: shift(now, 1_190),
    message:
      "ana@studio.dev's week resets in 19h50m (19:12) with 45% unused. Point an agent at it with `slopmax run codex`.",
    at: now,
    worth: 90,
  }),
]

export const fixtureReport = (now: DateTime.Utc): Report =>
  new Report({
    version,
    live: true,
    generatedAt: now,
    strategy: "reset-first",
    accounts: fixtureAccounts(now),
    pools: fixturePools(now),
    nudges: fixtureNudges(now),
  })

/** slopmax before any account was added. */
export const emptyReport = (now: DateTime.Utc): Report =>
  new Report({ version, live: true, generatedAt: now, strategy: "reset-first", accounts: [], pools: [], nudges: [] })

// --- History --------------------------------------------------------------------

/** A repeatable wobble in 0..1, so the charts look lived in yet never change between runs. */
const wobble = (n: number): number => (Math.sin(n * 12.9898) * 43_758.5453) % 1

const noise = (n: number): number => Math.abs(wobble(n))

const totals = (fields: Partial<{ [K in keyof Totals]: number }>): Totals =>
  new Totals({
    requests: fields.requests ?? 0,
    input: fields.input ?? 0,
    output: fields.output ?? 0,
    cacheRead: fields.cacheRead ?? 0,
    cacheWrite: fields.cacheWrite ?? 0,
    cost: fields.cost ?? 0,
    unpriced: fields.unpriced ?? 0,
    failed: fields.failed ?? 0,
  })

const scaled = (t: number, requests: number, cost: number, failed = 0): Totals =>
  totals({
    requests,
    input: Math.round(t * 0.08),
    output: Math.round(t * 0.04),
    cacheRead: Math.round(t * 0.82),
    cacheWrite: Math.round(t * 0.06),
    cost,
    failed,
  })

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const bucketLabels = (range: HistoryRange, now: DateTime.Utc): ReadonlyArray<string> => {
  if (range === "today") {
    const hour = DateTime.getPart(DateTime.setZone(now, DateTime.zoneMakeLocal()), "hour")
    return Array.from({ length: hour + 1 }, (_, h) => `${String(h).padStart(2, "0")}:00`)
  }
  const days = range === "7d" ? 7 : 30
  return Array.from({ length: days }, (_, i) =>
    DateTime.formatIntl(DateTime.subtract(now, { days: days - 1 - i }), monthDay),
  )
}

/** A range of history with every chart and table filled in. */
export const fixtureHistory = (range: HistoryRange, now: DateTime.Utc): History => {
  const labels = bucketLabels(range, now)
  const scale = range === "today" ? 0.06 : 1
  const buckets = labels.map((label, i) => {
    const base = range === "today" ? (i >= 8 && i <= 19 ? 1 : 0.15) : i % 7 >= 5 ? 0.35 : 1
    const claude = Math.round(base * scale * (2.2e7 + 1.6e7 * noise(i + 1)))
    const codex = Math.round(base * scale * (0.9e7 + 1.1e7 * noise(i + 50)))
    const anthropic = i % 3 === 0 ? Math.round(base * scale * 6e5 * noise(i + 90)) : 0
    const requests = Math.round((claude + codex + anthropic) / 38_000)
    const failed = noise(i + 7) > 0.8 ? Math.round(1 + 4 * noise(i + 9)) : 0
    const rescued = noise(i + 3) > 0.55 ? Math.round(1 + 6 * noise(i + 4)) : 0
    const cost = ((claude + codex) / 1e6) * 0.62 + (anthropic / 1e6) * 3.1
    return new HistoryBucket({
      label,
      tokens: [claude, codex, anthropic],
      requests,
      failed,
      rescued,
      sessions: Math.max(1, Math.round(requests / 26)),
      cost,
      ...(requests === 0 ? {} : { cached: 0.78 + 0.14 * noise(i + 11) }),
      ...(requests === 0 ? {} : { firstByte: [620 + 380 * noise(i + 13), 1_900 + 2_100 * noise(i + 17)] as const }),
    })
  })
  const sum = (pick: (b: HistoryBucket) => number) => buckets.reduce((s, b) => s + pick(b), 0)
  const tokens = sum((b) => (b.tokens[0] ?? 0) + (b.tokens[1] ?? 0) + (b.tokens[2] ?? 0))
  const total = scaled(
    tokens,
    sum((b) => b.requests),
    sum((b) => b.cost),
    sum((b) => b.failed),
  )
  const claudeTokens = sum((b) => b.tokens[0] ?? 0)
  const codexTokens = sum((b) => b.tokens[1] ?? 0)
  const keyTokens = sum((b) => b.tokens[2] ?? 0)
  const share = (part: number) => Math.round((total.requests * part) / Math.max(1, tokens))
  const activity = Array.from({ length: 7 }, (_row, day) =>
    Array.from({ length: 24 }, (_hour, hour) => {
      const working = day < 5 && hour >= 9 && hour <= 18
      const evening = hour >= 20 && hour <= 23
      const level = working ? 30 : evening ? 9 : day >= 5 && hour >= 11 && hour <= 16 ? 6 : 0
      return Math.round(level * noise(day * 24 + hour + 1))
    }),
  )
  return new History({
    range,
    buckets,
    providers: ["claude", "codex", "anthropic"],
    total,
    rescued: sum((b) => b.rescued),
    unplaced: range === "today" ? 0 : 3,
    billed: (keyTokens / 1e6) * 3.1,
    left:
      range === "today"
        ? LeftOnTheTable.none
        : new LeftOnTheTable({
            windows: range === "7d" ? 2 : 7,
            unused: 31,
            dollars: range === "7d" ? 41.5 : 128,
            unpriced: range === "7d" ? 0 : 1,
            accounts: [
              new LeftAccount({ name: "ben@studio.dev", provider: "claude", windows: 1, unused: 38, dollars: 23.75 }),
              new LeftAccount({ name: "ana@studio.dev", provider: "codex", windows: 1, unused: 24, dollars: 17.75 }),
            ],
          }),
    cacheSaved: total.cost * 2.4,
    cached: 0.86,
    sessions: Math.max(1, Math.round(total.requests / 26)),
    firstByte: 840,
    ...(range === "7d" ? { monthly: total.cost * (30 / 7) } : {}),
    activity,
    models: [
      new NamedTotals({
        name: "claude-sonnet-5",
        totals: scaled(claudeTokens * 0.58, share(claudeTokens * 0.58), total.cost * 0.4),
      }),
      new NamedTotals({
        name: "gpt-6-codex",
        totals: scaled(codexTokens * 0.8, share(codexTokens * 0.8), total.cost * 0.24),
      }),
      new NamedTotals({
        name: "claude-opus-5",
        totals: scaled(claudeTokens * 0.36, share(claudeTokens * 0.36), total.cost * 0.27),
      }),
      new NamedTotals({
        name: "gpt-6-mini",
        totals: scaled(codexTokens * 0.2, share(codexTokens * 0.2), total.cost * 0.04),
      }),
      new NamedTotals({
        name: "claude-haiku-5",
        totals: scaled(claudeTokens * 0.06, share(claudeTokens * 0.06), total.cost * 0.01),
      }),
      new NamedTotals({ name: "claude-sonnet-4-5", totals: scaled(keyTokens, share(keyTokens), total.cost * 0.04) }),
    ],
    accounts: [
      new AccountTotals({
        name: "ana@studio.dev",
        provider: "claude",
        totals: scaled(claudeTokens * 0.62, share(claudeTokens * 0.62), total.cost * 0.45, 2),
      }),
      new AccountTotals({
        name: "ana@studio.dev",
        provider: "codex",
        totals: scaled(codexTokens, share(codexTokens), total.cost * 0.27, 1),
      }),
      new AccountTotals({
        name: "ben@studio.dev",
        provider: "claude",
        totals: scaled(claudeTokens * 0.24, share(claudeTokens * 0.24), total.cost * 0.17),
      }),
      new AccountTotals({
        name: "ops@studio.dev",
        provider: "claude",
        totals: scaled(claudeTokens * 0.14, share(claudeTokens * 0.14), total.cost * 0.07, 4),
      }),
      new AccountTotals({
        name: "Team API key",
        provider: "anthropic",
        totals: scaled(keyTokens, share(keyTokens), total.cost * 0.04),
      }),
    ],
    agents: [
      new NamedTotals({
        name: "Claude Code",
        totals: scaled(claudeTokens + keyTokens, share(claudeTokens + keyTokens), total.cost * 0.7),
      }),
      new NamedTotals({
        name: "Codex",
        totals: scaled(codexTokens * 0.97, share(codexTokens * 0.97), total.cost * 0.29),
      }),
      new NamedTotals({
        name: "Warmups",
        totals: scaled(codexTokens * 0.03, share(codexTokens * 0.03), total.cost * 0.01),
      }),
    ],
    speeds: [
      new Speed({ model: "gpt-6-mini", provider: "codex", tokensPerSecond: 182 }),
      new Speed({ model: "claude-haiku-5", provider: "claude", tokensPerSecond: 141 }),
      new Speed({ model: "claude-sonnet-5", provider: "claude", tokensPerSecond: 78 }),
      new Speed({ model: "gpt-6-codex", provider: "codex", tokensPerSecond: 64 }),
      new Speed({ model: "claude-opus-5", provider: "claude", tokensPerSecond: 41 }),
    ],
  })
}

/** A range nothing went through. */
export const quietHistory = (range: HistoryRange): History =>
  new History({
    range,
    buckets: [],
    providers: [],
    total: Totals.zero,
    rescued: 0,
    unplaced: 0,
    billed: 0,
    left: LeftOnTheTable.none,
    cacheSaved: 0,
    sessions: 0,
    activity: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),

    models: [],
    accounts: [],
    agents: [],
    speeds: [],
  })

// --- Setup ---------------------------------------------------------------------

export const fixtureSettings = (): SettingsView => settingsView(defaultSettings(ownerKey))

export const fixtureKeys = (): ReadonlyArray<KeyInfo> => [
  new KeyInfo({ name: KeyName.make("laptop"), models: [] }),
  new KeyInfo({ name: KeyName.make("ci"), models: ["gpt-*", "claude-haiku-*"] }),
]

export const fixtureAgents = (): ReadonlyArray<AgentWiring> => [
  new AgentWiring({
    id: "claude-code",
    title: "Claude Code",
    installed: true,
    configPath: "~/.claude/settings.json",
    wiredTo: "http://127.0.0.1:7567/claude",
    wired: true,
    backedUp: true,
  }),
  new AgentWiring({
    id: "codex",
    title: "Codex",
    installed: true,
    configPath: "~/.codex/config.toml",
    wired: false,
    backedUp: false,
  }),
]

export const fixtureDoctor = (): ReadonlyArray<Section> => [
  new Section({
    title: "Proxy",
    findings: [
      new Finding({ level: "ok", text: `slopmax ${version} answers on 127.0.0.1:7567` }),
      new Finding({ level: "ok", text: "it starts at login, as a systemd user service" }),
    ],
  }),
  new Section({
    title: "Accounts",
    findings: [
      new Finding({ level: "ok", text: "4 of 5 subscription accounts are signed in" }),
      new Finding({
        level: "warn",
        text: "`lab@studio.dev` (ChatGPT) needs signing in again",
        fix: "slopmax login codex",
      }),
    ],
  }),
  new Section({
    title: "Agents",
    findings: [
      new Finding({ level: "ok", text: "Claude Code goes through slopmax" }),
      new Finding({ level: "info", text: "Codex goes straight to ChatGPT", fix: "slopmax setup codex" }),
    ],
  }),
  new Section({
    title: "Network",
    findings: [
      new Finding({ level: "ok", text: "api.anthropic.com and chatgpt.com answer through the system's roots" }),
    ],
  }),
]

/** How long ago `then` was, for tests that check relative words. */
export const minutesAgo = (now: DateTime.Utc, then: DateTime.Utc): number =>
  Math.round(Duration.toMinutes(DateTime.distance(then, now)))
