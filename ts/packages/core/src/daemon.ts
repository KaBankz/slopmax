// The daemon: the proxy, its API and the background work that keeps the
// pool true, for as long as `slopmax serve` runs.
//
// Starting takes the home's `serve` lock (a second daemon on one home would
// fight over `state.json`), loads `state.json` (a malformed one stops the
// start rather than lose every block and session), brings the pool in step
// with the accounts, listens, and starts the periodic tasks. Stopping
// drains the server, applies what finished answers left behind, writes the
// ledger and `state.json` a last time, and lets the lock go.
//
// Every periodic task runs at once, then a full period after each run ends:
// a slow run delays the next, a run never overlaps itself, and there is no
// burst of catch-up runs. Each reads the settings when it runs, so turning
// a task off or on applies without a restart. A failed run is logged and
// the schedule goes on.
import { BunServices } from "@effect/platform-bun"
import { Cause, Duration, Effect, Exit, type FileSystem, Layer, type Path, Schedule } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Settings } from "@slopmax/domain"
import { Accounts } from "./accounts.ts"
import type { Assets } from "./api/assets.ts"
import { Shutdown } from "./api/handlers.ts"
import { Logins } from "./api/logins.ts"
import { publishStatus } from "./api/status.ts"
import { webAppLayer } from "./api/web.ts"
import { Background } from "./background.ts"
import { Events } from "./events.ts"
import { type FileError, Home } from "./home.ts"
import { Ledger } from "./ledger.ts"
import { type AlreadyServing, Lock } from "./lock.ts"
import * as Log from "./log.ts"
import { Notifier } from "./notifier.ts"
import { lapses, Pool, prune } from "./pool.ts"
import { Proxy } from "./proxy/forward.ts"
import type { LiveStreams } from "./proxy/live.ts"
import { type Replay, Settler } from "./proxy/settle.ts"
import { relayLayer } from "./proxy/socket.ts"
import { Quota } from "./quota.ts"
import { report } from "./report.ts"
import { type ListenFailed, type Relay, Server, type WebApp } from "./server.ts"
import { SettingsService } from "./settings.ts"
import { Upstream } from "./upstream.ts"

/** The services every slopmax process runs on, the daemon and the CLI alike. */
export type CoreServices =
  | Home
  | Lock
  | SettingsService
  | Upstream
  | Accounts
  | Events
  | Ledger
  | Background
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner

/**
 * The services every process runs on, over the platform: the home, its
 * locks, the settings, the network, the accounts, the event feed, the
 * ledger, and the running proxy as seen from outside.
 */
export const CoreBase = Layer.mergeAll(Accounts.layer, Ledger.layer, Background.layer).pipe(
  Layer.provideMerge(Upstream.layer),
  Layer.provideMerge(Events.layer),
  Layer.provideMerge(SettingsService.layer),
  Layer.provideMerge(Lock.layer),
  Layer.provideMerge(Home.layer),
)

/** The pool, quota and notices over the base: what the CLI works with when it acts without a daemon. */
const engine = Layer.mergeAll(Quota.layer, Notifier.layer.pipe(Layer.provide(Pool.told))).pipe(
  Layer.provideMerge(Pool.layer),
)

/** Every live layer the CLI runs on, over Bun. */
export const CoreLive = engine.pipe(Layer.provideMerge(CoreBase), Layer.provideMerge(BunServices.layer))

/**
 * Runs `task` at once and then `period` after each run ends, for the life
 * of the scope, while `when` says so of the settings at that moment. A
 * failure is logged and never ends the schedule.
 */
export const every = <E, R>(
  period: Duration.Input,
  task: Effect.Effect<void, E, R>,
  when: (settings: Settings) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService
    if (when(yield* settings.get)) yield* task
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(Cause.pretty(cause)),
    ),
    Effect.repeat(Schedule.spaced(period)),
    Effect.forkScoped,
  )

/** Records the windows that ended, lets go of idle sessions, and writes `state.json` when anything changed. */
export const keepState = Effect.gen(function* () {
  const pool = yield* Pool
  const ledger = yield* Ledger
  const settings = yield* SettingsService
  // Taken from the pool and queued for the ledger in one step: a stop between
  // the two would lose the windows, since the pool counts them recorded. The
  // ledger's writer puts them on disk, and its last flush at stop waits for it.
  yield* pool
    .modify((m, now) => lapses(m, now))
    .pipe(
      Effect.flatMap((ended) => Effect.forEach(ended, ledger.record, { discard: true })),
      Effect.uninterruptible,
    )
  const { sessionMinutes } = yield* settings.get
  yield* pool.update((m, now) => prune(m, now, Duration.minutes(sessionMinutes)))
  yield* pool.save.pipe(Effect.catch((error) => Effect.logWarning(`saving state: ${error.message}`)))
})

