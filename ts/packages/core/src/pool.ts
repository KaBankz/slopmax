// The account pool: what slopmax knows about each account's health, which
// account each agent session is on, and which account a request gets.
//
// Two decisions are kept apart, because mixing them up is expensive:
//
// - Placement picks an account for a new session, by the strategy.
// - A session already placed moves only when its account cannot serve
//   (refused, spent, turned off, or signed out). Moving it because another
//   account looks less used would throw away the provider's prompt cache,
//   which costs far more than it saves.
//
// Session affinity can be turned off for the whole proxy or one request.
// Each request is then placed afresh, but the session's last account is
// still remembered: state another account minted must be dropped when a
// request lands somewhere else.
//
// The model is immutable data and every rule is a pure function over it, so
// placement is fast and tested without services. The `Pool` service holds
// the one live model, signals changes, and saves it to `state.json`.
import {
  type AccountId,
  AccountId as AccountIdSchema,
  exhaustedUntil,
  Instant,
  isExhausted,
  type Lapse,
  lapsed,
  LimitReset,
  Limits,
  merge,
  NextView,
  NonNegativeInt,
  pooled as poolWindows,
  PoolView,
  type PoolWindow,
  ProviderId,
  score,
  type Settings,
  Span,
  staleAfter,
  type Strategy,
  unknownScore,
  urgency,
  type Urgency,
  urgencyOrder,
  Usage,
  Window,
  type WindowEndedRecord,
  withDefault,
} from "@slopmax/domain"
import { nextReasonText } from "@slopmax/domain/format"
import {
  Array as Arr,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  HashMap,
  Layer,
  Option,
  Order,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect"
import type { Account } from "./account.ts"
import { Accounts } from "./accounts.ts"
import { type FileError, Home } from "./home.ts"
import { windowEndedRecords, type WindowHolder } from "./ledger.ts"
import { Told, type ToldSet } from "./notifier.ts"
import { shares } from "./pricing.ts"

// ---------------------------------------------------------------------------
// What is kept about each account

/** How long an account sits out after a quota refusal that names no reset time. */
export const defaultBlock: Duration.Duration = Duration.minutes(5)

/** How long an account sits out after being throttled for a moment. */
export const defaultThrottle: Duration.Duration = Duration.seconds(30)

/** Lapsed windows are remembered this long, so one seen again after a restart is not recorded twice. */
const lapsesKept: Duration.Duration = Duration.days(8)

/** An account's limit resets as last listed. */
export class ResetList extends Schema.Class<ResetList>("ResetList")({
  /** Unspent, in the order the provider spends them. */
  list: Schema.Array(LimitReset),
  listedAt: Instant,
  /**
   * The count the account's usage reported when they were listed. A new
   * count means one came or went since, so the list is due again.
   */
  counted: Schema.optionalKey(NonNegativeInt),
}) {}

/** What slopmax has learned about one account. Kept across restarts. */
export class Health extends Schema.Class<Health>("Health")({
  limits: Limits.pipe(withDefault({})),
  /** Its quota was refused: it sits out until then. */
  blockedUntil: Schema.optionalKey(Instant),
  /** Caps on one model (an overage-only limit), each until its time. */
  modelBlocks: Schema.Record(Schema.String, Instant).pipe(withDefault({})),
  /** Briefly throttled: other accounts serve until then. */
  throttledUntil: Schema.optionalKey(Instant),
  lastUsed: Schema.optionalKey(Instant),
  lastError: Schema.optionalKey(Schema.String),
  /** What it served since slopmax first saw it. */
  served: Usage.pipe(withDefault({})),
  resets: Schema.optionalKey(ResetList),
}) {
  static readonly empty: Health = Schema.decodeUnknownSync(Health)({})
}

/** An agent session and the account it is on. */
export class Session extends Schema.Class<Session>("Session")({
  provider: ProviderId,
  /** The agent's own id for the conversation. */
  id: Schema.String,
  account: AccountIdSchema,
  /** Its last request. */
  at: Instant,
}) {}

/** What the Codex agent last showed of itself: its release (for model lists) and the model it last asked for (for warmups). */
export const CodexSeen = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  lastModel: Schema.optionalKey(Schema.String),
})
export type CodexSeen = typeof CodexSeen.Type

/** `state.json`: everything the pool keeps across restarts. Every field has a default, so older and partial files load. */
export class SavedState extends Schema.Class<SavedState>("SavedState")({
  health: Schema.Record(AccountIdSchema, Health).pipe(withDefault({})),
  /** Kept so a restart does not move sessions and lose their prompt caches. */
  sessions: Schema.Array(Session).pipe(withDefault([])),
  /** Round-robin's memory: the turn each account was last handed a request on. */
  turns: Schema.Record(AccountIdSchema, NonNegativeInt).pipe(withDefault({})),
  /** The account `slopmax use` chose for each provider's new sessions. */
  pins: Schema.Record(ProviderId, Schema.optionalKey(AccountIdSchema)).pipe(withDefault({})),
  /** Each provider's own agent, as its user agent was last seen: Claude answers its limit resets to Claude Code alone. */
  agents: Schema.Record(ProviderId, Schema.optionalKey(Schema.String)).pipe(withDefault({})),
  codex: CodexSeen.pipe(withDefault({})),
  /** Each notice told, and when it stops mattering. */
  told: Schema.Record(Schema.String, Instant).pipe(withDefault({})),
  /** Windows already recorded as ended, and when each ended. */
  lapsed: Schema.Record(Schema.String, Instant).pipe(withDefault({})),
}) {
  static readonly empty: SavedState = Schema.decodeUnknownSync(SavedState)({})
}

