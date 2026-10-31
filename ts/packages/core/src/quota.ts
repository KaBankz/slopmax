// Keeping the pool's picture of each subscription's quota current, and
// spending banked limit resets well.
//
// - Usage polls read each subscription account's windows: when the last
//   reading is old, when a window has reset since, or (for a blocked
//   account) every 10 minutes, since quota often frees up before the stated
//   reset.
// - Limit resets are listed now and then, and one about to expire unused is
//   redeemed on an account that has usage to reset, as a lapsed reset is
//   simply lost.
// - When every account of a provider is spent and the settings allow it, a
//   request is rescued by redeeming a reset instead of failing.
// - Idle ChatGPT accounts can have their 5-hour window started early, so its
//   reset comes sooner when the account is needed.
//
// Only one redemption runs at a time, whoever asks (the API, the hub, a
// rescue, the expiring-reset task): two at once could spend two resets where
// one would do.
import {
  type AccountId,
  type AgentId,
  isSubscription,
  LedgerRecord,
  type LimitReset,
  providerFacts,
  type ProviderId,
  type RedeemOutcome,
  slopmaxVersion,
  usedAt,
} from "@slopmax/domain"
import { Tap } from "@slopmax/wire"
import { Context, Data, DateTime, Duration, Effect, Layer, Option, Ref, Semaphore } from "effect"
import { Account, Identity } from "./account.ts"
import { Accounts } from "./accounts.ts"
import { Ledger } from "./ledger.ts"
import {
  addUsage,
  failed,
  healthOf,
  type Health,
  isBlocked,
  isWorking,
  limitedUntil,
  observe,
  Pool,
  recordReset,
  recordResets,
  resetsLeft,
  unexpiredResets,
} from "./pool.ts"
import { NeedsAgent, type ProviderFailed, type Resets } from "./providers/provider.ts"
import { providerOf, providers } from "./providers/registry.ts"
import { pollUsage } from "./refresh.ts"
import { SettingsService } from "./settings.ts"
import { Upstream } from "./upstream.ts"

/** A blocked account's usage is read this often, as quota often frees up before the stated reset. */
export const recheckBlocked: Duration.Duration = Duration.minutes(10)

/** A limit reset this close to expiring is redeemed rather than lost. */
export const expiryLead: Duration.Duration = Duration.hours(3)

/** Resets a provider counts in its usage are listed this often; a changed count lists them sooner. */
export const listCountedEvery: Duration.Duration = Duration.hours(6)

/**
 * Resets a provider does not count (Claude's) are listed this often, so a
 * new one shows within the hour. A failed listing waits as long, since it
 * asks the usage endpoint, which limits how often it is asked.
 */
export const listUncountedEvery: Duration.Duration = Duration.hours(1)

/** The soonest a changed count has the resets listed again. */
export const listCountChangedAfter: Duration.Duration = Duration.minutes(10)

/** An idle ChatGPT account is warmed at most once per window. */
export const warmEvery: Duration.Duration = Duration.hours(5)

/** The account's provider banks no limit resets. */
export class NoLimitResets extends Data.TaggedError("NoLimitResets")<{ readonly provider: ProviderId }> {
  override get message(): string {
    return `${providerFacts[this.provider].title} accounts have no limit resets`
  }
}

/** The account cannot be used now: its sign-in is gone, or could not be refreshed. */
export class NotReady extends Data.TaggedError("NotReady")<{ readonly account: AccountId; readonly reason: string }> {
  override get message(): string {
    return `the account needs signing in again (${this.reason})`
  }
}

export interface Shape {
  /** Reads one account's usage into the pool; a failure is logged and shows as its last error. */
  readonly poll: (account: Account) => Effect.Effect<void>
  /** Reads the usage of every signed-in subscription account whose reading is due (every one, forced), all at once. */
  readonly pollDue: (options?: { readonly force?: boolean }) => Effect.Effect<void>
  /** Lists an account's limit resets now, keeping the list in the pool. */
  readonly listResets: (
    account: Account,
  ) => Effect.Effect<ReadonlyArray<LimitReset>, NoLimitResets | NotReady | NeedsAgent | ProviderFailed>
  /** Lists the limit resets of each account whose list is due (every one, forced), one account at a time. */
  readonly listDue: (options?: { readonly force?: boolean }) => Effect.Effect<void>
  /** Redeems the named reset, or the first the provider would spend, as listed now. */
  readonly redeem: (
    account: Account,
    resetId?: string,
  ) => Effect.Effect<RedeemOutcome, NoLimitResets | NotReady | NeedsAgent | ProviderFailed>
  /** Redeems each account's next reset when it expires within 3 hours and the account has usage to reset. */
  readonly redeemExpiring: Effect.Effect<void>
  /** Frees a spent account of `provider` by redeeming a reset; gives the account that can serve again. */
  readonly rescue: (provider: ProviderId) => Effect.Effect<Option.Option<AccountId>>
  /** Starts the 5-hour window of each idle ChatGPT account early. */
  readonly warm: Effect.Effect<void>
  /** Refreshes every sign-in that is due, one at a time; a failure shows as the account's last error. */
  readonly refreshDue: Effect.Effect<void>
}

