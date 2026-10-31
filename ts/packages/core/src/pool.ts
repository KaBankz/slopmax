// The runtime account pool: health, session affinity, and selection.
//
// Selection is a pure function of in-memory state, so it is fast and easy
// to test. Credentials are re-read from the store per request; the pool only
// tracks which account to use and why.
//
// Two decisions are kept separate, because conflating them is expensive:
//
// - **Placement** picks an account for a new session using the strategy.
// - **Eviction** moves an existing session only when its account can no
//   longer serve (refused, exhausted, disabled, or signed out). Moving a
//   session merely because another account looks cooler throws away the
//   provider-side prompt cache, which costs far more than it saves.
//
// Session affinity can be turned off, for the whole proxy or one request.
// Every request is then placed afresh, which spreads load at the cost of
// the cache, but the session's last account is still remembered: state
// another account minted must be dropped when a request lands elsewhere.
//
// The pool's whole state is a value (`Inner`), changed by the pure
// functions of the same name; `Pool` holds the current one in a
// `SubscriptionRef`, so the daemon and anything else in the process can
// watch it change. Sessions, which grow with use, are a persistent map, so
// a pick costs the same however many there are; the maps keyed by account
// are copied, as each pick already walks the accounts.
import { Context, Data, Effect, HashMap, Layer, Option, Result, Schema, type Stream, SubscriptionRef } from "effect"

import { num, SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"
import { Usage, UsageSchema } from "@slopmax/wire"

import { type Account, type Pins, PinsSchema } from "./account.ts"
import type { Config, Strategy } from "./config.ts"
import { type Lapse, Limits, LimitsSchema, pooledBy, type PoolWindow, UNKNOWN_SCORE, Urgency } from "./limits.ts"
import { shares } from "./pricing.ts"
import { type Credit, CreditSchema } from "./provider/credits.ts"
import { ProviderId, ProviderIdSchema } from "./provider/mod.ts"
import { byteOrder, list, omitWhen, opt, U32, withDefault } from "./serde.ts"

/** How long to sit out an account after a quota refusal without a reset time. */
export const DEFAULT_BLOCK: SignedDuration = SignedDuration.fromMins(5)
/** How long to sit out an account after short-term throttling. */
export const DEFAULT_THROTTLE: SignedDuration = SignedDuration.fromSecs(30)

/** A block that applies to one model only, e.g. an overage-only cap. */
export const ModelBlockSchema = Schema.Struct({
  model: Schema.String,
  until: TimestampFromString,
})

export type ModelBlock = typeof ModelBlockSchema.Type

/** An account's reset credits as listed. */
export const CreditListSchema = Schema.Struct({
  /** Unspent, soonest-expiring first. */
  credits: Schema.Array(CreditSchema),
  listedAt: TimestampFromString,
  /**
   * The count its usage reported when they were listed: a new count means
   * one came or went since.
   */
  counted: opt(U32),
}).pipe(Schema.encodeKeys({ listedAt: "listed_at" }))

export type CreditList = typeof CreditListSchema.Type

const EMPTY_USAGE = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }

/** What the proxy has learned about one account. Persisted between runs. */
export const AccountStateSchema = Schema.Struct({
  limits: withDefault(LimitsSchema, {}),
  /** Quota refused: skip the account until then. */
  blockedUntil: opt(TimestampFromString),
  modelBlocks: list(ModelBlockSchema),
  /** Briefly throttled; other accounts are preferred until then. */
  throttledUntil: opt(TimestampFromString),
  lastUsed: opt(TimestampFromString),
  lastError: opt(Schema.String),
  usage: withDefault(UsageSchema, EMPTY_USAGE),
  /** Its reset credits as last listed, for providers that grant them. */
  credits: opt(CreditListSchema),
}).pipe(
  Schema.encodeKeys({
    blockedUntil: "blocked_until",
    modelBlocks: "model_blocks",
    throttledUntil: "throttled_until",
    lastUsed: "last_used",
    lastError: "last_error",
  }),
)

export type AccountState = typeof AccountStateSchema.Type

const quotaUntil = (self: AccountState, now: Timestamp): Timestamp | undefined =>
  Limits.isExhausted(self.limits, now)
    ? (Limits.exhaustedUntil(self.limits, now) ?? Timestamp.add(now, DEFAULT_BLOCK))
    : undefined

const later = (a: Timestamp | undefined, b: Timestamp | undefined): Timestamp | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

