// Account status: what `slopmax status` and the app show, and what
// `/slopmax/status` serves.
import { Effect, Schema } from "effect"

import { human, SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"
import { Origins } from "@slopmax/net"
import { Usage } from "@slopmax/wire"

import { Account, type Pins, PinsSchema, type Store } from "./account.ts"
import { httpClient } from "./auth/mod.ts"
import { type Config, type Strategy, StrategySchema } from "./config.ts"
import { chain } from "./error.ts"
import * as fsx from "./fsx.ts"
import { pooledBy, Window, WindowSchema } from "./limits.ts"
import { type Event, EventSchema, nudges, Subject } from "./notify.ts"
import { Home } from "./paths.ts"
import { AccountState, AccountStateSchema, Inner, Pool, Reason, ReasonSchema, State, StateSchema } from "./pool.ts"
import { shares as planShares } from "./pricing.ts"
import { ProviderId, ProviderIdSchema, Spec } from "./provider/mod.ts"
import { byteOrder, Count, F64, list, opt, record } from "./serde.ts"
import { poll } from "./usage.ts"
import { VERSION } from "./version.ts"

/** Where a new session would go, and why, worded for people. */
export const NextReportSchema = Schema.Struct({
  account: Schema.String,
  reason: ReasonSchema,
  why: Schema.String,
})

export type NextReport = typeof NextReportSchema.Type

/**
 * A provider's working accounts (enabled and signed in) read as one: each
 * window's average use, and the soonest reset that frees capacity.
 */
export const PoolReportSchema = Schema.Struct({
  provider: ProviderIdSchema,
  accounts: Count,
  /**
   * The shared windows, then those for one model (a weekly cap on one
   * Claude model), which stop only that model's requests.
   */
  windows: Schema.Array(WindowSchema),
  /** The account a new session would get now, when one can serve. */
  next: opt(NextReportSchema),
  /**
   * Each account's share of the pool's capacity, by id, when every plan's
   * size is known; the windows are then weighted by it. Empty, they are a
   * plain average of the accounts.
   */
  shares: record(F64),
})

export type PoolReport = typeof PoolReportSchema.Type

export const AccountReportSchema = Schema.Struct({
  id: Schema.String,
  provider: ProviderIdSchema,
  name: Schema.String,
  email: opt(Schema.String),
  plan: opt(Schema.String),
  disabled: Schema.Boolean,
  priority: Schema.Int,
  pinned: Schema.Boolean,
  authError: opt(Schema.String),
  /** The tool whose copy of the tokens slopmax follows. */
  follows: opt(Schema.String),
  tokenExpiresAt: opt(TimestampFromString),
  /** For keys and endpoints: where requests go and the models served. */
  endpoint: opt(Schema.String),
  models: list(Schema.String),
  sessions: Count,
  state: AccountStateSchema,
}).pipe(Schema.encodeKeys({ authError: "auth_error", tokenExpiresAt: "token_expires_at" }))

export type AccountReport = typeof AccountReportSchema.Type

export const ReportSchema = Schema.Struct({
  version: Schema.String,
  strategy: StrategySchema,
  /** Whether this came from a running proxy (live sessions and state). */
  live: Schema.Boolean,
  generatedAt: TimestampFromString,
  accounts: Schema.Array(AccountReportSchema),
  /** Each subscription's working accounts read as one, as agents see them. */
  pools: list(PoolReportSchema),
  /**
   * What is worth doing before it is lost: limit resets about to lapse
   * unredeemed, and weeks about to reset with quota to spare.
   */
  nudges: list(EventSchema),
}).pipe(Schema.encodeKeys({ generatedAt: "generated_at" }))

export type Report = typeof ReportSchema.Type

export const Report = {
  /** Adds the nudges (`notify.nudges`) the accounts call for now. */
  withNudges: (self: Report, config: Config, now: Timestamp): Report => {
    const subjects = self.accounts.map(Subject.of)
    const found: ReadonlyArray<Event> = nudges(subjects, config.redeemExpiringCredits, config.planPrices, now).map(
      ([, event]) => event,
    )
    return { ...self, nudges: found }
  },

  /** Says, for each pool, which account the pool (as `inner` has it) would give a new session. */
  withNext: (self: Report, inner: Inner, now: Timestamp): Report => ({
    ...self,
    pools: self.pools.map((report) => {
      const { next: _, ...rest } = report
      const next = Inner.next(inner, report.provider, now)
      return next === undefined
        ? rest
        : { ...rest, next: { account: next.account, reason: next.reason, why: Reason.text(next.reason) } }
    }),
  }),
} as const

/** How a front end colors a window's use or an account's condition, so every one colors them alike. */
export type Tone =
  | "good"
  | "muted"
  /** Worth noticing without being a problem, such as a pin. */
  | "accent"
  | "warn"
  | "bad"

export const Tone = {
  /** For a window's use: a warning from 70%, bad from 90%. */
  ofUse: (used: number): Tone => (used >= 90.0 ? "bad" : used >= 70.0 ? "warn" : "good"),
} as const

/**
 * Where an account stands, most pressing first: what the status column of
 * `slopmax status` and the app shows.
 */
export type Condition =
  /** Its sign-in stopped working; only signing in again fixes it. */
  | { readonly _tag: "SignInNeeded"; readonly error: string }
  | { readonly _tag: "Disabled" }
  /** Out of quota until then. */
  | { readonly _tag: "Limited"; readonly until: Timestamp }
  /** Briefly held back by the provider. */
  | { readonly _tag: "Throttled" }
  /** Serving this many sessions. */
  | { readonly _tag: "Active"; readonly sessions: number }
  | { readonly _tag: "Ready" }

const DISABLED: Condition = { _tag: "Disabled" }
const THROTTLED: Condition = { _tag: "Throttled" }
const READY: Condition = { _tag: "Ready" }

export const Condition = {
  SignInNeeded: (error: string): Condition => ({ _tag: "SignInNeeded", error }),
  Disabled: DISABLED,
  Limited: (until: Timestamp): Condition => ({ _tag: "Limited", until }),
  Throttled: THROTTLED,
  Active: (sessions: number): Condition => ({ _tag: "Active", sessions }),
  Ready: READY,

  /** How it reads, the same in every front end. */
  describe: (self: Condition, now: Timestamp): string => {
    switch (self._tag) {
      case "SignInNeeded":
        return `sign in again (${self.error})`
      case "Disabled":
        return "disabled"
      case "Limited":
        return `limited · back in ${human.until(self.until, now)}`
      case "Throttled":
        return "throttled"
      case "Active":
        return self.sessions === 1 ? "● active · 1 session" : `● active · ${self.sessions} sessions`
      case "Ready":
        return "ready"
    }
  },

  tone: (self: Condition): Tone => {
    switch (self._tag) {
      case "SignInNeeded":
        return "bad"
      case "Disabled":
        return "muted"
      case "Limited":
      case "Throttled":
        return "warn"
      case "Active":
      case "Ready":
        return "good"
    }
  },
} as const

/** A note beside an account's condition. */
export type Note =
  | { readonly _tag: "Pinned" }
  | { readonly _tag: "Priority"; readonly priority: number }
  /** The tool whose copy of the tokens slopmax follows. */
  | { readonly _tag: "Follows"; readonly tool: string }
  | { readonly _tag: "ResetCredits"; readonly credits: number }
  /** Requests served, and the tokens they used. */
  | { readonly _tag: "Served"; readonly requests: number; readonly tokens: number }
  | { readonly _tag: "LastError"; readonly error: string }

const PINNED: Note = { _tag: "Pinned" }

export const Note = {
  Pinned: PINNED,
  Priority: (priority: number): Note => ({ _tag: "Priority", priority }),
  Follows: (tool: string): Note => ({ _tag: "Follows", tool }),
  ResetCredits: (credits: number): Note => ({ _tag: "ResetCredits", credits }),
  Served: (requests: number, tokens: number): Note => ({ _tag: "Served", requests, tokens }),
  LastError: (error: string): Note => ({ _tag: "LastError", error }),

  describe: (self: Note): string => {
    switch (self._tag) {
      case "Pinned":
        return "pinned"
      case "Priority":
        return `priority ${self.priority}`
      case "Follows":
        return `follows ${self.tool}`
      case "ResetCredits":
        return self.credits === 1 ? "1 limit reset" : `${self.credits} limit resets`
      case "Served":
        return `${self.requests} req · ${human.compact(self.tokens)} tok`
      case "LastError":
        return `last error: ${self.error}`
    }
  },

  tone: (self: Note): Tone => (self._tag === "Pinned" || self._tag === "ResetCredits" ? "accent" : "muted"),
} as const

const shared = (windows: ReadonlyArray<Window>, span: string): Window | undefined =>
  windows.find((w) => w.model === undefined && w.span === span)

export const AccountReport = {
  condition: (self: AccountReport, now: Timestamp): Condition => {
    const state = self.state
    if (self.authError !== undefined) return Condition.SignInNeeded(self.authError)
    if (self.disabled) return Condition.Disabled
    const until = AccountState.limitedUntil(state, now)
    if (until !== undefined) return Condition.Limited(until)
    if (state.throttledUntil !== undefined && state.throttledUntil > now) return Condition.Throttled
    if (self.sessions > 0) return Condition.Active(self.sessions)
    return Condition.Ready
  },

  /** The window covering every request over `span` (`5h`, `7d`, `30d`). */
  window: (self: AccountReport, span: string): Window | undefined => shared(self.state.limits.windows, span),

  /** The longer window: the week, or for plans without one, the month. */
  longWindow: (self: AccountReport): Window | undefined =>
    AccountReport.window(self, "7d") ?? AccountReport.window(self, "30d"),

  /** Windows that cover one model only. */
  scopedWindows: (self: AccountReport): ReadonlyArray<Window> =>
    self.state.limits.windows.filter((w) => w.model !== undefined),

  /** The notes beside its condition, in the order front ends show them. */
  notes: (self: AccountReport, now: Timestamp): Array<Note> => {
    const state = self.state
    const notes: Array<Note> = []
    if (self.pinned) notes.push(Note.Pinned)
    if (self.priority !== 0) notes.push(Note.Priority(self.priority))
    if (self.follows !== undefined) notes.push(Note.Follows(self.follows))
    const credits = AccountState.creditsLeft(state, now)
    if (credits !== 0) notes.push(Note.ResetCredits(credits))
    if (state.usage.requests > 0) {
      notes.push(Note.Served(state.usage.requests, Usage.totalTokens(state.usage)))
    }
    // The condition already says when sign-in failed or the account is limited.
    const explained = self.authError !== undefined || AccountState.limitedUntil(state, now) !== undefined
    if (state.lastError !== undefined && !explained) notes.push(Note.LastError(state.lastError))
    return notes
  },
} as const

export const PoolReport = {
  window: (self: PoolReport, span: string): Window | undefined => shared(self.windows, span),

  longWindow: (self: PoolReport): Window | undefined => PoolReport.window(self, "7d") ?? PoolReport.window(self, "30d"),

  /** Windows that cover one model only. */
  scopedWindows: (self: PoolReport): ReadonlyArray<Window> => self.windows.filter((w) => w.model !== undefined),
} as const

/** The status of `accounts`, in their order, with each subscription's pool. */
export const build = (
  accounts: ReadonlyArray<Account>,
  stateOf: (id: string) => AccountState,
  pins: Pins,
  sessions: ReadonlyMap<string, number>,
  strategy: Strategy,
  live: boolean,
  now: Timestamp,
): Report => {
  const reports = accounts.map((a): AccountReport => {
    const spec = ProviderId.spec(a.provider)
    const metered = !Spec.isSubscription(spec)
    const models = a.endpoint !== undefined ? a.endpoint.models : metered ? spec.models : []
    const endpoint = metered ? ProviderId.get(a.provider).api(a) : undefined
    return {
      id: a.id,
      provider: a.provider,
      name: Account.name(a),
      ...(a.email === undefined ? {} : { email: a.email }),
      ...(a.plan === undefined ? {} : { plan: a.plan }),
      disabled: a.disabled,
      priority: a.priority,
      pinned: pins[a.provider] === a.id,
      ...(a.authError === undefined ? {} : { authError: a.authError }),
      ...(a.link === undefined ? {} : { follows: a.link.tool }),
      ...(a.tokens.expiresAt === undefined ? {} : { tokenExpiresAt: a.tokens.expiresAt }),
      ...(endpoint === undefined ? {} : { endpoint }),
      models: [...models],
      sessions: sessions.get(a.id) ?? 0,
      state: stateOf(a.id),
    }
  })
  const pools: Array<PoolReport> = []
  for (const provider of ProviderId.ALL) {
    if (!Spec.isSubscription(ProviderId.spec(provider))) continue
    const report = pool(provider, reports, now)
    if (report !== undefined) pools.push(report)
  }
  return { version: VERSION, strategy, live, generatedAt: now, accounts: reports, pools, nudges: [] }
}

/** See `limits.pooled`. */
const pool = (provider: ProviderId, accounts: ReadonlyArray<AccountReport>, now: Timestamp): PoolReport | undefined => {
  const working = accounts.filter((a) => a.provider === provider && !a.disabled && a.authError === undefined)
  if (working.length === 0) return undefined
  const shares = planShares(
    provider,
    working.map((a) => a.plan),
  )
  const weights = shares ?? working.map(() => 1.0)
  const windows: Array<Window> = pooledBy(
    working.map((a, i) => [a.state.limits, AccountState.isBlocked(a.state, now), weights[i] ?? 1.0] as const),
    now,
  ).map((w) => Window.make(w.span, w.used, w.resetsAt))
  // A model's own window, read as one over the accounts that report it.
  const scoped: Array<readonly [string, string]> = []
  for (const a of working) {
    for (const w of a.state.limits.windows) if (w.model !== undefined) scoped.push([w.span, w.model])
  }
  const distinct = scoped
    .toSorted((x, y) => byteOrder(x[0], y[0]) || byteOrder(x[1], y[1]))
    .filter((pair, i, all) => {
      const previous = all[i - 1]
      return previous === undefined || previous[0] !== pair[0] || previous[1] !== pair[1]
    })
  for (const [span, model] of distinct) {
    const readings: Array<readonly [Window, number]> = []
    working.forEach((a, i) => {
      for (const w of a.state.limits.windows) {
        if (w.span === span && w.model === model) readings.push([w, weights[i] ?? 1.0])
      }
    })
    const weight = readings.reduce((sum, r) => sum + r[1], 0)
    const used = readings.reduce((sum, [w, s]) => sum + Window.usedAt(w, now) * s, 0) / weight
    let resetsAt: Timestamp | undefined
    for (const [w] of readings) {
      if (Window.usedAt(w, now) <= 0) continue
      const reset = Window.upcomingReset(w, now)
      if (reset !== undefined && (resetsAt === undefined || reset < resetsAt)) resetsAt = reset
    }
    windows.push({ ...Window.make(span, used, resetsAt), model })
  }
  const byId: Record<string, number> = {}
  if (shares !== undefined) {
    const pairs = working.map((a, i) => [a.id, shares[i] ?? 0] as const).toSorted(([x], [y]) => byteOrder(x, y))
    for (const [id, share] of pairs) byId[id] = share
  }
  return { provider, accounts: working.length, windows, shares: byId }
}

/**
 * The report from disk when no proxy is running, after polling the
 * providers directly with `refresh`. Failed polls show as the account's
 * last error.
 */
export const offline = Effect.fn("report.offline")(function* (config: Config, store: Store, refresh: boolean) {
  const home = yield* Home.current
  const state: State = (yield* fsx.readJson(home.state(), StateSchema)) ?? State.empty()
  const pins: Pins = (yield* fsx.readJson(home.pins(), PinsSchema)) ?? {}
  const live = yield* Pool.make(config.strategy, SignedDuration.fromHours(1), state)
  yield* live.sync(yield* store.list(), pins)
  if (refresh) {
    const http = yield* httpClient(new Origins())
    const polled = (yield* live.accounts).filter(
      (a) => a.authError === undefined && Spec.isSubscription(ProviderId.spec(a.provider)),
    )
    for (const account of polled) {
      const reading = yield* Effect.result(poll(http, store, account, config.refreshTokens))
      if (reading._tag === "Success") {
        yield* live.observe(account.id, reading.success[1].limits, yield* Timestamp.now)
      } else {
        yield* live.recordError(account.id, `usage poll: ${chain(reading.failure)}`)
      }
    }
    const [snapshot] = yield* live.snapshot(yield* Timestamp.now)
    yield* fsx.writeJson(home.state(), StateSchema, snapshot)
  }
  const now = yield* Timestamp.now
  const inner = yield* live.get
  const report = build(
    yield* store.list(),
    (id) => Inner.state(inner, id),
    pins,
    new Map(),
    config.strategy,
    false,
    now,
  )
  return Report.withNudges(Report.withNext(report, inner, now), config, now)
})