type Pins = SavedState["pins"]
type Agents = SavedState["agents"]

/** An account's quota resets left: the unexpired ones listed, once listed, else the count its usage reports. */
export const resetsLeft = (health: Health, now: DateTime.Utc): number =>
  health.resets === undefined ? (health.limits.resetCredits ?? 0) : unexpiredResets(health, now).length

/** The listed limit resets that have not expired, in spend order. */
export const unexpiredResets = (health: Health, now: DateTime.Utc): ReadonlyArray<LimitReset> =>
  (health.resets?.list ?? []).filter(
    (reset) => reset.expiresAt === undefined || DateTime.isGreaterThan(reset.expiresAt, now),
  )

const later = (a: DateTime.Utc | undefined, b: DateTime.Utc | undefined): DateTime.Utc | undefined =>
  a === undefined ? b : b === undefined ? a : DateTime.max(a, b)

const after = (at: DateTime.Utc | undefined, now: DateTime.Utc): DateTime.Utc | undefined =>
  at !== undefined && DateTime.isGreaterThan(at, now) ? at : undefined

/** When a full window lets the account serve again: its reset, else after the default block. */
const quotaBack = (health: Health, now: DateTime.Utc, model?: string): DateTime.Utc | undefined =>
  isExhausted(health.limits, now, model)
    ? Option.getOrElse(exhaustedUntil(health.limits, now, model), () => DateTime.addDuration(now, defaultBlock))
    : undefined

/**
 * When the account can serve `model` again, or nothing when it can now: the
 * latest of its block, its throttling, a full window, and a cap on that model.
 */
export const blockedFor = (health: Health, model: string | undefined, now: DateTime.Utc): DateTime.Utc | undefined => {
  const capped = model === undefined ? undefined : health.modelBlocks[model]
  return [health.blockedUntil, health.throttledUntil, quotaBack(health, now, model), capped].reduce<
    DateTime.Utc | undefined
  >((latest, at) => later(latest, after(at, now)), undefined)
}

/** Whether the account sits out for its quota (a refusal or a full window), not for throttling. */
export const isBlocked = (health: Health, now: DateTime.Utc): boolean =>
  after(health.blockedUntil, now) !== undefined || isExhausted(health.limits, now)

/** When an account sitting out for its quota is expected back. */
export const limitedUntil = (health: Health, now: DateTime.Utc): Option.Option<DateTime.Utc> =>
  Option.fromUndefinedOr(later(after(health.blockedUntil, now), quotaBack(health, now)))

/** Whether the account has never been measured. */
export const isUnmeasured = (health: Health, now: DateTime.Utc): boolean => score(health.limits, now) >= unknownScore

// ---------------------------------------------------------------------------
// The model

/** A window that ended, and the account it belonged to. */
export interface AccountLapse {
  readonly account: AccountId
  readonly lapse: Lapse
}

/** Everything the pool decides from. Immutable: every change makes a new one. */
export interface PoolModel {
  /** Every account, in list order. */
  readonly accounts: ReadonlyArray<Account>
  readonly health: HashMap.HashMap<AccountId, Health>
  /** By {@link sessionKey}. */
  readonly sessions: HashMap.HashMap<string, Session>
  readonly turns: HashMap.HashMap<AccountId, number>
  /** The last turn handed out. */
  readonly picks: number
  readonly pins: Pins
  readonly agents: Agents
  readonly codex: CodexSeen
  readonly told: ToldSet
  readonly lapsed: Readonly<Record<string, DateTime.Utc>>
  /** Windows readings showed ended, not yet taken by {@link lapses}. */
  readonly pending: ReadonlyArray<AccountLapse>
  /** Bumped by every change to what the pooled windows are read from, which keys their cache. */
  readonly version: number
  /** Changed since it was last saved. */
  readonly dirty: boolean
}

export const sessionKey = (provider: ProviderId, session: string): string => `${provider}\u0000${session}`

/** A model with nothing known yet. */
export const emptyModel: PoolModel = {
  accounts: [],
  health: HashMap.empty(),
  sessions: HashMap.empty(),
  turns: HashMap.empty(),
  picks: 0,
  pins: {},
  agents: {},
  codex: {},
  told: {},
  lapsed: {},
  pending: [],
  version: 0,
  dirty: false,
}

/** The model a saved state restores. Sessions past their time are let go when next asked for. */
export const fromSaved = (saved: SavedState): PoolModel => {
  const turns = HashMap.fromIterable(Object.entries(saved.turns).map(([id, turn]) => [AccountIdSchema.make(id), turn]))
  return {
    ...emptyModel,
    health: HashMap.fromIterable(
      Object.entries(saved.health).map(([id, health]) => [AccountIdSchema.make(id), health]),
    ),
    sessions: HashMap.fromIterable(
      saved.sessions.map((session) => [sessionKey(session.provider, session.id), session]),
    ),
    turns,
    picks: Math.max(0, ...HashMap.values(turns)),
    pins: saved.pins,
    agents: saved.agents,
    codex: saved.codex,
    told: saved.told,
    lapsed: saved.lapsed,
  }
}

const dropExpiredCaps = (health: Health, now: DateTime.Utc): Health => {
  const kept = Object.entries(health.modelBlocks).filter(([, until]) => DateTime.isGreaterThan(until, now))
  return kept.length === Object.keys(health.modelBlocks).length
    ? health
    : changed(health, { modelBlocks: Object.fromEntries(kept) })
}