export const AccountState = {
  empty: (): AccountState => ({ limits: Limits.empty(), modelBlocks: [], usage: Usage.zero() }),

  /**
   * Its reset credits that have not expired: from the list, once there is
   * one, else the count its usage reports.
   */
  creditsLeft: (self: AccountState, now: Timestamp): number =>
    self.credits === undefined ? (self.limits.resetCredits ?? 0) : AccountState.unexpiredCredits(self, now).length,

  /** The listed credits that have not expired, soonest-expiring first. */
  unexpiredCredits: (self: AccountState, now: Timestamp): ReadonlyArray<Credit> =>
    (self.credits?.credits ?? []).filter((c) => c.expiresAt === undefined || c.expiresAt > now),

  /** When the account can serve `model` again, or undefined if it can now. */
  blocked: (self: AccountState, model: string | undefined, now: Timestamp): Timestamp | undefined => {
    let until: Timestamp | undefined
    if (self.blockedUntil !== undefined && self.blockedUntil > now) until = self.blockedUntil
    if (self.throttledUntil !== undefined && self.throttledUntil > now) until = later(until, self.throttledUntil)
    const quota = quotaUntil(self, now)
    if (quota !== undefined && quota > now) until = later(until, quota)
    if (model !== undefined) {
      for (const block of self.modelBlocks) {
        if (model === block.model && block.until > now) until = later(until, block.until)
      }
    }
    return until
  },

  /** Whether the account is sitting out for quota reasons (not throttling). */
  isBlocked: (self: AccountState, now: Timestamp): boolean =>
    (self.blockedUntil !== undefined && self.blockedUntil > now) || Limits.isExhausted(self.limits, now),

  /** When an account sitting out for quota reasons is expected back. */
  limitedUntil: (self: AccountState, now: Timestamp): Timestamp | undefined => {
    const block = self.blockedUntil !== undefined && self.blockedUntil > now ? self.blockedUntil : undefined
    return later(block, quotaUntil(self, now))
  },
} as const

/** A live session as `state.json` keeps it. */
const SavedSessionSchema = Schema.Struct({
  provider: ProviderIdSchema,
  session: Schema.String,
  account: Schema.String,
  lastUsed: TimestampFromString,
}).pipe(Schema.encodeKeys({ lastUsed: "last_used" }))

type SavedSession = typeof SavedSessionSchema.Type

/** Each provider's own client, as its user agent was last seen; keyed like `Pins`. */
export type Agents = Pins

/** Persisted runtime state: per-account health and live sessions (`state.json`). */
export const StateSchema = Schema.Struct({
  accounts: withDefault(Schema.Record(Schema.String, AccountStateSchema), {}),
  /** Kept so a restart does not move sessions (and lose their caches). */
  sessions: list(SavedSessionSchema),
  /**
   * Each provider's own client, as its user agent was last seen in a
   * request: Claude answers its limit resets to Claude Code alone.
   */
  agents: omitWhen(PinsSchema, {}, (agents) => Object.keys(agents).length === 0),
})

export type State = typeof StateSchema.Type

export const State = {
  empty: (): State => ({ accounts: {}, sessions: [], agents: {} }),
} as const

/** How the pool places requests; the config's, and changed with it. */
export interface Routing {
  readonly strategy: Strategy
  /** How long a session is remembered after its last request. */
  readonly sessionTtl: SignedDuration
  /** Whether a session stays on its account while that account can serve. */
  readonly affinity: boolean
}

export const Routing = {
  of: (config: Config): Routing => ({
    strategy: config.strategy,
    sessionTtl: SignedDuration.fromMins(Number(config.sessionTtlMins)),
    affinity: config.sessionAffinity,
  }),
} as const

/** A request for an account. */
export interface Pick {
  readonly provider: ProviderId
  /** Conversation id from the agent, used to keep a session on one account. */
  readonly session?: string | undefined
  /** The request's own say on session affinity, over the pool's. */
  readonly affinity?: boolean | undefined
  /**
   * An agent's housekeeping (listing models, counting tokens) rather than
   * work: it takes no turn from round-robin.
   */
  readonly housekeeping?: boolean | undefined
  readonly model?: string | undefined
  /** The accounts that may serve it, when routing narrowed them down. */
  readonly candidates?: ReadonlyArray<string> | undefined
  /** Accounts already tried for this request. */
  readonly exclude?: ReadonlyArray<string> | undefined
}

/** The account chosen for a request. */
export interface Choice {
  readonly account: Account
  /**
   * The account this session used before, when the pick moved it.
   * Account-bound state in the request (e.g. encrypted reasoning) must
   * then be dropped.
   */
  readonly movedFrom: string | undefined
}