/**
 * Whether an account's usage reading is due: never read, older than the
 * poll interval, a window has reset since it was read, or the account is
 * blocked and the reading is 10 minutes old.
 */
export const pollIsDue = (health: Health, now: DateTime.Utc, every: Duration.Duration): boolean => {
  const observedAt = health.limits.observedAt
  if (observedAt === undefined) return true
  const age = DateTime.distance(observedAt, now)
  const windowReset = health.limits.windows.some(
    (window) =>
      window.resetsAt !== undefined &&
      DateTime.isGreaterThan(window.resetsAt, observedAt) &&
      DateTime.isLessThanOrEqualTo(window.resetsAt, now),
  )
  return (
    Duration.isGreaterThanOrEqualTo(age, every) ||
    windowReset ||
    (isBlocked(health, now) && Duration.isGreaterThanOrEqualTo(age, recheckBlocked))
  )
}

/**
 * Whether an account's limit resets are due to be listed: never listed,
 * listed long enough ago, or the count its usage reports changed since and
 * the list is 10 minutes old.
 */
export const listIsDue = (health: Health, counted: boolean, now: DateTime.Utc): boolean => {
  const listed = health.resets
  if (listed === undefined) return true
  const age = DateTime.distance(listed.listedAt, now)
  return (
    Duration.isGreaterThanOrEqualTo(age, counted ? listCountedEvery : listUncountedEvery) ||
    (Duration.isGreaterThanOrEqualTo(age, listCountChangedAfter) && listed.counted !== health.limits.resetCredits)
  )
}

/** The body of a warmup: the smallest request that starts a window. */
export const warmupBody = (model: string): string =>
  JSON.stringify({
    model,
    instructions: "Reply with OK.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    store: false,
    stream: true,
  })

/** Why a warmup did not start a window. */
class WarmupFailed extends Data.TaggedError("WarmupFailed")<{ readonly reason: string }> {}

/** A warmup's answer is small; anything past this is not one. */
const warmupLimit = 16 * 1024 * 1024