/**
 * What `state.json` keeps of the model. Caps that have run out are dropped,
 * and so is the health of accounts that are gone (all of it is kept until
 * the accounts are first known).
 */
export const toSaved = (m: PoolModel, now: DateTime.Utc): SavedState => {
  const known = new Set(m.accounts.map((account) => account.id))
  const health: Record<string, Health> = {}
  for (const [id, entry] of m.health) if (known.size === 0 || known.has(id)) health[id] = dropExpiredCaps(entry, now)
  return new SavedState({
    health,
    sessions: [...HashMap.values(m.sessions)],
    turns: Object.fromEntries(m.turns),
    pins: m.pins,
    agents: m.agents,
    codex: m.codex,
    told: m.told,
    lapsed: m.lapsed,
  })
}

export const healthOf = (m: PoolModel, id: AccountId): Health =>
  Option.getOrElse(HashMap.get(m.health, id), () => Health.empty)

/**
 * The model with one account's health changed. Only a new reading or a
 * changed block alters what the pooled windows are read from, so only those
 * bump the version; a served request keeps their cache.
 */
const withHealth = (m: PoolModel, id: AccountId, f: (health: Health) => Health): PoolModel => {
  const old = healthOf(m, id)
  const health = f(old)
  const reread = health.limits !== old.limits || health.blockedUntil !== old.blockedUntil
  return {
    ...m,
    health: HashMap.set(m.health, id, health),
    version: reread ? m.version + 1 : m.version,
    dirty: true,
  }
}

/**
 * Values built here from parts already checked skip the schema's checks:
 * they are made on every request.
 */
const unchecked: Schema.MakeOptions = { disableChecks: true }

type Droppable = "blockedUntil" | "throttledUntil" | "lastError" | "resets"

/** The health with `fields` changed and the named optional fields dropped. */
const changed = (health: Health, fields: Partial<Health>, ...dropped: ReadonlyArray<Droppable>): Health => {
  const next = { ...health, ...fields }
  for (const name of dropped) delete next[name]
  return new Health(next, unchecked)
}

// ---------------------------------------------------------------------------
// How requests are placed

/** How the pool places requests, from the settings, so a change applies to the next request. */
export interface Routing {
  readonly strategy: Strategy
  /** How long a session stays on its account after its last request. */
  readonly ttl: Duration.Duration
  /** Whether a session stays on its account while that account can serve. */
  readonly affinity: boolean
}

/** The routing the settings ask for; a request's own say on affinity wins over theirs. */
export const routingOf = (
  settings: { readonly [K in "strategy" | "sessionMinutes" | "sessionAffinity"]: Settings[K] },
  affinity?: boolean,
): Routing => ({
  strategy: settings.strategy,
  ttl: Duration.minutes(settings.sessionMinutes),
  affinity: affinity ?? settings.sessionAffinity,
})

/**
 * A request's say on session affinity, from its `x-slopmax-affinity` header:
 * `on`, `true`, `1` or `yes` keeps the session on its account even when the
 * settings turn affinity off; `off`, `false`, `0` or `no` places it by the
 * strategy alone; anything else leaves it to the settings.
 */
export const affinityOverride = (value: string | null | undefined): boolean | undefined => {
  const word = value?.trim().toLowerCase()
  if (word === "on" || word === "true" || word === "1" || word === "yes") return true
  if (word === "off" || word === "false" || word === "0" || word === "no") return false
  return undefined
}

/** A request for an account. */
export interface PickRequest extends Routing {
  readonly provider: ProviderId
  /** The accounts routing allows; every account of the provider when absent. */
  readonly candidates?: ReadonlyArray<AccountId> | undefined
  readonly model?: string | undefined
  /** The agent's conversation id, which keeps a session on one account. */
  readonly session?: string | undefined
  /** An agent's housekeeping (listing models, counting tokens) rather than work: it takes no round-robin turn. */
  readonly housekeeping: boolean
  /** Accounts this request already tried. */
  readonly exclude: ReadonlySet<AccountId>
}

/** The account a request gets, or why none can serve. */
export type Pick = Data.TaggedEnum<{
  /** `movedFrom` is the account the session was on, when it moved: state that account minted must be dropped. */
  Chosen: { readonly account: Account; readonly movedFrom?: AccountId }
  /** `until` is when some account is expected back; `spent` says accounts are spent rather than failing. */
  NoneReady: { readonly reason: string; readonly until?: DateTime.Utc; readonly spent: boolean }
}>
export const Pick = Data.taggedEnum<Pick>()

/** Whether the account can be used at all: turned on and signed in. */
export const isWorking = (account: Account): boolean => !account.disabled && account.authError === undefined

const of = (provider: ProviderId) => (account: Account) => account.provider === provider

const sessionLive = (session: Session, now: DateTime.Utc, ttl: Duration.Duration): boolean =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(session.at) < Duration.toMillis(ttl)

/** Unknown last use sorts first: an account never used is the one to use. */
const lastUsedOrder: Order.Order<DateTime.Utc | undefined> = Order.mapInput(
  Order.Number,
  (at: DateTime.Utc | undefined) => (at === undefined ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(at)),
)

const addedOrder: Order.Order<Account> = Order.mapInput(DateTime.Order, (account: Account) => account.addedAt)