/** Why placement would choose an account. */
export const ReasonSchema = Schema.Literals([
  /** Chosen with `slopmax use`. */
  "pinned",
  /** No other account of the provider can serve. */
  "only-ready",
  /** Its week resets within the day with quota to spare (reset-first). */
  "week-ends-soonest",
  /** Its used quota resets soonest (reset-first). */
  "resets-soonest",
  /** The oldest in the top priority tier (fill-first). */
  "first-in-order",
  /** The most room left (least-used, or reset-first among idle ones). */
  "most-room",
  /** Handed a request longest ago (round-robin). */
  "next-in-turn",
])

export type Reason = typeof ReasonSchema.Type

export const Reason = {
  /** Why, in a phrase for people. */
  text: (self: Reason): string => {
    switch (self) {
      case "pinned":
        return "pinned for new sessions"
      case "only-ready":
        return "the only account ready"
      case "week-ends-soonest":
        return "its week resets within the day with quota to spare"
      case "resets-soonest":
        return "its quota resets soonest"
      case "first-in-order":
        return "first in priority order"
      case "most-room":
        return "the most room left"
      case "next-in-turn":
        return "next in turn"
    }
  },
} as const

/** The account a new session would get now, and why. */
export const NextSchema = Schema.Struct({
  account: Schema.String,
  reason: ReasonSchema,
})

export type Next = typeof NextSchema.Type