const make = Effect.gen(function* () {
  const pool = yield* Pool
  const accounts = yield* Accounts
  const upstream = yield* Upstream
  const settingsService = yield* SettingsService
  const ledger = yield* Ledger
  const redeeming = yield* Semaphore.make(1)
  const warmed = yield* Ref.make<ReadonlyMap<AccountId, DateTime.Utc>>(new Map())

  const onUpstream = <A, E>(effect: Effect.Effect<A, E, Upstream>): Effect.Effect<A, E> =>
    Effect.provideService(effect, Upstream, upstream)

  /**
   * Redeems a reset and records it in the pool as one step that cannot be cut
   * short: once the provider has spent the reset, the pool must show it, or
   * the account looks spent still and the next rescue spends another.
   */
  const spend = (resets: Resets, account: Account, resetId: string | undefined, userAgent: string | undefined) =>
    Effect.uninterruptible(
      Effect.tap(onUpstream(resets.redeem(account, resetId, userAgent)), (outcome) =>
        outcome === "reset" ? pool.update((m, now) => recordReset(m, account.id, now, resetId)) : Effect.void,
      ),
    )

  /** The user agent of the provider's own agent, as last seen. */
  const agentOf = (provider: ProviderId) => Effect.map(pool.model, (m) => m.agents[provider])

  /** The provider's limit resets, and the agent they need, when the agent was seen. */
  const resetsOf = Effect.fnUntraced(function* (account: Account) {
    const resets = providerOf(account).resets
    if (Option.isNone(resets)) return yield* new NoLimitResets({ provider: account.provider })
    const userAgent = yield* agentOf(account.provider)
    if (resets.value.needsAgent && userAgent === undefined) {
      const agent: AgentId = providerFacts[account.provider].agentOnly ?? "claude-code"
      return yield* new NeedsAgent({ agent })
    }
    return { resets: resets.value, userAgent }
  })

  /**
   * The account with a credential usable now. A sign-in that is gone, or
   * that could not be refreshed, fails and shows as the account's last error.
   */
  const ready = Effect.fnUntraced(function* (given: Account) {
    const account = Option.getOrElse(yield* accounts.get(given.id), () => given)
    // Another process may have found the sign-in revoked since; trying it would cost a refusal.
    if (account.authError !== undefined) {
      yield* pool.update((m) => failed(m, account.id, account.authError ?? ""))
      return yield* new NotReady({ account: account.id, reason: account.authError })
    }
    return yield* accounts.ready(account).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`${account.id}: ${error.message}`)
          yield* pool.update((m) => failed(m, account.id, error.message))
          return yield* new NotReady({ account: account.id, reason: error.message })
        }),
      ),
    )
  })

  const poll = Effect.fn("Quota.poll")(function* (account: Account) {
    const { refreshTokens } = yield* settingsService.get
    const read = yield* Effect.result(onUpstream(pollUsage(accounts.ready, account, { refresh: refreshTokens })))
    if (read._tag === "Failure") {
      const why = read.failure.message
      yield* Effect.logWarning(`${account.id}: usage poll failed: ${why}`)
      yield* pool.update((m) => failed(m, account.id, `usage poll: ${why}`))
      return
    }
    const { account: fresh, limits } = read.success
    yield* pool.update((m, now) => observe(m, account.id, limits, now))
    const plan = limits.plan
    if (plan !== undefined && plan !== fresh.identity.plan) {
      yield* accounts
        .update(
          account.id,
          (stored) => new Account({ ...stored, identity: new Identity({ ...stored.identity, plan }) }),
        )
        .pipe(Effect.catch((error) => Effect.logWarning(`${account.id}: saving plan: ${error.message}`)))
    }
  })

  const pollDue = Effect.fn("Quota.pollDue")(function* (options?: { readonly force?: boolean }) {
    const { pollMinutes } = yield* settingsService.get
    const every = Duration.minutes(Math.max(pollMinutes, 1))
    const now = yield* DateTime.now
    const m = yield* pool.model
    // Turned-off accounts are read too, so they show their windows.
    const due = (yield* accounts.list).filter(
      (account) =>
        account.authError === undefined &&
        isSubscription(account.provider) &&
        (options?.force === true || pollIsDue(healthOf(m, account.id), now, every)),
    )
    yield* Effect.forEach(due, poll, { concurrency: "unbounded", discard: true })
  })

  const listResets = Effect.fn("Quota.listResets")(function* (account: Account) {
    const { resets, userAgent } = yield* resetsOf(account)
    const current = yield* ready(account)
    const list = yield* onUpstream(resets.list(current, userAgent))
    yield* pool.update((m, now) => recordResets(m, account.id, list, now))
    return list
  })

  /** Lists one account's resets if due; a failure is logged, and an uncounted provider's next try waits its hour. */
  const listOne = (account: Account, resets: Resets, force: boolean) =>
    Effect.gen(function* () {
      const userAgent = yield* agentOf(account.provider)
      const now = yield* DateTime.now
      const health = healthOf(yield* pool.model, account.id)
      const nothingToList = resets.counted && (health.limits.resetCredits ?? 0) === 0 && resetsLeft(health, now) === 0
      if (!isWorking(account) || nothingToList || (resets.needsAgent && userAgent === undefined)) return
      if (!force && !listIsDue(health, resets.counted, now)) return
      const current = yield* Effect.option(ready(account))
      if (Option.isNone(current)) return
      const listed = yield* Effect.result(onUpstream(resets.list(current.value, userAgent)))
      if (listed._tag === "Success") {
        yield* pool.update((m) => recordResets(m, account.id, listed.success, now))
        return
      }
      yield* Effect.logWarning(`${account.id}: listing limit resets: ${listed.failure.message}`)
      if (!resets.counted) {
        yield* pool.update((m) => recordResets(m, account.id, unexpiredResets(health, now), now))
      }
    })

  const listDue = Effect.fn("Quota.listDue")(function* (options?: { readonly force?: boolean }) {
    for (const account of yield* accounts.list) {
      const resets = providerOf(account).resets
      if (Option.isSome(resets)) yield* listOne(account, resets.value, options?.force === true)
    }
  })

  const redeem = Effect.fn("Quota.redeem")(function* (account: Account, resetId?: string) {
    const { resets, userAgent } = yield* resetsOf(account)
    return yield* redeeming.withPermit(
      Effect.gen(function* () {
        const current = yield* ready(account)
        let id = resetId
        if (id === undefined) {
          const list = yield* onUpstream(resets.list(current, userAgent))
          yield* pool.update((m, now) => recordResets(m, account.id, list, now))
          id = list[0]?.id
          if (id === undefined) return "no-credit" as const
        }
        const outcome = yield* spend(resets, current, id, userAgent)
        if (outcome === "reset") yield* Effect.logInfo(`${account.id}: redeemed a limit reset on request`)
        return outcome
      }),
    )
  })

  /** Redeems the account's next reset if it expires within the lead; the list read is kept. */
  const redeemIfExpiring = (account: Account, resets: Resets, userAgent: string | undefined) =>
    Effect.gen(function* () {
      const list = yield* onUpstream(resets.list(account, userAgent))
      const now = yield* DateTime.now
      yield* pool.update((m) => recordResets(m, account.id, list, now))
      // Only the reset the provider would spend first: redeeming another out of order spends it instead.
      const first = list[0]
      if (first?.expiresAt === undefined) return
      if (Duration.isGreaterThan(DateTime.distance(now, first.expiresAt), expiryLead)) return
      const outcome = yield* spend(resets, account, first.id, userAgent)
      if (outcome === "reset") {
        yield* Effect.logInfo(`${account.id}: redeemed a limit reset before it expired`)
      } else {
        yield* Effect.logInfo(`${account.id}: expiring limit reset not used (${outcome})`)
      }
    })

  const redeemExpiring = Effect.gen(function* () {
    for (const account of yield* accounts.list) {
      const resets = providerOf(account).resets
      if (Option.isNone(resets)) continue
      const userAgent = yield* agentOf(account.provider)
      const now = yield* DateTime.now
      const health = healthOf(yield* pool.model, account.id)
      const inUse = health.limits.windows.some((window) => usedAt(window, now) > 0)
      if (
        (resets.value.needsAgent && userAgent === undefined) ||
        !isWorking(account) ||
        resetsLeft(health, now) === 0 ||
        !inUse
      ) {
        continue
      }
      yield* redeeming.withPermit(
        Effect.gen(function* () {
          const current = yield* Effect.option(ready(account))
          if (Option.isNone(current)) return
          yield* redeemIfExpiring(current.value, resets.value, userAgent).pipe(
            Effect.catch((error) => Effect.logWarning(`${account.id}: checking limit resets: ${error.message}`)),
          )
        }),
      )
    }
  }).pipe(Effect.withSpan("Quota.redeemExpiring"))

  const rescue = Effect.fn("Quota.rescue")(function* (provider: ProviderId) {
    const resets = providers[provider].resets
    if (Option.isNone(resets)) return Option.none<AccountId>()
    const userAgent = yield* agentOf(provider)
    if (resets.value.needsAgent && userAgent === undefined) return Option.none<AccountId>()
    return yield* redeeming.withPermit(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const m = yield* pool.model
        const candidates = (yield* accounts.list).filter(
          (account) => account.provider === provider && isWorking(account),
        )
        // Another request may have redeemed one while this one waited.
        const free = candidates.find((account) => !isBlocked(healthOf(m, account.id), now))
        if (free !== undefined) return Option.some(free.id)
        const spent = candidates
          .flatMap((account) => {
            const health = healthOf(m, account.id)
            const until = limitedUntil(health, now)
            return Option.isNone(until) || resetsLeft(health, now) === 0 ? [] : [{ account, until: until.value }]
          })
          // The account that would otherwise sit out longest is freed first.
          .toSorted((a, b) => DateTime.Order(b.until, a.until))
        for (const { account } of spent) {
          const current = yield* Effect.option(ready(account))
          if (Option.isNone(current)) continue
          // The soonest to expire when the list is known; else the provider
          // chooses, since listing now would hold up the request.
          const resetId = unexpiredResets(healthOf(yield* pool.model, account.id), now)[0]?.id
          const outcome = yield* Effect.result(spend(resets.value, current.value, resetId, userAgent))
          if (outcome._tag === "Failure") {
            yield* Effect.logWarning(`${account.id}: redeeming a limit reset: ${outcome.failure.message}`)
            continue
          }
          if (outcome.success === "reset") {
            yield* Effect.logInfo(`${account.id}: redeemed a limit reset`)
            return Option.some(account.id)
          }
          yield* Effect.logInfo(`${account.id}: limit reset not used (${outcome.success})`)
        }
        return Option.none<AccountId>()
      }),
    )
  })

  /** One tiny request on the account, recorded as slopmax's own. */
  const warmOne = (given: Account, model: string) =>
    Effect.gen(function* () {
      const account = yield* ready(given).pipe(
        Effect.mapError(() => new WarmupFailed({ reason: "its sign-in could not be refreshed" })),
      )
      const provider = providers.codex
      const m = yield* pool.model
      const client = new Headers({
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": `slopmax/${slopmaxVersion}`,
      })
      const started = yield* DateTime.now
      const response = yield* upstream
        .send({
          url: `${provider.apiOf(account)}/responses`,
          method: "POST",
          headers: provider.headers({ client, account, moved: false, agents: m.agents, codex: m.codex }),
          body: warmupBody(model),
        })
        .pipe(Effect.mapError((error) => new WarmupFailed({ reason: error.message })))
      const now = yield* DateTime.now
      const limits = provider.limitsFrom(response.headers, now)
      if (Option.isSome(limits)) yield* pool.update((model1) => observe(model1, account.id, limits.value, now))
      const body = yield* upstream
        .readAll(response, warmupLimit)
        .pipe(Effect.mapError((error) => new WarmupFailed({ reason: error.message })))
      if (response.status < 200 || response.status >= 300) {
        return yield* new WarmupFailed({ reason: `answered ${response.status}` })
      }
      const tap = Tap.forResponse("responses", response.headers)
      tap.chunk(body)
      const { usage } = tap.finish()
      const ended = yield* DateTime.now
      yield* pool.update((model1) => addUsage(model1, account.id, usage))
      yield* ledger.record(
        LedgerRecord.cases.Request.make({
          at: now,
          account: account.id,
          provider: "codex",
          model,
          status: response.status,
          usage,
          ms: Math.max(0, Duration.toMillis(DateTime.distance(started, ended))),
          attempts: 1,
          agent: "slopmax",
          via: "http",
        }),
      )
    })

  const warm = Effect.gen(function* () {
    const m = yield* pool.model
    const model = m.codex.lastModel
    if (model === undefined) return
    const now = yield* DateTime.now
    const idle = (yield* accounts.list).filter((account) => {
      if (account.provider !== "codex" || !isWorking(account)) return false
      const health = healthOf(m, account.id)
      const fiveHours = health.limits.windows.find((window) => window.span === "5h" && window.model === undefined)
      // An account with no 5-hour reading is not known to be idle.
      return !isBlocked(health, now) && fiveHours !== undefined && usedAt(fiveHours, now) === 0
    })
    for (const account of idle) {
      // Marked before trying, so a failure also waits its turn.
      const due = yield* Ref.modify(warmed, (marks): [boolean, ReadonlyMap<AccountId, DateTime.Utc>] => {
        const last = marks.get(account.id)
        if (last !== undefined && Duration.isLessThan(DateTime.distance(last, now), warmEvery)) return [false, marks]
        return [true, new Map(marks).set(account.id, now)]
      })
      if (!due) continue
      yield* warmOne(account, model).pipe(
        Effect.flatMap(() => Effect.logInfo(`${account.id}: started its 5-hour window early`)),
        Effect.catch((error) => Effect.logWarning(`${account.id}: warmup failed: ${error.reason}`)),
      )
    }
  }).pipe(Effect.withSpan("Quota.warm"))

  const refreshDue = Effect.gen(function* () {
    for (const tried of yield* accounts.refreshDue) {
      const error = tried.error
      if (error !== undefined) yield* pool.update((m) => failed(m, tried.id, error))
    }
  }).pipe(Effect.withSpan("Quota.refreshDue"))

  return { poll, pollDue, listResets, listDue, redeem, redeemExpiring, rescue, warm, refreshDue } satisfies Shape
})

/** Usage polls and limit resets. */
export class Quota extends Context.Service<Quota, Shape>()("@slopmax/core/Quota", { make }) {
  static readonly layer: Layer.Layer<Quota, never, Pool | Accounts | Upstream | SettingsService | Ledger> =
    Layer.effect(Quota, Quota.make)
}