/** How much room an account has, then how long since it was used. */
interface Room {
  readonly score: number
  readonly lastUsed: DateTime.Utc | undefined
}

const roomOrder: Order.Order<Room> = Order.combine(
  Order.mapInput(Order.Number, (room: Room) => room.score),
  Order.mapInput(lastUsedOrder, (room: Room) => room.lastUsed),
)

interface Urgent extends Room {
  readonly urgency: Urgency
}

const urgentOrder: Order.Order<Urgent> = Order.combine(
  Order.mapInput(urgencyOrder, (key: Urgent) => key.urgency),
  roomOrder,
)

/** The account whose key sorts first. Each key is worked out once, not on every comparison. */
const firstBy = <K>(
  tier: ReadonlyArray<Account>,
  keyOf: (account: Account) => K,
  order: Order.Order<K>,
): Account | undefined => {
  const keyed = tier.map((account) => ({ account, key: keyOf(account) }))
  return Arr.isReadonlyArrayNonEmpty(keyed)
    ? Arr.min(
        keyed,
        Order.mapInput(order, (entry: { readonly key: K }) => entry.key),
      ).account
    : undefined
}

/**
 * Placement for a session without an account to keep: by the strategy,
 * among the ready accounts of the highest priority.
 */
const place = (
  strategy: Strategy,
  ready: ReadonlyArray<Account>,
  m: PoolModel,
  now: DateTime.Utc,
): Account | undefined => {
  if (ready.length === 0) return undefined
  const top = Math.max(...ready.map((account) => account.priority))
  const tier = ready.filter((account) => account.priority === top)
  const room = (account: Account): Room => {
    const health = healthOf(m, account.id)
    return { score: score(health.limits, now), lastUsed: health.lastUsed }
  }
  switch (strategy) {
    // Accounts list oldest first within a priority, so the oldest is the one to keep filling.
    case "fill-first":
      return firstBy(tier, (account) => account, addedOrder)
    // Spare quota is lost when its window resets, while an idle account
    // loses nothing by waiting: spend the quota that expires soonest first.
    case "reset-first":
      return firstBy(
        tier,
        (account): Urgent => ({ ...room(account), urgency: urgency(healthOf(m, account.id).limits, now) }),
        urgentOrder,
      )
    case "least-used":
      return firstBy(tier, room, roomOrder)
    // The account handed a request longest ago, the oldest first among those never handed one.
    case "round-robin":
      return firstBy(
        tier,
        (account) => account,
        Order.combine(
          Order.mapInput(Order.Number, (account: Account) =>
            Option.getOrElse(HashMap.get(m.turns, account.id), () => 0),
          ),
          addedOrder,
        ),
      )
  }
}

/**
 * Chooses an account for a request. A session stays on its account while
 * that account is ready (and affinity is on); else the pinned account
 * serves, when ready; else the strategy places it among the top priority.
 * Accounts already tried are skipped, but their blocks still count toward
 * when the pool frees up.
 */
export const pick = (m: PoolModel, r: PickRequest, now: DateTime.Utc): readonly [Pick, PoolModel] => {
  const key = r.session === undefined ? undefined : sessionKey(r.provider, r.session)
  const bound = Option.getOrUndefined(
    Option.filter(key === undefined ? Option.none() : HashMap.get(m.sessions, key), (session) =>
      sessionLive(session, now, r.ttl),
    ),
  )?.account
  const candidates = r.candidates === undefined ? undefined : new Set(r.candidates)
  const usable = m.accounts.filter(
    (account) =>
      account.provider === r.provider && isWorking(account) && (candidates === undefined || candidates.has(account.id)),
  )
  if (usable.length === 0) {
    const reason = m.accounts.some(of(r.provider))
      ? `every ${r.provider} account is disabled or signed out`
      : `no ${r.provider} accounts connected; run \`slopmax login ${r.provider}\``
    return [Pick.NoneReady({ reason, spent: false }), m]
  }
  const ready: Array<Account> = []
  let soonest: DateTime.Utc | undefined
  for (const account of usable) {
    const until = blockedFor(healthOf(m, account.id), r.model, now)
    if (until !== undefined) soonest = soonest === undefined ? until : DateTime.min(soonest, until)
    else if (!r.exclude.has(account.id)) ready.push(account)
  }
  const pinned = m.pins[r.provider]
  const chosen =
    (r.affinity && bound !== undefined ? ready.find((account) => account.id === bound) : undefined) ??
    (pinned === undefined ? undefined : ready.find((account) => account.id === pinned)) ??
    place(r.strategy, ready, m, now)
  if (chosen === undefined) {
    const reason =
      soonest === undefined
        ? `every ${r.provider} account failed this request`
        : `every ${r.provider} account is rate limited`
    return [
      Pick.NoneReady({ reason, spent: soonest !== undefined, ...(soonest === undefined ? {} : { until: soonest }) }),
      m,
    ]
  }
  const picks = r.housekeeping ? m.picks : m.picks + 1
  const next: PoolModel = {
    ...m,
    picks,
    turns: r.housekeeping ? m.turns : HashMap.set(m.turns, chosen.id, picks),
    sessions:
      key === undefined || r.session === undefined
        ? m.sessions
        : HashMap.set(
            m.sessions,
            key,
            new Session({ provider: r.provider, id: r.session, account: chosen.id, at: now }, unchecked),
          ),
    dirty: m.dirty || key !== undefined || !r.housekeeping,
  }
  const movedFrom = bound !== undefined && bound !== chosen.id ? bound : undefined
  return [Pick.Chosen({ account: chosen, ...(movedFrom === undefined ? {} : { movedFrom }) }), next]
}