/** No account can serve the request right now. */
export class Unavailable extends Data.TaggedError("Unavailable")<{
  /** The earliest time some account is expected back, if any. */
  readonly until: Timestamp | undefined
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

/** A session's account and when it was last used. */
interface Binding {
  readonly provider: ProviderId
  readonly session: string
  readonly account: string
  readonly lastUsed: Timestamp
}

/** The key of a session: its provider and its own id. */
const sessionKey = (provider: ProviderId, session: string): string => `${provider}\u0000${session}`

/** An account and a window of it that reset. */
export type AccountLapse = readonly [account: string, lapse: Lapse]

/** Everything the pool knows: what `Pool` holds, as a value. */
export interface Inner {
  readonly routing: Routing
  readonly accounts: ReadonlyArray<Account>
  readonly states: ReadonlyMap<string, AccountState>
  readonly sessions: HashMap.HashMap<string, Binding>
  readonly pins: Pins
  readonly agents: Agents
  /**
   * When each account was last handed a request, as a count of picks:
   * round-robin hands the next to the one handed one longest ago.
   */
  readonly picked: ReadonlyMap<string, number>
  readonly picks: number
  /** Windows that reset since they were last taken, by account, and those already taken. */
  readonly lapses: ReadonlyArray<AccountLapse>
  readonly told: ReadonlyArray<AccountLapse>
  readonly dirty: boolean
}

const usable = (a: Account, provider: ProviderId): boolean =>
  a.provider === provider && !a.disabled && a.authError === undefined

/** `inner` with the state of `id` (the default when it has none) changed by `change`. */
const changeState = (inner: Inner, id: string, change: (state: AccountState) => AccountState): Inner => {
  const states = new Map(inner.states)
  states.set(id, change(inner.states.get(id) ?? AccountState.empty()))
  return { ...inner, states, dirty: true }
}

/** `self` without the optional `key`. */
const omit = <A extends object, K extends keyof A>(self: A, key: K): A => {
  if (!(key in self)) return self
  const copy = { ...self }
  delete copy[key]
  return copy
}

export const Inner = {
  /** A pool restored from `state`: its sessions younger than `sessionTtl`, its health, and the agents seen. */
  make: (strategy: Strategy, sessionTtl: SignedDuration, state: State, now: Timestamp): Inner => {
    const sessions = HashMap.mutate(HashMap.empty<string, Binding>(), (live) => {
      for (const s of state.sessions) {
        if (Timestamp.durationSince(now, s.lastUsed) < sessionTtl) {
          HashMap.set(live, sessionKey(s.provider, s.session), {
            provider: s.provider,
            session: s.session,
            account: s.account,
            lastUsed: s.lastUsed,
          })
        }
      }
    })
    return {
      routing: { strategy, sessionTtl, affinity: true },
      accounts: [],
      states: new Map(Object.entries(state.accounts)),
      sessions,
      pins: {},
      agents: state.agents,
      picked: new Map(),
      picks: 0,
      lapses: [],
      told: [],
      dirty: false,
    }
  },

  /**
   * Replaces the account list (from disk) and pins. Sessions bound to a
   * removed account, or to a provider whose pin changed, are released.
   */
  sync: (self: Inner, accounts: ReadonlyArray<Account>, pins: Pins): Inner => {
    const changedPins = ProviderId.ALL.filter((p) => self.pins[p] !== pins[p])
    const ids = new Set(accounts.map((a) => a.id))
    const sessions = HashMap.filter(
      self.sessions,
      (binding) => ids.has(binding.account) && !changedPins.includes(binding.provider),
    )
    return { ...self, sessions, accounts, pins }
  },

  /** Notes the user agent of a request from `provider`'s own client. */
  sawAgent: (self: Inner, provider: ProviderId, agent: string): Inner =>
    self.agents[provider] === agent ? self : { ...self, agents: { ...self.agents, [provider]: agent }, dirty: true },

  /** Chooses an account for a request. */
  pick: (self: Inner, req: Pick, now: Timestamp): readonly [Result.Result<Choice, Unavailable>, Inner] => {
    const routing = self.routing
    const key = req.session === undefined ? undefined : sessionKey(req.provider, req.session)
    // The account the session used last, kept to even when affinity is
    // off, to tell whether the request moved.
    const binding = key === undefined ? undefined : Option.getOrUndefined(HashMap.get(self.sessions, key))
    const bound =
      binding !== undefined && Timestamp.durationSince(now, binding.lastUsed) < routing.sessionTtl
        ? binding.account
        : undefined
    const sticky = req.affinity ?? routing.affinity

    const candidates = req.candidates
    const serving = self.accounts.filter(
      (a) => usable(a, req.provider) && (candidates === undefined || candidates.includes(a.id)),
    )
    if (serving.length === 0) {
      const reason = self.accounts.some((a) => a.provider === req.provider)
        ? `every ${req.provider} account is disabled or signed out`
        : `no ${req.provider} accounts connected; run \`slopmax login ${req.provider}\``
      return [Result.fail(new Unavailable({ until: undefined, reason })), self]
    }

    // Accounts already tried for this request are skipped, but their
    // blocks still count toward when the pool frees up again.
    const exclude = req.exclude ?? []
    const ready: Array<Account> = []
    let soonest: Timestamp | undefined
    for (const account of serving) {
      const until = AccountState.blocked(self.states.get(account.id) ?? AccountState.empty(), req.model, now)
      if (until === undefined) {
        if (!exclude.includes(account.id)) ready.push(account)
      } else {
        soonest = soonest === undefined ? until : Math.min(soonest, until)
      }
    }

    // Keep the session where it is whenever its account can still serve.
    const pinned = self.pins[req.provider]
    const account =
      (sticky && bound !== undefined ? ready.find((a) => a.id === bound) : undefined) ??
      (pinned === undefined ? undefined : ready.find((a) => a.id === pinned)) ??
      place(routing.strategy, ready, self.states, self.picked, now)

    if (account === undefined) {
      const reason =
        soonest === undefined
          ? `every ${req.provider} account failed this request`
          : `every ${req.provider} account is rate limited`
      return [Result.fail(new Unavailable({ until: soonest, reason })), self]
    }
    const movedFrom = bound !== undefined && bound !== account.id ? bound : undefined
    let next = self
    if (req.housekeeping !== true) {
      const picks = self.picks + 1
      next = { ...next, picks, picked: new Map(self.picked).set(account.id, picks) }
    }
    if (key !== undefined && req.session !== undefined) {
      const sessions = HashMap.set(self.sessions, key, {
        provider: req.provider,
        session: req.session,
        account: account.id,
        lastUsed: now,
      })
      next = { ...next, sessions, dirty: true }
    }
    return [Result.succeed({ account, movedFrom }), next]
  },

  /**
   * The account a new session of `provider` would get now, and why;
   * undefined when none can serve. Nothing changes: this is what `pick`
   * would do for a request with no session.
   */
  next: (self: Inner, provider: ProviderId, now: Timestamp): Next | undefined => {
    const strategy = self.routing.strategy
    const ready = self.accounts.filter((a) => {
      if (!usable(a, provider)) return false
      const state = self.states.get(a.id)
      return state === undefined || AccountState.blocked(state, undefined, now) === undefined
    })
    const pinned = self.pins[provider]
    const pinnedAccount = pinned === undefined ? undefined : ready.find((a) => a.id === pinned)
    if (pinnedAccount !== undefined) return { account: pinnedAccount.id, reason: "pinned" }
    const chosen = place(strategy, ready, self.states, self.picked, now)
    if (chosen === undefined) return undefined
    const top = ready.filter((a) => a.priority === chosen.priority).length
    let reason: Reason
    if (top === 1) reason = "only-ready"
    else if (strategy === "reset-first") {
      const state = self.states.get(chosen.id)
      const urgency = state === undefined ? undefined : Limits.urgency(state.limits, now)
      if (urgency?.weekEnding !== undefined) reason = "week-ends-soonest"
      else if (urgency !== undefined && (urgency.short ?? urgency.long) !== undefined) reason = "resets-soonest"
      else reason = "most-room"
    } else if (strategy === "fill-first") reason = "first-in-order"
    else if (strategy === "least-used") reason = "most-room"
    else reason = "next-in-turn"
    return { account: chosen.id, reason }
  },

  /** Records a successful request: clears throttling and the last error. */
  recordSuccess: (self: Inner, id: string, now: Timestamp): Inner =>
    changeState(self, id, (state) => ({ ...omit(omit(state, "throttledUntil"), "lastError"), lastUsed: now })),

  /** Folds a usage reading into the account's limits. */
  observe: (self: Inner, id: string, limits: Limits, now: Timestamp): Inner => {
    const old = self.states.get(id) ?? AccountState.empty()
    const lapsed = Limits.lapsed(old.limits, limits, now)
    const merged = Limits.merge(old.limits, limits, now)
    let state: AccountState = { ...old, limits: merged }
    // A fresh reading below the limit proves an earlier block has lifted,
    // often well before the advertised reset.
    if (state.blockedUntil !== undefined && !Limits.isExhausted(merged, now)) state = omit(state, "blockedUntil")
    const next = changeState(self, id, () => state)
    return { ...next, lapses: [...self.lapses, ...lapsed.map((lapse): AccountLapse => [id, lapse])] }
  },

  /**
   * The windows that reset since the last call, by account: those readings
   * showed, and those whose time passed with no reading since. A window may
   * be told twice (after a restart, say); readers drop the repeats.
   */
  takeLapses: (self: Inner, now: Timestamp): readonly [ReadonlyArray<AccountLapse>, Inner] => {
    const found: Array<AccountLapse> = [...self.lapses]
    for (const [id, state] of self.states) {
      for (const lapse of Limits.lapsed(state.limits, Limits.empty(), now)) found.push([id, lapse])
    }
    const same = (a: AccountLapse, b: AccountLapse): boolean =>
      a[0] === b[0] && a[1].span === b[1].span && a[1].model === b[1].model && a[1].endedAt === b[1].endedAt
    const taken: Array<AccountLapse> = []
    for (const lapse of found) {
      if (!self.told.some((t) => same(t, lapse)) && !taken.some((t) => same(t, lapse))) taken.push(lapse)
    }
    // Only the recent ones can come round again.
    const weekAgo = Timestamp.sub(now, SignedDuration.fromHours(24 * 8))
    const told = [...self.told, ...taken].filter(([, l]) => l.endedAt > weekAgo)
    return [taken, { ...self, lapses: [], told }]
  },

  /** Sits an account out after a quota refusal. Deadlines only extend. */
  block: (self: Inner, id: string, until: Timestamp, model: string | undefined, reason: string): Inner =>
    changeState(self, id, (state) => {
      let next: AccountState
      if (model !== undefined) {
        const modelBlocks = state.modelBlocks.filter((b) => b.model !== model || b.until > until)
        if (!modelBlocks.some((b) => b.model === model)) modelBlocks.push({ model, until })
        next = { ...state, modelBlocks }
      } else {
        next = { ...state, blockedUntil: later(state.blockedUntil, until) ?? until }
      }
      return { ...next, lastError: reason }
    }),

  /** Briefly prefers other accounts after throttling. */
  throttle: (self: Inner, id: string, until: Timestamp): Inner =>
    changeState(self, id, (state) => ({ ...state, throttledUntil: later(state.throttledUntil, until) ?? until })),

  /** Notes a non-quota failure for display. */
  recordError: (self: Inner, id: string, error: string): Inner =>
    changeState(self, id, (state) => ({ ...state, lastError: error })),

  /** Records the account's reset credits as just listed. */
  recordCredits: (self: Inner, id: string, credits: ReadonlyArray<Credit>, now: Timestamp): Inner =>
    changeState(self, id, (state) => {
      const counted = state.limits.resetCredits
      return {
        ...state,
        credits: counted === undefined ? { credits, listedAt: now } : { credits, listedAt: now, counted },
      }
    }),

  /**
   * Records that an account's windows were just reset by redeeming
   * `credit`, or one the provider chose: lifts every block and zeroes its
   * usage until the next reading, and takes the credit off its list.
   */
  recordReset: (self: Inner, id: string, now: Timestamp, credit: string | undefined): Inner =>
    changeState(self, id, (old) => {
      const base = omit(omit(omit(old, "blockedUntil"), "throttledUntil"), "lastError")
      const windows = old.limits.windows.map((w) => ({ ...omit(w, "resetsAt"), used: 0 }))
      const resetCredits = old.limits.resetCredits
      const limits: Limits = {
        ...old.limits,
        windows,
        observedAt: now,
        ...(resetCredits === undefined ? {} : { resetCredits: Math.max(0, resetCredits - 1) }),
      }
      let credits = old.credits
      if (credits !== undefined) {
        const at = credit === undefined ? -1 : credits.credits.findIndex((c) => c.id === credit)
        if (at >= 0) {
          const counted = credits.counted
          credits = {
            ...credits,
            credits: credits.credits.filter((_, i) => i !== at),
            ...(counted === undefined ? {} : { counted: Math.max(0, counted - 1) }),
          }
        } else {
          // Which one went is unknown, so the list is due again.
          credits = omit(credits, "counted")
        }
      }
      return {
        ...base,
        modelBlocks: [],
        limits,
        ...(credits === undefined ? {} : { credits }),
      }
    }),

  /**
   * Lifts the account's blocks and throttling, so the next request tries it
   * again; a refusal sets it aside anew if its quota is still spent.
   * Returns the models whose blocks were lifted.
   */
  clearBlocks: (self: Inner, id: string): readonly [ReadonlyArray<string>, Inner] => {
    const models = (self.states.get(id)?.modelBlocks ?? []).map((b) => b.model)
    const next = changeState(self, id, (state) => ({
      ...omit(omit(state, "blockedUntil"), "throttledUntil"),
      modelBlocks: [],
    }))
    return [models, next]
  },

  addUsage: (self: Inner, id: string, usage: Usage): Inner =>
    changeState(self, id, (state) => ({ ...state, usage: Usage.add(state.usage, usage) })),

  /** The provider's working accounts read as one account: see `limits.pooled`. */
  pooled: (self: Inner, provider: ProviderId, now: Timestamp): ReadonlyArray<PoolWindow> => {
    const working = self.accounts.filter((a) => usable(a, provider))
    const weights =
      shares(
        provider,
        working.map((a) => a.plan),
      ) ?? working.map(() => 1.0)
    const unknown = AccountState.empty()
    return pooledBy(
      working.map((a, i) => {
        const state = self.states.get(a.id) ?? unknown
        return [state.limits, AccountState.isBlocked(state, now), weights[i] ?? 1.0] as const
      }),
      now,
    )
  },

  state: (self: Inner, id: string): AccountState => self.states.get(id) ?? AccountState.empty(),

  /** A copy of all state, plus whether it changed since the last call. */
  snapshot: (self: Inner, now: Timestamp): readonly [readonly [State, boolean], Inner] => {
    // Before the first sync every account is unknown; keep all state.
    const known = (id: string): boolean => self.accounts.length === 0 || self.accounts.some((a) => a.id === id)
    const states = new Map<string, AccountState>()
    const kept: Array<readonly [string, AccountState]> = []
    for (const [id, state] of self.states) {
      const modelBlocks = state.modelBlocks.filter((b) => b.until > now)
      const pruned = modelBlocks.length === state.modelBlocks.length ? state : { ...state, modelBlocks }
      states.set(id, pruned)
      if (known(id)) kept.push([id, pruned])
    }
    const accounts: Record<string, AccountState> = {}
    for (const [id, state] of kept.toSorted(([a], [b]) => byteOrder(a, b))) accounts[id] = state
    const ttl = self.routing.sessionTtl
    const sessions = HashMap.filter(self.sessions, (b) => Timestamp.durationSince(now, b.lastUsed) < ttl)
    const saved: Array<SavedSession> = []
    for (const b of HashMap.values(sessions)) {
      saved.push({ provider: b.provider, session: b.session, account: b.account, lastUsed: b.lastUsed })
    }
    const agents: Agents = {}
    for (const p of ProviderId.ALL) {
      const agent = self.agents[p]
      if (agent !== undefined) agents[p] = agent
    }
    return [[{ accounts, sessions: saved, agents }, self.dirty], { ...self, states, sessions, dirty: false }]
  },

  /** How many live sessions each account serves, for display. */
  sessionCounts: (self: Inner, now: Timestamp): ReadonlyMap<string, number> => {
    const ttl = self.routing.sessionTtl
    const counts = new Map<string, number>()
    for (const binding of HashMap.values(self.sessions)) {
      if (Timestamp.durationSince(now, binding.lastUsed) < ttl) {
        counts.set(binding.account, (counts.get(binding.account) ?? 0) + 1)
      }
    }
    return counts
  },
} as const

/** The pool shared by the proxy and its background tasks, watched through `changes`. */
export class Pool {
  private constructor(private readonly ref: SubscriptionRef.SubscriptionRef<Inner>) {}

