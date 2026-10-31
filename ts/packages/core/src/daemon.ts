// The long-running proxy and its background work: picking up account
// changes, keeping tokens fresh, polling usage, and saving state.
import process from "node:process"

import { Cause, Deferred, Duration, Effect, Schedule, Schema, type Scope } from "effect"

import { log, SignedDuration, Timestamp } from "@slopmax/common"
import { Origins, server } from "@slopmax/net"

import type { Account } from "./account.ts"
import { ensureFresh } from "./auth/connect.ts"
import { Config, NotifySettings, SocketAddr } from "./config.ts"
import { chain, Failure } from "./error.ts"
import * as fsx from "./fsx.ts"
import { Window } from "./limits.ts"
import { nudges, send, Subject, Watcher } from "./notify.ts"
import { Home } from "./paths.ts"
import { AccountState, State, StateSchema } from "./pool.ts"
import type { Outcome } from "./provider/credits.ts"
import { ProviderId } from "./provider/mod.ts"
import { listCredits, pollAll } from "./polls.ts"
import { outcomeDebug } from "./proxy/app.ts"
import { App, httpApp } from "./proxy/mod.ts"
import * as warm from "./proxy/warm.ts"
import { VERSION } from "./version.ts"
import * as waste from "./waste.ts"

/** How close to expiry a reset credit is redeemed rather than lost. */
export const CREDIT_EXPIRY_LEAD: SignedDuration = SignedDuration.fromHours(3)
/** How often account conditions are compared for notifications. */
const WATCH_EVERY = Duration.seconds(15)

const NudgedSchema = Schema.Array(Schema.String)

// The polls and listings, in `polls.ts` so the admin API can import them.
export { listCredits, pollAll, pollOne } from "./polls.ts"

export const run = (config: Config): Effect.Effect<void, Failure> =>
  Effect.flatMap(Home.current, (home) => serve(config, home, new Origins()))

/**
 * Runs the proxy from `home`, sending provider traffic to `origins`
 * (benchmarks point them at a local mock).
 */
export const serve = (config: Config, home: Home, origins: Origins): Effect.Effect<void, Failure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const listen = config.listen
      const address = SocketAddr.display(listen)
      const listener = yield* server.bind({ hostname: listen.ip, port: listen.port }).pipe(
        Effect.catch((cause) =>
          Effect.flatMap(server.portHolder(listen.port), (holder) =>
            Effect.fail(
              new Failure({
                message:
                  holder === undefined
                    ? `cannot listen on ${address}`
                    : `cannot listen on ${address}: ${holder} is using that port`,
                cause: new Failure({ message: cause.reason }),
              }),
            ),
          ),
        ),
      )
      const state: State =
        (yield* fsx
          .readJson(home.state(), StateSchema)
          .pipe(Effect.mapError((e) => new Failure({ message: e.message, cause: e })))) ?? State.empty()
      const app = yield* App.make(config, home, state, origins)
      yield* app.sync
      yield* start(app)

      log.info(`slopmax ${VERSION} listening on ${Config.baseUrl(yield* app.config)}`)
      yield* server.serve(listener, httpApp(app), shutdown(app))
      yield* saveState(app)
      log.info("stopped")
    }),
  )

/**
 * Starts the background tasks in the scope, each now and then every
 * `period`. A run that overruns its period delays the next one, which
 * then follows at once; runs never overlap or pile up.
 */
export const start = (app: App): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* every(
      "2 seconds",
      Effect.gen(function* () {
        const synced = yield* Effect.result(app.sync)
        if (synced._tag === "Failure") log.warn(`reloading accounts: ${chain(synced.failure)}`)
        yield* app.reloadConfig
      }),
    )
    yield* every("10 seconds", saveState(app))
    // Each task asks the config as it runs, so a changed config.toml turns
    // it on or off without a restart.
    yield* every(
      "300 seconds",
      Effect.gen(function* () {
        if ((yield* app.config).refreshTokens) yield* refreshAll(app)
      }),
    )
    yield* every("60 seconds", listCredits(app, false))
    yield* every(
      "1800 seconds",
      Effect.gen(function* () {
        if ((yield* app.config).redeemExpiringCredits) yield* redeemExpiring(app)
      }),
    )
    yield* every(
      "60 seconds",
      Effect.gen(function* () {
        if ((yield* app.config).warmWindows) yield* warm.idleAccounts(app)
      }),
    )
    yield* Effect.forkScoped(watch(app))
    yield* every(
      "60 seconds",
      Effect.gen(function* () {
        if ((yield* app.config).pollMins > 0) yield* pollAll(app, false)
      }),
    )
  })