const view = (account: Account, reason: NextView["reason"]): Option.Option<NextView> =>
  Option.some(new NextView({ account: account.id, reason, why: nextReasonText(reason) }))

/**
 * The account a new session of `provider` would get now, and why; nothing
 * when none can serve. Nothing changes: it is what {@link pick} does for a
 * request without a session.
 */
export const next = (
  m: PoolModel,
  provider: ProviderId,
  strategy: Strategy,
  now: DateTime.Utc,
): Option.Option<NextView> => {
  const ready = m.accounts.filter(
    (account) =>
      account.provider === provider &&
      isWorking(account) &&
      blockedFor(healthOf(m, account.id), undefined, now) === undefined,
  )
  const pinned = ready.find((account) => account.id === m.pins[provider])
  if (pinned !== undefined) return view(pinned, "pinned")
  const chosen = place(strategy, ready, m, now)
  if (chosen === undefined) return Option.none()
  if (ready.filter((account) => account.priority === chosen.priority).length === 1) return view(chosen, "only-one")
  switch (strategy) {
    case "reset-first": {
      const u = urgency(healthOf(m, chosen.id).limits, now)
      if (Option.isSome(u.weekEnding)) return view(chosen, "week-ending")
      if (Option.isSome(u.short) || Option.isSome(u.long)) return view(chosen, "resets-first")
      return view(chosen, "most-room")
    }
    case "fill-first":
      return view(chosen, "fills-first")
    case "least-used":
      return view(chosen, "most-room")
    case "round-robin":
      return view(chosen, "turn")
  }
}

/** How many live sessions each account serves. */
export const sessionCounts = (
  m: PoolModel,
  now: DateTime.Utc,
  ttl: Duration.Duration,
): ReadonlyMap<AccountId, number> => {
  const counts = new Map<AccountId, number>()
  for (const session of HashMap.values(m.sessions)) {
    if (sessionLive(session, now, ttl)) counts.set(session.account, (counts.get(session.account) ?? 0) + 1)
  }
  return counts
}

// ---------------------------------------------------------------------------
// What requests and readings teach the pool

/** A request the account served: it was used now, and is no longer throttled or failing. */
export const succeeded = (m: PoolModel, id: AccountId, usage: Usage | undefined, now: DateTime.Utc): PoolModel =>
  withHealth(m, id, (health) =>
    changed(
      health,
      { lastUsed: now, served: usage === undefined ? health.served : health.served.plus(usage) },
      "throttledUntil",
      "lastError",
    ),
  )

/** Tokens the account served outside a request the proxy relayed (a warmup). */
export const addUsage = (m: PoolModel, id: AccountId, usage: Usage): PoolModel =>
  withHealth(m, id, (health) => changed(health, { served: health.served.plus(usage) }))

/**
 * Folds a usage reading into the account's limits. A fresh reading below
 * the limit proves an earlier block lifted, often well before the stated
 * reset, so the block goes. Windows the reading shows ended are queued for
 * {@link lapses}.
 */
export const observe = (m: PoolModel, id: AccountId, limits: Limits, now: DateTime.Utc): PoolModel => {
  const old = healthOf(m, id)
  const ended = lapsed(old.limits, limits, now)
  const merged = merge(old.limits, limits, now)
  const lifted = old.blockedUntil !== undefined && !isExhausted(merged, now)
  const health = lifted ? changed(old, { limits: merged }, "blockedUntil") : changed(old, { limits: merged })
  return {
    ...withHealth(m, id, () => health),
    pending: ended.length === 0 ? m.pending : [...m.pending, ...ended.map((lapse) => ({ account: id, lapse }))],
  }
}

/**
 * Sits an account out after a quota refusal, for every model or only one.
 * A deadline only ever extends, and the reason shows as its last error.
 */
export const block = (
  m: PoolModel,
  id: AccountId,
  until: DateTime.Utc,
  model: string | undefined,
  why: string,
): PoolModel =>
  withHealth(m, id, (health) => {
    if (model === undefined) {
      return changed(health, { blockedUntil: later(health.blockedUntil, until) ?? until, lastError: why })
    }
    const capped = health.modelBlocks[model]
    return changed(health, {
      modelBlocks: { ...health.modelBlocks, [model]: later(capped, until) ?? until },
      lastError: why,
    })
  })

/** Prefers other accounts for a moment after throttling; the deadline only extends. */
export const throttle = (m: PoolModel, id: AccountId, until: DateTime.Utc): PoolModel =>
  withHealth(m, id, (health) => changed(health, { throttledUntil: later(health.throttledUntil, until) ?? until }))

/** A failure that is not about quota, kept to show. */
export const failed = (m: PoolModel, id: AccountId, why: string): PoolModel =>
  withHealth(m, id, (health) => changed(health, { lastError: why }))

/** The account's limit resets as just listed, with the count its usage reported then. */
export const recordResets = (
  m: PoolModel,
  id: AccountId,
  list: ReadonlyArray<LimitReset>,
  now: DateTime.Utc,
): PoolModel =>
  withHealth(m, id, (health) =>
    changed(health, {
      resets: new ResetList({
        list,
        listedAt: now,
        ...(health.limits.resetCredits === undefined ? {} : { counted: health.limits.resetCredits }),
      }),
    }),
  )