  /** A pool restored from `state` (sessions younger than `sessionTtl`, as of the clock's now). */
  static readonly make = Effect.fn("Pool.make")(function* (
    strategy: Strategy,
    sessionTtl: SignedDuration,
    state: State,
  ) {
    const now = yield* Timestamp.now
    return new Pool(yield* SubscriptionRef.make(Inner.make(strategy, sessionTtl, state, now)))
  })

  /** The pool as it is now. */
  get get(): Effect.Effect<Inner> {
    return SubscriptionRef.get(this.ref)
  }

  /** The pool now, then each change to it. */
  get changes(): Stream.Stream<Inner> {
    return SubscriptionRef.changes(this.ref)
  }

  private read<A>(f: (inner: Inner) => A): Effect.Effect<A> {
    return Effect.map(SubscriptionRef.get(this.ref), f)
  }

  // A change that leaves the pool as it was is not published.
  private change(f: (inner: Inner) => Inner): Effect.Effect<void> {
    return SubscriptionRef.updateSome(this.ref, (inner) => {
      const next = f(inner)
      return next === inner ? Option.none() : Option.some(next)
    })
  }

  private modify<A>(f: (inner: Inner) => readonly [A, Inner]): Effect.Effect<A> {
    return SubscriptionRef.modifySome(this.ref, (inner) => {
      const [a, next] = f(inner)
      return [a, next === inner ? Option.none() : Option.some(next)]
    })
  }

