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
  PreviousTotals,
  type ProviderId,
  Report,
  Section,
  Speed,
  Totals,
  UpdateView,
  Usage,
  Window,
} from "@slopmax/client"
import { DateTime } from "effect"
import { type FixtureRequest, fixtureRange } from "./requests.ts"

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
    windows: [window("5h", 62, now, 100), window("7d", 48, now, 4_560), window("7d", 71, now, 4_560, "Opus")],
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
    windows: [window("5h", 18, now, 230), window("7d", 81, now, 1_320), window("7d", 22, now, 1_320, "Opus")],
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
    windows: [poolWindow("5h", 54, now, 52, true), poolWindow("7d", 56, now, 1_320, true)],
    scoped: [window("7d", 52, now, 1_320, "Opus")],
    shares: { [id("claude-1a2b3c4d")]: 0.66, [id("claude-5e6f7a8b")]: 0.25, [id("claude-9c0d1e2f")]: 0.09 },
    next: new NextView({
      account: id("claude-5e6f7a8b"),
      reason: "week-ending",
      why: "its week resets within the day with quota to spare",
    }),
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
    key: `unused:codex-3a4b5c6d:7d:${Math.floor(shift(now, 1_190).epochMilliseconds / 1000)}`,
    provider: "codex",
    account: "ana@studio.dev",
    until: shift(now, 1_190),
    message:
      "ana@studio.dev's week resets in 19h50m (19:12) with 45% unused. Point an agent at it with `slopmax run codex`.",
    at: now,
    worth: 200 * (12 / 52) * 0.45,
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
    update: new UpdateView({ version: "0.5.0", command: "slopmax update" }),
  })

/** slopmax before any account was added. */
export const emptyReport = (now: DateTime.Utc): Report =>
  new Report({ version, live: true, generatedAt: now, strategy: "reset-first", accounts: [], pools: [], nudges: [] })