/**
 * The account's windows were just reset by redeeming `resetId`, or one the
 * provider chose: every block lifts, its windows read empty until the next
 * reading, and the reset leaves its list. When which one went is unknown,
 * the list is due again.
 */
export const recordReset = (m: PoolModel, id: AccountId, now: DateTime.Utc, resetId?: string): PoolModel =>
  withHealth(m, id, (health) => {
    const { limits } = health
    const resetCredits = limits.resetCredits === undefined ? undefined : Math.max(0, limits.resetCredits - 1)
    const emptied = new Limits({
      windows: limits.windows.map(
        (window) =>
          new Window({ span: window.span, used: 0, ...(window.model === undefined ? {} : { model: window.model }) }),
      ),
      observedAt: now,
      ...(resetCredits === undefined ? {} : { resetCredits }),
      ...(limits.plan === undefined ? {} : { plan: limits.plan }),
    })
    const listed = health.resets
    const spent = listed?.list.findIndex((reset) => reset.id === resetId) ?? -1
    const { counted: _unknown, ...uncounted } = listed ?? { list: [], listedAt: now }
    const resets =
      listed === undefined
        ? undefined
        : spent >= 0
          ? new ResetList({
              list: listed.list.filter((_, index) => index !== spent),
              listedAt: listed.listedAt,
              ...(listed.counted === undefined ? {} : { counted: Math.max(0, listed.counted - 1) }),
            })
          : new ResetList(uncounted)
    const lifted = ["blockedUntil", "throttledUntil", "lastError"] as const
    return resets === undefined
      ? changed(health, { limits: emptied, modelBlocks: {} }, ...lifted, "resets")
      : changed(health, { limits: emptied, modelBlocks: {}, resets }, ...lifted)
  })

/**
 * Lifts the account's blocks and throttling so the next request tries it
 * again; a refusal sets it aside anew if its quota is still spent. Gives the
 * models whose caps were lifted.
 */
export const clearBlocks = (m: PoolModel, id: AccountId): readonly [ReadonlyArray<string>, PoolModel] => {
  const models = Object.keys(healthOf(m, id).modelBlocks)
  return [models, withHealth(m, id, (health) => changed(health, { modelBlocks: {} }, "blockedUntil", "throttledUntil"))]
}

/**
 * Pins an account for a provider's new sessions, or unpins it. A changed
 * pin lets go of the provider's sessions, so they move to the pinned account.
 */
export const pin = (m: PoolModel, provider: ProviderId, id: AccountId | undefined): PoolModel => {
  if (m.pins[provider] === id) return m
  const { [provider]: _old, ...others } = m.pins
  return {
    ...m,
    pins: id === undefined ? others : { ...others, [provider]: id },
    sessions: HashMap.filter(m.sessions, (session) => session.provider !== provider),
    dirty: true,
  }
}

/** Unpins every provider. */
export const unpinAll = (m: PoolModel): PoolModel =>
  ProviderId.literals.reduce((model, provider) => pin(model, provider, undefined), m)

/** Notes the user agent of a request from `provider`'s own agent. */
export const sawAgent = (m: PoolModel, provider: ProviderId, userAgent: string): PoolModel =>
  m.agents[provider] === userAgent ? m : { ...m, agents: { ...m.agents, [provider]: userAgent }, dirty: true }

/** Notes what a Codex request showed: its release and the model it asked for. */
export const sawCodex = (m: PoolModel, seen: CodexSeen): PoolModel => {
  const codex = { ...m.codex, ...seen }
  return codex.version === m.codex.version && codex.lastModel === m.codex.lastModel ? m : { ...m, codex, dirty: true }
}

/** The notices told, to keep. */
export const setTold = (m: PoolModel, told: ToldSet): PoolModel => (m.told === told ? m : { ...m, told, dirty: true })

const lapseKey = ({ account, lapse }: AccountLapse): string =>
  `${account} ${lapse.span} ${lapse.model ?? ""} ${DateTime.toEpochMillis(lapse.endedAt)}`

/** Where an account's ended windows are filed: under its provider and plan. */
const holders = (m: PoolModel): ReadonlyMap<AccountId, WindowHolder> =>
  new Map(
    m.accounts.map((account) => [
      account.id,
      { provider: account.provider, plan: account.identity.plan ?? healthOf(m, account.id).limits.plan },
    ]),
  )

/**
 * The windows that ended since last asked, as ledger records: those a
 * reading showed ended, and those whose time passed with no reading since.
 * Each is given once, even across restarts. One is remembered while it is
 * still seen or ended within 8 days; older ones cannot come round again.
 */
export const lapses = (m: PoolModel, now: DateTime.Utc): readonly [ReadonlyArray<WindowEndedRecord>, PoolModel] => {
  const found: Array<AccountLapse> = [...m.pending]
  for (const [account, health] of m.health) {
    for (const lapse of lapsed(health.limits, Limits.empty, now)) found.push({ account, lapse })
  }
  const forgetBefore = DateTime.toEpochMillis(now) - Duration.toMillis(lapsesKept)
  const told: Record<string, DateTime.Utc> = {}
  for (const [key, at] of Object.entries(m.lapsed)) if (DateTime.toEpochMillis(at) > forgetBefore) told[key] = at
  const taken: Array<AccountLapse> = []
  for (const item of found) {
    const key = lapseKey(item)
    if (!(key in m.lapsed) && !(key in told)) taken.push(item)
    told[key] = item.lapse.endedAt
  }
  const keys = Object.keys(told)
  const same = keys.length === Object.keys(m.lapsed).length && keys.every((key) => key in m.lapsed)
  if (same && m.pending.length === 0) return [[], m]
  return [windowEndedRecords(taken, holders(m)), { ...m, lapsed: told, pending: [], dirty: m.dirty || !same }]
}