  get routing(): Effect.Effect<Routing> {
    return this.read((inner) => inner.routing)
  }

  /**
   * Places requests from now on as `routing` says. Sessions already bound
   * keep their accounts, if affinity is still on.
   */
  setRouting(routing: Routing): Effect.Effect<void> {
    return this.change((inner) => ({ ...inner, routing }))
  }

  /**
   * Replaces the account list (from disk) and pins. Sessions bound to a
   * removed account, or to a provider whose pin changed, are released.
   */
  sync(accounts: ReadonlyArray<Account>, pins: Pins): Effect.Effect<void> {
    return this.change((inner) => Inner.sync(inner, accounts, pins))
  }

  get accounts(): Effect.Effect<ReadonlyArray<Account>> {
    return this.read((inner) => inner.accounts)
  }

  get pins(): Effect.Effect<Pins> {
    return this.read((inner) => inner.pins)
  }

  /** The user agent of `provider`'s own client, as last seen in a request. */
  agent(provider: ProviderId): Effect.Effect<string | undefined> {
    return this.read((inner) => inner.agents[provider])
  }

  /** Notes the user agent of a request from `provider`'s own client. */
  sawAgent(provider: ProviderId, agent: string): Effect.Effect<void> {
    return this.change((inner) => Inner.sawAgent(inner, provider, agent))
  }