/** Runs `task` now and then every `period`, in a fiber of the scope. */
const every = (period: Duration.Input, task: Effect.Effect<void>): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(
    Effect.forkScoped(
      Effect.repeat(
        task.pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.warn(`a background task failed: ${Cause.pretty(cause)}`))),
        ),
        Schedule.fixed(period),
      ),
    ),
  )

/** Ctrl-C, SIGTERM (Unix), or `POST /slopmax/shutdown`. */
const shutdown = (app: App): Effect.Effect<void> =>
  Effect.raceFirst(
    Effect.callback<void>((resume) => {
      const signals: Array<NodeJS.Signals> = process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM"]
      const handler = (): void => resume(Effect.void)
      for (const signal of signals) process.once(signal, handler)
      return Effect.sync(() => {
        for (const signal of signals) process.off(signal, handler)
      })
    }),
    Deferred.await(app.shutdown),
  )

/** Sends a notification for each change in the accounts' conditions. */
const watch = Effect.fn("daemon.watch")(function* (app: App): Effect.fn.Return<void> {
  // The nudges told before a restart stay told.
  const file = app.home.nudged()
  const told = yield* Effect.orElseSucceed(fsx.readJson(file, NudgedSchema), () => undefined)
  const watcher = Watcher.remembering(told ?? [])
  const tick = Effect.gen(function* () {
    const now = yield* Timestamp.now
    const inner = yield* app.pool.get
    const events = watcher.changes(inner.accounts, (id) => inner.states.get(id) ?? AccountState.empty(), now)
    const config = yield* app.config
    const report = yield* app.report
    const subjects = report.accounts.map(Subject.of)
    const found = nudges(subjects, config.redeemExpiringCredits, config.planPrices, now)
    const fresh = watcher.newNudges(found)
    if (fresh.length > 0) {
      const saved = yield* Effect.result(fsx.writeJson(file, NudgedSchema, watcher.told()))
      if (saved._tag === "Failure") log.warn(`saving the nudges told: ${saved.failure.message}`)
    }
    for (const event of [...events, ...fresh]) {
      log.info(event.message)
      if (!NotifySettings.isEnabled(config.notify)) continue
      const sent = yield* Effect.result(send(config.notify, app.authHttp, event))
      if (sent._tag === "Failure") log.warn(`sending a notification: ${chain(sent.failure)}`)
    }
  })
  yield* Effect.repeat(
    tick.pipe(
      Effect.catchCause((cause) => Effect.sync(() => log.warn(`watching accounts failed: ${Cause.pretty(cause)}`))),
    ),
    Schedule.fixed(WATCH_EVERY),
  )
})

/** Saves the pool's state when it changed, after writing down the windows that reset. */
export const saveState = Effect.fn("daemon.saveState")(function* (app: App): Effect.fn.Return<void> {
  const now = yield* Timestamp.now
  yield* recordLapses(app, now)
  const [state, dirty] = yield* app.pool.snapshot(now)
  if (!dirty) return
  const saved = yield* Effect.result(fsx.writeJson(app.home.state(), StateSchema, state))
  if (saved._tag === "Failure") log.warn(`saving state: ${saved.failure.message}`)
})

/**
 * Writes down the windows that reset, with how much of each was used, for
 * what was left on the table.
 */