/** Replaces the accounts, letting go of sessions on accounts that are gone. */
export const sync = (m: PoolModel, accounts: ReadonlyArray<Account>): PoolModel => {
  const ids = new Set(accounts.map((account) => account.id))
  const sessions = HashMap.filter(m.sessions, (session) => ids.has(session.account))
  return {
    ...m,
    accounts,
    sessions,
    version: m.version + 1,
    dirty: m.dirty || HashMap.size(sessions) !== HashMap.size(m.sessions),
  }
}

/** Lets go of sessions idle past `ttl` and caps that have run out. */
export const prune = (m: PoolModel, now: DateTime.Utc, ttl: Duration.Duration): PoolModel => {
  const sessions = HashMap.filter(m.sessions, (session) => sessionLive(session, now, ttl))
  let health = m.health
  for (const [id, entry] of m.health) {
    const kept = dropExpiredCaps(entry, now)
    if (kept !== entry) health = HashMap.set(health, id, kept)
  }
  const same = HashMap.size(sessions) === HashMap.size(m.sessions) && health === m.health
  return same ? m : { ...m, sessions, health, dirty: true }
}

// ---------------------------------------------------------------------------
// A pool read as one account

interface Member {
  readonly account: Account
  readonly health: Health
  readonly share: number | undefined
}

/** The provider's working accounts (enabled and signed in), each with its share of the pool when every plan's size is known. */
const members = (m: PoolModel, provider: ProviderId): ReadonlyArray<Member> => {
  const working = m.accounts.filter((account) => account.provider === provider && isWorking(account))
  const healths = working.map((account) => healthOf(m, account.id))
  const split = shares(
    provider,
    working.map((account, index) => account.identity.plan ?? healths[index]?.limits.plan),
  )
  return working.map((account, index) => ({ account, health: healths[index] ?? Health.empty, share: split?.[index] }))
}

/** The provider's working accounts read as one: each shared window's mean use, weighted by plan when known. */
export const pooledWindows = (m: PoolModel, provider: ProviderId, now: DateTime.Utc): ReadonlyArray<PoolWindow> =>
  poolWindows(
    members(m, provider).map((member) => ({
      limits: member.health.limits,
      blocked: isBlocked(member.health, now),
      ...(member.share === undefined ? {} : { share: member.share }),
    })),
    now,
  )

/**
 * The model-scoped windows (a weekly cap on one model), in span then model
 * order, each read as one over the accounts that report it with the same
 * weights as the shared ones.
 */
const pooledScoped = (all: ReadonlyArray<Member>, now: DateTime.Utc): ReadonlyArray<Window> => {
  const models = new Set<string>()
  for (const member of all)
    for (const window of member.health.limits.windows) if (window.model !== undefined) models.add(window.model)
  const pooledFor = (model: string): ReadonlyArray<Window> =>
    poolWindows(
      all.map((member) => ({
        // The one model's windows, read as if they covered every request.
        limits: new Limits(
          {
            windows: member.health.limits.windows
              .filter((window) => window.model === model)
              .map((window) => Window.of(window.span, window.used, window.resetsAt)),
          },
          unchecked,
        ),
        ...(member.share === undefined ? {} : { share: member.share }),
      })),
      now,
    ).map((window) => Window.of(window.span, window.used, window.resetsAt, model))
  return [...models]
    .toSorted()
    .flatMap(pooledFor)
    .toSorted((a, b) => Span.literals.indexOf(a.span) - Span.literals.indexOf(b.span))
}

/**
 * A subscription's working accounts read as one, as its agent is shown them:
 * the shared windows, the model-scoped ones, and each account's share.
 * Nothing when it has no working account.
 */
export const pooledView = (m: PoolModel, provider: ProviderId, now: DateTime.Utc): Option.Option<PoolView> => {
  const all = members(m, provider)
  if (all.length === 0) return Option.none()
  const split: Record<string, number> = {}
  for (const member of all) if (member.share !== undefined) split[member.account.id] = member.share
  return Option.some(
    new PoolView({
      provider,
      accounts: all.length,
      windows: pooledWindows(m, provider, now),
      scoped: pooledScoped(all, now),
      shares: split,
    }),
  )
}

/**
 * The next moment the pooled windows of `provider` could read differently
 * with no new reading: a window resets, a block or cap runs out, or a full
 * window's reading goes stale.
 */
const pooledValidUntil = (m: PoolModel, provider: ProviderId, now: DateTime.Utc): number => {
  const nowMillis = DateTime.toEpochMillis(now)
  let until = Number.POSITIVE_INFINITY
  const consider = (at: DateTime.Utc | undefined) => {
    if (at === undefined) return
    const millis = DateTime.toEpochMillis(at)
    if (millis > nowMillis && millis < until) until = millis
  }
  for (const { health } of members(m, provider)) {
    consider(health.blockedUntil)
    for (const window of health.limits.windows) consider(window.resetsAt)
    if (health.limits.observedAt !== undefined) consider(DateTime.addDuration(health.limits.observedAt, staleAfter))
  }
  return until
}

// ---------------------------------------------------------------------------
// The service