  /** Chooses an account for a request. */
  pick(req: Pick, now: Timestamp): Effect.Effect<Choice, Unavailable> {
    return Effect.flatMap(
      this.modify((inner) => Inner.pick(inner, req, now)),
      Effect.fromResult,
    )
  }

  /** The account a new session of `provider` would get now, and why. */
  next(provider: ProviderId, now: Timestamp): Effect.Effect<Next | undefined> {
    return this.read((inner) => Inner.next(inner, provider, now))
  }

  /** Records a successful request: clears throttling and the last error. */
  recordSuccess(id: string, now: Timestamp): Effect.Effect<void> {
    return this.change((inner) => Inner.recordSuccess(inner, id, now))
  }

  /** Folds a usage reading into the account's limits. */
  observe(id: string, limits: Limits, now: Timestamp): Effect.Effect<void> {
    return this.change((inner) => Inner.observe(inner, id, limits, now))
  }

  /** The windows that reset since the last call, by account. */
  takeLapses(now: Timestamp): Effect.Effect<ReadonlyArray<AccountLapse>> {
    return this.modify((inner) => Inner.takeLapses(inner, now))
  }

  /** Sits an account out after a quota refusal. Deadlines only extend. */
  block(id: string, until: Timestamp, model: string | undefined, reason: string): Effect.Effect<void> {
    return this.change((inner) => Inner.block(inner, id, until, model, reason))
  }

  /** Briefly prefers other accounts after throttling. */
  throttle(id: string, until: Timestamp): Effect.Effect<void> {
    return this.change((inner) => Inner.throttle(inner, id, until))
  }

  /** Notes a non-quota failure for display. */
  recordError(id: string, error: string): Effect.Effect<void> {
    return this.change((inner) => Inner.recordError(inner, id, error))
  }

  /** Records the account's reset credits as just listed. */
  recordCredits(id: string, credits: ReadonlyArray<Credit>, now: Timestamp): Effect.Effect<void> {
    return this.change((inner) => Inner.recordCredits(inner, id, credits, now))
  }