/** One look at the live report for changes worth telling people about. */
export const lookForNotices = Effect.gen(function* () {
  const notifier = yield* Notifier
  yield* notifier.look(yield* report(true))
})

/** The tasks that keep tokens, readings and limit resets current, each under the setting that turns it on. */
export const quotaTasks = Effect.gen(function* () {
  const quota = yield* Quota
  yield* every("5 minutes", quota.refreshDue, (s) => s.refreshTokens)
  yield* every("1 minute", quota.listDue())
  yield* every("30 minutes", quota.redeemExpiring, (s) => s.redeemExpiring)
  yield* every("1 minute", quota.warm, (s) => s.warmWindows)
  yield* every("1 minute", quota.pollDue(), (s) => s.pollMinutes > 0)
})

/** The daemon's periodic tasks, forked into the scope. */
export const schedules = Effect.gen(function* () {
  // Settings and accounts reload when their files change, and are read again every 30 seconds in case a change was missed.
  yield* (yield* SettingsService).follow
  yield* (yield* Accounts).follow
  yield* every("10 seconds", keepState)
  yield* every("15 seconds", lookForNotices)
  yield* quotaTasks
})

/**
 * Holds the home's `serve` lock for the daemon's life; `stopped` is logged
 * once everything else has closed. A start that failed never served, so it
 * says only why.
 */
const held = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* Lock).hold("serve")
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.logInfo("stopped"),
    )
  }),
)

/** Once the server has drained: finished answers applied, the ledger written, `state.json` saved. */
const lastWrites = Layer.effectDiscard(
  Effect.gen(function* () {
    const settler = yield* Settler
    const ledger = yield* Ledger
    const pool = yield* Pool
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* settler.flush
        yield* ledger.flush
        yield* pool.save.pipe(Effect.catch((error) => Effect.logWarning(`saving state: ${error.message}`)))
      }),
    )
  }),
)

export interface DaemonOptions {
  /** Run the periodic tasks and follow the files (the default). Tests leave them off and call each task themselves. */
  readonly schedules?: boolean | undefined
  /** Listen on a socket (the default), or answer only through `Server.fetch` in this process. */
  readonly listen?: boolean | undefined
}

/** What a running daemon provides, beside the core services. */
export type DaemonServices =
  Pool | Quota | Notifier | Logins | Shutdown | Proxy | Settler | LiveStreams | Replay | Relay | WebApp | Server

/** Why a daemon would not start. */
export type DaemonError = AlreadyServing | FileError | ListenFailed

const daemonLayer = (options: DaemonOptions = {}): Layer.Layer<DaemonServices, DaemonError, CoreServices | Assets> => {
  const work = Layer.effectDiscard(
    Effect.gen(function* () {
      // Built last, so closed first: event streams end before the server drains.
      yield* Effect.addFinalizer(() => Effect.flatMap(Effect.service(Shutdown), (shutdown) => shutdown.begin))
      yield* publishStatus
      if (options.schedules ?? true) yield* schedules
    }),
  )
  const server = options.listen === false ? Server.layerMemory : Server.layer
  return work.pipe(
    Layer.provideMerge(server),
    Layer.provideMerge(Layer.merge(webAppLayer, relayLayer)),
    Layer.provideMerge(lastWrites),
    Layer.provideMerge(Proxy.layerWithParts),
    Layer.provideMerge(Layer.mergeAll(Logins.layer, Shutdown.layer)),
    Layer.provideMerge(engine),
    Layer.provideMerge(held),
  )
}

/** The running daemon over the core services, until the scope closes. Its parts stay its own. */
const running: Layer.Layer<never, DaemonError, CoreServices | Assets> = daemonLayer()

/** The daemon: its layer, and `serve`, which runs it until it is asked to stop. */
export const Daemon = {
  layer: running,
  /** The daemon with some parts left out, for tests. */
  layerWith: daemonLayer,
  /**
   * Serves until `POST /slopmax/api/shutdown`, or until interrupted (the
   * CLI's runtime turns SIGINT and SIGTERM into an interruption), logging to
   * `log` when given.
   */
  serve: (options: { readonly log?: string | undefined } = {}) =>
    Effect.flatMap(Effect.service(Shutdown), (shutdown) => shutdown.requested).pipe(
      Effect.provide(daemonLayer().pipe(Layer.provide(CoreBase))),
      Effect.provide(Log.layer({ fallback: "Info", file: options.log })),
    ),
}