// --- History --------------------------------------------------------------------

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`
const sum = (rows: ReadonlyArray<FixtureRequest>, value: (row: FixtureRequest) => number) =>
  rows.reduce((total, row) => total + value(row), 0)

const summarize = (rows: ReadonlyArray<FixtureRequest>): Totals =>
  new Totals({
    requests: rows.filter((row) => !row.failed).length,
    failed: rows.filter((row) => row.failed).length,
    input: sum(rows, ({ row }) => row.record.usage.input),
    output: sum(rows, ({ row }) => row.record.usage.output),
    cacheRead: sum(rows, ({ row }) => row.record.usage.cacheRead),
    cacheWrite: sum(rows, ({ row }) => row.record.usage.cacheWrite),
    cost: sum(rows, ({ row }) => row.cost ?? 0),
    unpriced: rows.filter(({ failed, row }) => !failed && row.cost === undefined).length,
  })

const cachedShare = (total: Totals) => {
  const input = total.input + total.cacheRead + total.cacheWrite
  return input === 0 ? undefined : total.cacheRead / input
}

const sessionsIn = (rows: ReadonlyArray<FixtureRequest>) =>
  new Set(rows.flatMap(({ row }) => row.record.session ?? [])).size

const waitPercentiles = (rows: ReadonlyArray<FixtureRequest>): readonly [number, number] | undefined => {
  const waits = rows.flatMap(({ row }) => row.record.firstByteMs ?? []).toSorted((a, b) => a - b)
  const median = waits[Math.floor(waits.length * 0.5)]
  const slow = waits[Math.floor(waits.length * 0.95)]
  return median === undefined || slow === undefined ? undefined : [median, slow]
}

const namedTotals = (rows: ReadonlyArray<FixtureRequest>, label: (item: FixtureRequest) => string) =>
  [...Map.groupBy(rows, label)]
    .map(([name, entries]) => new NamedTotals({ name, totals: summarize(entries) }))
    .toSorted((a, b) => b.totals.tokens - a.totals.tokens)

/** Every view uses this same fixture ledger. Quota resets are sampled separately. */
export const fixtureHistory = (range: HistoryRange, now: DateTime.Utc): History => {
  const { since, rows } = fixtureRange(now, range)
  const zone = DateTime.zoneMakeLocal()
  const local = (at: DateTime.Utc) => DateTime.setZone(at, zone)
  const hourOf = (at: DateTime.Utc) => DateTime.getPart(local(at), "hour")
  const bucketLabel = (at: DateTime.Utc) =>
    range === "today" ? hourLabel(hourOf(at)) : DateTime.formatIntl(at, monthDay)
  const labels =
    range === "today"
      ? Array.from({ length: hourOf(now) + 1 }, (_, hour) => hourLabel(hour))
      : Array.from({ length: range === "7d" ? 7 : 30 }, (_, index) =>
          bucketLabel(DateTime.toUtc(DateTime.add(local(since), { days: index }))),
        )
  const providers = (["claude", "codex", "anthropic"] as const).filter((provider) =>
    rows.some(({ row }) => row.record.provider === provider),
  )
  const grouped = Map.groupBy(rows, ({ row }) => bucketLabel(row.record.at))
  const buckets = labels.map((label) => {
    const entries = grouped.get(label) ?? []
    const total = summarize(entries)
    const cached = cachedShare(total)
    const firstByte = waitPercentiles(entries)
    return new HistoryBucket({
      label,
      tokens: providers.map((provider) =>
        sum(entries, (item) => (item.row.record.provider === provider ? item.tokens : 0)),
      ),
      requests: total.requests,
      failed: total.failed,
      rescued: entries.filter(({ rescued }) => rescued).length,
      sessions: sessionsIn(entries),
      cost: total.cost,
      ...(cached === undefined ? {} : { cached }),
      ...(firstByte === undefined ? {} : { firstByte }),
    })
  })
  const total = summarize(rows)
  const cached = cachedShare(total)
  const firstByte = waitPercentiles(rows)?.[0]
  const accounts = fixtureReport(now).accounts
  const activity = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  for (const { failed, row } of rows) {
    if (failed) continue
    const at = new Date(row.record.at.epochMilliseconds)
    const day = activity[(at.getDay() + 6) % 7]
    const hour = at.getHours()
    if (day !== undefined) day[hour] = (day[hour] ?? 0) + 1
  }
  return new History({
    range,
    buckets,
    providers,
    total,
    rescued: rows.filter(({ rescued }) => rescued).length,
    unplaced: rows.filter(({ failed, row }) => failed && row.record.account === undefined).length,
    billed: sum(rows, ({ row }) => (row.record.provider === "anthropic" ? (row.cost ?? 0) : 0)),
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
    cacheSaved: sum(rows, (row) => row.cacheSaved),
    ...(cached === undefined ? {} : { cached }),
    sessions: sessionsIn(rows),
    ...(firstByte === undefined ? {} : { firstByte }),
    ...(range === "7d" ? { monthly: total.cost * (30 / 7) } : {}),
    ...(range === "30d"
      ? {}
      : {
          previous: new PreviousTotals({
            total: new Totals({
              ...total,
              requests: Math.round(total.requests * 0.86),
              input: Math.round(total.input * 0.8),
              output: Math.round(total.output * 0.8),
              cacheRead: Math.round(total.cacheRead * 0.8),
              cacheWrite: Math.round(total.cacheWrite * 0.8),
              cost: total.cost * 1.07,
            }),
            rescued: 4,
            sessions: 20,
          }),
        }),
    activity,
    models: providers.flatMap((provider) =>
      namedTotals(
        rows.filter(({ failed, row }) => !failed && row.record.provider === provider),
        ({ row }) => row.record.model ?? "Other",
      ).map((entry) => new NamedTotals({ ...entry, provider })),
    ),
    accounts: accounts
      .flatMap((entry) => {
        const entries = rows.filter(({ row }) => row.record.account === entry.id)
        return entries.length === 0
          ? []
          : [new AccountTotals({ name: entry.name, provider: entry.provider, totals: summarize(entries) })]
      })
      .toSorted((a, b) => b.totals.tokens - a.totals.tokens),
    agents: namedTotals(
      rows.filter(({ failed }) => !failed),
      ({ row }) =>
        row.record.agent === "slopmax" ? "Warmups" : row.record.agent === "codex" ? "Codex" : "Claude Code",
    ),
    speeds: [
      new Speed({ model: "gpt-6-mini", provider: "codex", tokensPerSecond: 182 }),
      new Speed({ model: "claude-haiku-5-5", provider: "claude", tokensPerSecond: 141 }),
      new Speed({ model: "claude-fable-5-1", provider: "claude", tokensPerSecond: 78 }),
      new Speed({ model: "gpt-6-sol", provider: "codex", tokensPerSecond: 64 }),
      new Speed({ model: "claude-opus-5-5", provider: "claude", tokensPerSecond: 41 }),
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
      new Finding({ level: "info", text: "Codex goes straight to ChatGPT", fix: "slopmax agent connect codex" }),
    ],
  }),
  new Section({
    title: "Network",
    findings: [
      new Finding({ level: "ok", text: "api.anthropic.com and chatgpt.com answer through the system's roots" }),
    ],
  }),
]