const recordLapses = Effect.fn("daemon.recordLapses")(function* (app: App, now: Timestamp): Effect.fn.Return<void> {
  const lapses = yield* app.pool.takeLapses(now)
  if (lapses.length === 0) return
  const accounts = yield* app.pool.accounts
  const records: Array<waste.Record> = []
  for (const [id, lapse] of lapses) {
    const account = accounts.find((a) => a.id === id)
    if (account === undefined) continue
    records.push({
      endedAt: lapse.endedAt,
      account: id,
      provider: account.provider,
      ...(account.plan === undefined ? {} : { plan: account.plan }),
      span: lapse.span,
      ...(lapse.model === undefined ? {} : { model: lapse.model }),
      used: lapse.used,
    })
  }
  const written = yield* Effect.result(waste.append(app.home.windows(), records))
  if (written._tag === "Failure") log.warn(`recording reset windows: ${chain(written.failure)}`)
})

/**
 * Refreshes tokens that are close to expiring, so a request never waits
 * on a refresh. Disabled accounts are kept fresh too.
 */
const refreshAll = Effect.fn("daemon.refreshAll")(function* (app: App): Effect.fn.Return<void> {
  for (const account of yield* app.pool.accounts) {
    if (account.authError !== undefined) continue
    const fresh = yield* Effect.result(ensureFresh(app.authHttp, app.store, account, false))
    if (fresh._tag === "Failure") {
      log.warn(`${account.id}: ${fresh.failure.message}`)
      yield* app.pool.recordError(account.id, fresh.failure.message)
    }
  }
})

/**
 * Redeems reset credits about to expire on accounts with usage to reset.
 * A lapsed credit is simply lost, so spending it first is free quota.
 */
export const redeemExpiring = Effect.fn("daemon.redeemExpiring")(function* (app: App) {
  const now = yield* Timestamp.now
  for (const account of yield* app.pool.accounts) {
    const credits = ProviderId.get(account.provider).credits()
    if (credits === undefined) continue
    const state = yield* app.pool.state(account.id)
    const used = state.limits.windows.some((w) => Window.usedAt(w, now) > 0)
    if (
      (credits.needsAgent && (yield* app.pool.agent(account.provider)) === undefined) ||
      account.disabled ||
      account.authError !== undefined ||
      AccountState.creditsLeft(state, now) === 0 ||
      !used
    ) {
      continue
    }
    yield* app.redeeming.withPermit(
      Effect.gen(function* () {
        const ready = yield* app.ready(account)
        if (ready === undefined) return
        const result = yield* Effect.result(redeemIfExpiring(app, ready, now))
        if (result._tag === "Failure") {
          log.warn(`${ready.id}: checking limit resets: ${chain(result.failure)}`)
          return
        }
        const redeemed = result.success
        if (redeemed === undefined) return
        const [outcome, credit] = redeemed
        if (outcome === "reset") {
          log.info(`${ready.id}: redeemed a limit reset before it expired`)
          yield* app.pool.recordReset(ready.id, yield* Timestamp.now, credit)
        } else {
          log.info(`${ready.id}: expiring limit reset not used (${outcomeDebug(outcome)})`)
        }
      }),
    )
  }
})

/**
 * Redeems the account's first credit if it lapses within
 * `CREDIT_EXPIRY_LEAD`, returning how that went and the credit's id. The
 * list it reads is kept for the account.
 */
const redeemIfExpiring = Effect.fn("daemon.redeemIfExpiring")(function* (
  app: App,
  account: Account,
  now: Timestamp,
): Effect.fn.Return<readonly [Outcome, string] | undefined, Failure> {
  const credits = ProviderId.get(account.provider).credits()
  if (credits === undefined) return undefined
  const agent = yield* app.pool.agent(account.provider)
  const available = yield* credits.list(app.authHttp, account, agent)
  yield* app.pool.recordCredits(account.id, available, now)
  const first = available[0]
  const expiring =
    first?.expiresAt !== undefined && Timestamp.durationSince(first.expiresAt, now) <= CREDIT_EXPIRY_LEAD
      ? first
      : undefined
  if (expiring === undefined) return undefined
  const outcome = yield* credits.redeem(app.authHttp, account, agent, expiring.id)
  return [outcome, expiring.id] as const
})