  /** Records that an account's windows were just reset by redeeming `credit`, or one the provider chose. */
  recordReset(id: string, now: Timestamp, credit: string | undefined): Effect.Effect<void> {
    return this.change((inner) => Inner.recordReset(inner, id, now, credit))
  }

  /** Lifts the account's blocks and throttling; returns the models whose blocks were lifted. */
  clearBlocks(id: string): Effect.Effect<ReadonlyArray<string>> {
    return this.modify((inner) => Inner.clearBlocks(inner, id))
  }

  addUsage(id: string, usage: Usage): Effect.Effect<void> {
    return this.change((inner) => Inner.addUsage(inner, id, usage))
  }

  /** The provider's working accounts read as one account. */
  pooled(provider: ProviderId, now: Timestamp): Effect.Effect<ReadonlyArray<PoolWindow>> {
    return this.read((inner) => Inner.pooled(inner, provider, now))
  }

  state(id: string): Effect.Effect<AccountState> {
    return this.read((inner) => Inner.state(inner, id))
  }

  /** A copy of all state, plus whether it changed since the last call. */
  snapshot(now: Timestamp): Effect.Effect<readonly [State, boolean]> {
    return this.modify((inner) => Inner.snapshot(inner, now))
  }

  /** How many live sessions each account serves, for display. */
  sessionCounts(now: Timestamp): Effect.Effect<ReadonlyMap<string, number>> {
    return this.read((inner) => Inner.sessionCounts(inner, now))
  }
}

/** The daemon's pool, for the code that serves requests and the tasks that watch it. */
export class LivePool extends Context.Service<LivePool, Pool>()("@slopmax/core/pool/LivePool") {
  static layer(strategy: Strategy, sessionTtl: SignedDuration, state: State): Layer.Layer<LivePool> {
    return Layer.effect(LivePool, Pool.make(strategy, sessionTtl, state))
  }
}

// `Option<Timestamp>` order: None first.
const compareOption = (a: Timestamp | undefined, b: Timestamp | undefined): number =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a - b

const compareKeys = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The first of `items` with the smallest key, as `Iterator::min_by` keeps the first. */
const minBy = <A>(items: ReadonlyArray<A>, compare: (a: A, b: A) => number): A | undefined => {
  let best: A | undefined
  for (const item of items) if (best === undefined || compare(item, best) < 0) best = item
  return best
}

/**
 * Placement for a session without a usable binding: the strategy's choice
 * within the top priority tier of `ready`.
 */
const place = (
  strategy: Strategy,
  ready: ReadonlyArray<Account>,
  states: ReadonlyMap<string, AccountState>,
  picked: ReadonlyMap<string, number>,
  now: Timestamp,
): Account | undefined => {
  if (ready.length === 0) return undefined
  const top = Math.max(...ready.map((a) => a.priority))
  const tier = ready.filter((a) => a.priority === top)
  const limits = (a: Account): Limits => states.get(a.id)?.limits ?? Limits.empty()
  const lastUsed = (a: Account): Timestamp | undefined => states.get(a.id)?.lastUsed
  const score = (a: Account): number => Limits.score(limits(a), now)

  switch (strategy) {
    // Store order is priority then age, so the first ready account is the
    // one to keep filling.
    case "fill-first":
      return minBy(tier, (a, b) => a.addedAt - b.addedAt)
    // Earliest-deadline-first over spare capacity: an account whose window
    // resets soon loses its unused quota at that reset, while an idle
    // account loses nothing by waiting. Ties go to the less used.
    case "reset-first": {
      const keyed = tier.map((a) => ({ a, deadline: Urgency.key(Limits.urgency(limits(a), now)), score: score(a) }))
      return minBy(
        keyed,
        (x, y) =>
          compareKeys(x.deadline, y.deadline) ||
          num.totalCmp(x.score, y.score) ||
          compareOption(lastUsed(x.a), lastUsed(y.a)),
      )?.a
    }
    case "least-used": {
      const keyed = tier.map((a) => ({ a, score: score(a) }))
      return minBy(keyed, (x, y) => num.totalCmp(x.score, y.score) || compareOption(lastUsed(x.a), lastUsed(y.a)))?.a
    }
    // Each in turn: the one handed a request longest ago, oldest account
    // first among those never handed one.
    case "round-robin":
      return minBy(tier, (a, b) => (picked.get(a.id) ?? 0) - (picked.get(b.id) ?? 0) || a.addedAt - b.addedAt)
  }
}

/** Whether an account has never been measured. */
export const isUnmeasured = (state: AccountState, now: Timestamp): boolean =>
  Limits.score(state.limits, now) >= UNKNOWN_SCORE
