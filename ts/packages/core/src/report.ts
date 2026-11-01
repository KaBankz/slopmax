// The status report, built from the pool: every account and how it stands,
// each subscription's working accounts read as one, who a new session would
// get and why, and what is worth doing before it is lost. The daemon serves
// it live; the CLI builds it from disk when no daemon runs.
import {
  type AccountId,
  type AccountView as AccountViewType,
  AccountView,
  conditionOf,
  isSubscription,
  notesOf,
  PoolView,
  providerFacts,
  providerOrder,
  Report,
  type Settings,
  slopmaxVersion,
} from "@slopmax/domain"
import { DateTime, type Duration, Effect, Option } from "effect"
import type { Account } from "./account.ts"
import { nudges } from "./notifier.ts"
import {
  healthOf,
  limitedUntil,
  next,
  Pool,
  type PoolModel,
  pooledView,
  resetsLeft,
  routingOf,
  sessionCounts,
  unexpiredResets,
} from "./pool.ts"
import { pricingOf } from "./pricing.ts"
import { providers } from "./providers/registry.ts"
import { Quota } from "./quota.ts"
import { SettingsService } from "./settings.ts"

/** One account as every front end shows it. `sessions` is how many live sessions it serves. */
export const accountView = (m: PoolModel, account: Account, sessions: number, now: DateTime.Utc): AccountViewType => {
  const health = healthOf(m, account.id)
  const metered = !isSubscription(account.provider)
  const credential = account.credential
  const pinned = m.pins[account.provider] === account.id
  const follows = credential._tag === "OAuth" ? credential.follows?.tool : undefined
  const tokenExpiresAt = credential._tag === "OAuth" ? credential.tokens.expiresAt : undefined
  const plan = account.identity.plan ?? health.limits.plan
  const condition = conditionOf(
    {
      authError: account.authError,
      disabled: account.disabled,
      limitedUntil: limitedUntil(health, now),
      throttledUntil: health.throttledUntil,
      sessions,
    },
    now,
  )
  const models =
    credential._tag === "Endpoint" ? credential.models : metered ? providerFacts[account.provider].models : []
  return new AccountView({
    id: account.id,
    provider: account.provider,
    name: account.name,
    ...(account.identity.email === undefined ? {} : { email: account.identity.email }),
    ...(plan === undefined ? {} : { plan }),
    disabled: account.disabled,
    priority: account.priority,
    pinned,
    ...(follows === undefined ? {} : { follows }),
    ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
    ...(metered ? { endpoint: providers[account.provider].apiOf(account) } : {}),
    models,
    sessions,
    condition,
    notes: notesOf({
      pinned,
      priority: account.priority,
      follows,
      resets: resetsLeft(health, now),
      served: health.served,
      lastError: health.lastError,
      condition,
    }),
    windows: health.limits.windows,
    resets: unexpiredResets(health, now),
    ...(health.lastUsed === undefined ? {} : { lastUsed: health.lastUsed }),
    served: health.served,
  })
}

/** What a report is built from. */
export interface ReportInput {
  readonly model: PoolModel
  readonly settings: Settings
  readonly now: DateTime.Utc
  /** From a running proxy, with its live sessions; from disk, every session count is 0. */
  readonly live: boolean
  /** Where the nudges' times are told. */
  readonly zone: DateTime.TimeZone
  /** The accounts, in list order; the pool's when absent. */
  readonly accounts?: ReadonlyArray<Account> | undefined
}

/**
 * The status report: each account as a view, a pool for each subscription
 * with a working account (with the account a new session would get), and
 * the nudges the accounts call for now.
 */
export const buildReport = (input: ReportInput): Report => {
  const { model, settings, now } = input
  const ttl: Duration.Duration = routingOf(settings).ttl
  const counts = input.live ? sessionCounts(model, now, ttl) : new Map<AccountId, number>()
  const accounts = (input.accounts ?? model.accounts).map((account) =>
    accountView(model, account, counts.get(account.id) ?? 0, now),
  )
  const pools: Array<PoolView> = providerOrder
    .filter(isSubscription)
    .flatMap((provider) => Option.toArray(pooledView(model, provider, now)))
    .map((view) =>
      Option.match(next(model, view.provider, settings.strategy, now), {
        onNone: () => view,
        onSome: (chosen) => new PoolView({ ...view, next: chosen }),
      }),
    )
  return new Report({
    version: slopmaxVersion,
    live: input.live,
    generatedAt: now,
    strategy: settings.strategy,
    accounts,
    pools,
    nudges: nudges(accounts, {
      autoRedeem: settings.redeemExpiring,
      pricing: pricingOf(settings),
      now,
      zone: input.zone,
    }),
  })
}

/** The time zone people read times in: the one in context, else the machine's. */
export const currentZone = Effect.map(Effect.serviceOption(DateTime.CurrentTimeZone), (zone) =>
  Option.getOrElse(zone, DateTime.zoneMakeLocal),
)

/** The report of the pool as it is now. */
export const report = (live: boolean): Effect.Effect<Report, never, Pool | SettingsService> =>
  Effect.gen(function* () {
    const pool = yield* Pool
    const settings = yield* (yield* SettingsService).get
    return buildReport({
      model: yield* pool.model,
      settings,
      now: yield* DateTime.now,
      live,
      zone: yield* currentZone,
    })
  }).pipe(Effect.withSpan("Report.build"))

/**
 * The report from disk, for when no proxy runs. With `refresh`, every
 * subscription account that is signed in has its usage read first (a
 * failure shows as its last error) and `state.json` is written; the caller
 * makes sure no daemon writes it at the same time.
 */
export const offline = (options: {
  readonly refresh: boolean
}): Effect.Effect<Report, never, Pool | Quota | SettingsService> =>
  Effect.gen(function* () {
    const pool = yield* Pool
    if (options.refresh) {
      yield* (yield* Quota).pollDue({ force: true })
      yield* pool.save.pipe(Effect.catch((error) => Effect.logWarning(`saving the pool: ${error.message}`)))
    }
    return yield* report(false)
  }).pipe(Effect.withSpan("Report.offline"))