export interface Shape {
  /** The model as it is now. */
  readonly model: Effect.Effect<PoolModel>
  /** Changes the model with a pure function of it and the time, giving its answer. */
  readonly modify: <A>(f: (m: PoolModel, now: DateTime.Utc) => readonly [A, PoolModel]) => Effect.Effect<A>
  /** Changes the model with a pure function of it and the time. */
  readonly update: (f: (m: PoolModel, now: DateTime.Utc) => PoolModel) => Effect.Effect<void>
  /**
   * The provider's working accounts read as one, for response headers.
   * Kept until a reading changes or a window resets, so a request never
   * computes a weighted mean.
   */
  readonly pooled: (provider: ProviderId) => Effect.Effect<ReadonlyArray<PoolWindow>>
  /** A signal after every change; a slow reader sees the latest only. */
  readonly changes: Stream.Stream<void>
  /** Writes `state.json` when anything changed since it was last written. */
  readonly save: Effect.Effect<void, FileError>
}

interface Cached {
  readonly version: number
  readonly validUntil: number
  readonly windows: ReadonlyArray<PoolWindow>
}

/** The service over a model, saving through `write` (nothing, for a pool kept in memory). */
const makeWith = (
  initial: PoolModel,
  write: (saved: SavedState) => Effect.Effect<void, FileError>,
): Effect.Effect<Shape> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial)
    const signal = yield* PubSub.sliding<void>(1)
    // A plain map: it is read and filled synchronously, and only ever holds
    // one entry per provider.
    const cache = new Map<ProviderId, Cached>()

    const modify = <A>(f: (m: PoolModel, now: DateTime.Utc) => readonly [A, PoolModel]): Effect.Effect<A> =>
      Effect.flatMap(DateTime.now, (now) =>
        Effect.flatMap(
          Ref.modify(ref, (m): [readonly [A, boolean], PoolModel] => {
            const [answer, updated] = f(m, now)
            return [[answer, updated !== m], updated]
          }),
          ([answer, moved]) => (moved ? Effect.as(PubSub.publish(signal, undefined), answer) : Effect.succeed(answer)),
        ),
      )

    const update = (f: (m: PoolModel, now: DateTime.Utc) => PoolModel): Effect.Effect<void> =>
      modify((m, now) => [undefined, f(m, now)] as const)

    const pooled = (provider: ProviderId): Effect.Effect<ReadonlyArray<PoolWindow>> =>
      Effect.flatMap(DateTime.now, (now) =>
        Effect.map(Ref.get(ref), (m) => {
          const hit = cache.get(provider)
          const at = DateTime.toEpochMillis(now)
          if (hit !== undefined && hit.version === m.version && at < hit.validUntil) return hit.windows
          const windows = pooledWindows(m, provider, now)
          cache.set(provider, { version: m.version, validUntil: pooledValidUntil(m, provider, now), windows })
          return windows
        }),
      )

    const save = Effect.gen(function* () {
      const now = yield* DateTime.now
      const saved = yield* Ref.modify(ref, (m): [SavedState | undefined, PoolModel] =>
        m.dirty ? [toSaved(m, now), { ...m, dirty: false }] : [undefined, m],
      )
      if (saved === undefined) return
      // A write that failed or was cut short leaves the model dirty, so the next save tries again.
      yield* write(saved).pipe(Effect.onError(() => Ref.update(ref, (m) => ({ ...m, dirty: true }))))
    }).pipe(Effect.withSpan("Pool.save"))

    return {
      model: Ref.get(ref),
      modify,
      update,
      pooled,
      changes: Stream.fromPubSub(signal),
      save,
    } satisfies Shape
  })

/** Keeps the pool's accounts in step with the store for the life of the scope. */
const following = (shape: Shape) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const resync = Effect.flatMap(accounts.list, (list) => shape.update((m) => sync(m, list)))
    // Subscribed before the first read, so no change between the two is missed.
    yield* accounts.changes.pipe(
      Stream.runForEach(() => resync),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* resync
  })

/** The account pool. */
export class Pool extends Context.Service<Pool, Shape>()("@slopmax/core/Pool", {
  make: Effect.gen(function* () {
    const home = yield* Home
    const file = home.paths.state
    // A missing file is a fresh start; a malformed one stops the start
    // rather than throw away every session and block.
    const saved = yield* home.read(file, SavedState)
    const shape = yield* makeWith(fromSaved(Option.getOrElse(saved, () => SavedState.empty)), (state) =>
      home.write(file, SavedState, state),
    )
    yield* following(shape)
    return shape
  }),
}) {
  /** The pool kept in `state.json`, following the account store. */
  static readonly layer: Layer.Layer<Pool, FileError, Home | Accounts> = Layer.effect(Pool, Pool.make)

  /** A pool kept in memory only, starting from `seed`, following the account store. */
  static readonly layerMemory = (seed: SavedState = SavedState.empty): Layer.Layer<Pool, never, Accounts> =>
    Layer.effect(
      Pool,
      Effect.gen(function* () {
        const shape = yield* makeWith(fromSaved(seed), () => Effect.void)
        yield* following(shape)
        return shape
      }),
    )

  /** The notices told, kept with the pool's state so a restart never tells one again. */
  static readonly told: Layer.Layer<Told, never, Pool> = Layer.effect(
    Told,
    Effect.gen(function* () {
      const pool = yield* Pool
      return {
        get: Effect.map(pool.model, (m) => m.told),
        set: (told: ToldSet) => pool.update((m) => setTold(m, told)),
      }
    }),
  )
}
