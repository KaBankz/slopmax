// The proxy as the app sees it. The daemon is the app's engine: the app
// starts it with the bundled CLI at launch, keeps where it runs and its owner
// key (which only main ever holds), and follows its state for the window, the
// tray and the panel. A proxy of another release is restarted on the bundled
// CLI, unless a login service runs it, in which case the window says so and
// offers the restart instead of talking to it unawares.
import { Context, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import {
  OfflineView,
  type ProxyAction,
  ProxyState,
  type ServiceAction,
  ServiceView,
  ShellResult,
  type StartedProxy,
} from "@slopmax/domain/desktop"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Cli, CliFailed } from "./cli.ts"

/** A running proxy, as main uses it: where it is, its owner key, and its release. */
export interface Connection {
  readonly url: string
  readonly key: Redacted.Redacted<string>
  readonly version: string
}

/** The owner key in the dashboard's address that `start --json` prints (`…/slopmax/#key=sm-…`). */
export const keyFromDashboard = (dashboard: string): Option.Option<string> => {
  const hash = dashboard.split("#")[1] ?? ""
  const value = new URLSearchParams(hash).get("key")
  return value === null || value === "" ? Option.none() : Option.some(value)
}

export const connectionOf = (started: StartedProxy): Effect.Effect<Connection, CliFailed> =>
  Option.match(keyFromDashboard(started.dashboard), {
    onNone: () => Effect.fail(new CliFailed({ message: "the proxy's address came without its owner key" })),
    onSome: (key) => Effect.succeed({ url: started.url, key: Redacted.make(key), version: started.version }),
  })

/**
 * What to do about a running proxy's release. The same release as the
 * bundled CLI (or a CLI that cannot say) is used as it is. Another release is
 * restarted on the bundled CLI, unless a login service runs it: restarting
 * that one by hand would only bring the old release back, so it is flagged.
 */
export const versionVerdict = (
  running: string,
  bundled: Option.Option<string>,
  service: Option.Option<ServiceView>,
): "use" | "restart" | "flag" => {
  if (Option.isNone(bundled) || bundled.value === running) return "use"
  return Option.exists(service, (found) => found.installed) ? "flag" : "restart"
}

/** The dashboard's address on the running proxy, carrying the key the window never holds (`#key=…`). */
export const withKey = (url: string, connection: Connection): Option.Option<string> => {
  const parsed = URL.parse(url)
  const base = URL.parse(connection.url)
  // Only the proxy's own dashboard gets the key; any other address opens as it is.
  if (parsed === null || base === null) return Option.none()
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/slopmax/")) return Option.none()
  parsed.hash = new URLSearchParams({ key: Redacted.value(connection.key) }).toString()
  return Option.some(parsed.toString())
}

/** Whether two states read the same, so a repeated one is not told again. */
export const sameState = Schema.toEquivalence(ProxyState)

const Health = Schema.Struct({ version: Schema.String })

/** How long a call waits for a start under way before it is told the proxy is not running. */
export const startWait = "20 seconds"

/** Whether the app is still finding out where the proxy stands. */
export const settling = (state: ProxyState): boolean => state._tag === "Checking" || state._tag === "Starting"

/** How long `/healthz` may take; it is a prebuilt answer, so a proxy that is up answers at once. */
const healthWait = "2 seconds"

interface View {
  readonly proxy: ProxyState
  /** The last proxy the app reached: kept while it is stopped, so the app notices when it comes back. */
  readonly connection: Option.Option<Connection>
}

export interface Shape {
  readonly state: Effect.Effect<ProxyState>
  /** The state now, then every change. */
  readonly changes: Stream.Stream<ProxyState>
  /** The proxy to talk to: only while it runs on the bundled release. */
  readonly running: Effect.Effect<Option.Option<Connection>>
  /** The proxy to talk to, after waiting out a start under way (at most `startWait`). */
  readonly ready: Effect.Effect<Option.Option<Connection>>
  /** The last proxy reached, running or not. */
  readonly last: Effect.Effect<Option.Option<Connection>>
  /** Whether a proxy answers at `url`, and its release. */
  readonly alive: (url: string) => Effect.Effect<Option.Option<string>>
  /** Makes sure the proxy runs (APP-013): at launch, on Start, and when one is seen coming back. */
  readonly launch: Effect.Effect<ShellResult>
  readonly act: (action: ProxyAction) => Effect.Effect<ShellResult>
  readonly service: (action: ServiceAction) => Effect.Effect<ShellResult>
  /** The report and the doctor read from the files, for the window while the proxy is stopped. */
  readonly offline: Effect.Effect<OfflineView, CliFailed>
  /** The event stream said hello: the proxy is up, on this release. */
  readonly heard: (version: string) => Effect.Effect<void>
  /** The event stream dropped: the proxy stopped, restarted, or changed its key. */
  readonly lost: Effect.Effect<void>
  /** The proxy refused the key: read it again; the new connection when it changed. */
  readonly refreshKey: Effect.Effect<Option.Option<Connection>>
}

const ok = (message = "") => new ShellResult({ ok: true, message })
const failed = (error: CliFailed) => new ShellResult({ ok: false, message: error.message })

const make = Effect.gen(function* () {
  const cli = yield* Cli
  const http = yield* HttpClient.HttpClient
  const view = yield* SubscriptionRef.make<View>({
    proxy: ProxyState.cases.Checking.make({}),
    connection: Option.none(),
  })
  // One change of the proxy at a time: a Start pressed while the app is
  // restarting a proxy of another release waits for that to finish.
  const lock = yield* Semaphore.make(1)

  const set = (proxy: ProxyState, connection?: Option.Option<Connection>) =>
    SubscriptionRef.update(view, (now) => ({ proxy, connection: connection ?? now.connection }))

  const alive: Shape["alive"] = (url) =>
    http.get(`${url}/healthz`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
      Effect.map((health) => Option.some(health.version)),
      Effect.timeout(healthWait),
      Effect.orElseSucceed(() => Option.none<string>()),
    )

  const bundled = cli.version.pipe(Effect.option)
  // The release pair a restart was already tried for. A restart that still
  // brings up the other release (a CLI whose `--version` and proxy disagree)
  // is not tried again, or every reconnect would cut agents off once more;
  // the window offers the restart instead. Reaching the bundled release clears it.
  const restarted = yield* Ref.make(Option.none<string>())
  const use = (connection: Connection) =>
    Effect.andThen(
      Ref.set(restarted, Option.none()),
      set(ProxyState.cases.Running.make({ version: connection.version }), Option.some(connection)),
    )

  /** Takes a proxy `start --json` reported: uses it, restarts it on the bundled release, or flags it. */
  const adopt = Effect.fn("Engine.adopt")(function* (started: StartedProxy) {
    let connection = yield* connectionOf(started)
    const release = yield* bundled
    if (versionVerdict(connection.version, release, Option.none()) === "use") return yield* use(connection)
    const service = yield* cli.serviceStatus.pipe(Effect.option)
    const pair = `${connection.version} on ${Option.getOrElse(release, () => "")}`
    const tried = Option.contains(yield* Ref.get(restarted), pair)
    if (!tried && versionVerdict(connection.version, release, service) === "restart") {
      yield* Effect.logInfo(`restarting the proxy (${connection.version}) on the bundled release`)
      yield* Ref.set(restarted, Option.some(pair))
      yield* cli.stop
      connection = yield* Effect.flatMap(cli.start, connectionOf)
      if (versionVerdict(connection.version, release, Option.none()) === "use") return yield* use(connection)
    }
    yield* set(
      ProxyState.cases.OtherVersion.make({
        running: connection.version,
        bundled: Option.getOrElse(release, () => connection.version),
        service: Option.exists(service, (found) => found.installed),
      }),
      Option.some(connection),
    )
  })

  const launchNow = Effect.gen(function* () {
    yield* set(ProxyState.cases.Starting.make({}))
    yield* Effect.flatMap(cli.start, adopt)
  }).pipe(
    Effect.as(ok()),
    Effect.catch((error) =>
      Effect.as(
        Effect.andThen(
          Effect.logWarning(`could not start the proxy: ${error.message}`),
          set(ProxyState.cases.Stopped.make({})),
        ),
        failed(error),
      ),
    ),
    Effect.withSpan("Engine.launch"),
  )

  const launch = lock.withPermit(launchNow)

  const stopNow = cli.stop.pipe(
    Effect.andThen(set(ProxyState.cases.Stopped.make({}))),
    Effect.as(ok()),
    Effect.catch((error) => Effect.succeed(failed(error))),
  )

  const act: Shape["act"] = Effect.fn("Engine.act")(
    function* (action: ProxyAction) {
      switch (action) {
        case "start":
          return yield* launchNow
        case "stop":
          return yield* stopNow
        case "restart": {
          const now = (yield* SubscriptionRef.get(view)).proxy
          // A login service is pointed at the bundled CLI again, which restarts it there.
          if (now._tag === "OtherVersion" && now.service) {
            const installed = yield* cli.serviceInstall.pipe(
              Effect.as(ok()),
              Effect.catch((e) => Effect.succeed(failed(e))),
            )
            if (!installed.ok) return installed
            return yield* launchNow
          }
          const stopped = yield* stopNow
          return stopped.ok ? yield* launchNow : stopped
        }
      }
    },
    (effect) => lock.withPermit(effect),
  )

  const service: Shape["service"] = Effect.fn("Engine.service")(function* (action: ServiceAction) {
    switch (action) {
      case "status":
        return yield* cli.serviceStatus.pipe(
          Effect.map((status) => ok(JSON.stringify(Schema.encodeSync(ServiceView)(status)))),
          Effect.catch((error) => Effect.succeed(failed(error))),
        )
      case "install":
      case "uninstall": {
        const done = yield* (action === "install" ? cli.serviceInstall : cli.serviceUninstall).pipe(
          Effect.as(ok()),
          Effect.catch((error) => Effect.succeed(failed(error))),
        )
        // Installing restarts the proxy under the service; removing the service stopped it, so
        // either way the app starts it again its own way, or learns where the new one runs.
        if (done.ok) yield* launch
        return done
      }
    }
  })

  const heard: Shape["heard"] = Effect.fn("Engine.heard")(
    function* (version: string) {
      const now = yield* SubscriptionRef.get(view)
      if (now.proxy._tag === "Running" && now.proxy.version === version) return
      // Already settled as another release: the window offers the restart.
      if (now.proxy._tag === "OtherVersion" && now.proxy.running === version) return
      if (Option.isNone(now.connection)) return
      const release = yield* bundled
      if (versionVerdict(version, release, Option.none()) === "use") {
        return yield* use({ ...now.connection.value, version })
      }
      // A proxy of another release came up meanwhile: settle it as at launch.
      yield* Effect.flatMap(cli.start, adopt).pipe(Effect.catch(() => set(ProxyState.cases.Stopped.make({}))))
    },
    (effect) => lock.withPermit(effect),
  )

  const lost: Shape["lost"] = Effect.gen(function* () {
    const now = yield* SubscriptionRef.get(view)
    if (now.proxy._tag !== "Running" && now.proxy._tag !== "OtherVersion") return
    if (Option.isNone(now.connection)) return yield* set(ProxyState.cases.Stopped.make({}))
    const up = yield* alive(now.connection.value.url)
    if (Option.isNone(up)) return yield* set(ProxyState.cases.Stopped.make({}))
    // Still up: it restarted, maybe on another release or with another key, so read it again.
    yield* launchNow
  }).pipe(lock.withPermit, Effect.withSpan("Engine.lost"))

  const refreshKey: Shape["refreshKey"] = Effect.gen(function* () {
    const before = (yield* SubscriptionRef.get(view)).connection
    const started = yield* cli.start.pipe(Effect.option)
    if (Option.isNone(started)) return Option.none<Connection>()
    yield* adopt(started.value).pipe(Effect.ignore)
    const after = yield* SubscriptionRef.get(view)
    if (after.proxy._tag !== "Running" || Option.isNone(after.connection)) return Option.none<Connection>()
    const now = after.connection.value
    const changed = Option.match(before, {
      onNone: () => true,
      onSome: (was) => Redacted.value(was.key) !== Redacted.value(now.key),
    })
    return changed ? Option.some(now) : Option.none<Connection>()
  }).pipe(lock.withPermit, Effect.withSpan("Engine.refreshKey"))

  const changes = SubscriptionRef.changes(view).pipe(
    Stream.map((now) => now.proxy),
    Stream.changesWith(sameState),
  )
  const running = Effect.map(SubscriptionRef.get(view), (now) =>
    now.proxy._tag === "Running" ? now.connection : Option.none<Connection>(),
  )

  return {
    state: Effect.map(SubscriptionRef.get(view), (now) => now.proxy),
    changes,
    running,
    ready: changes.pipe(
      Stream.filter((state) => !settling(state)),
      Stream.runHead,
      Effect.timeoutOption(startWait),
      Effect.andThen(running),
    ),
    last: Effect.map(SubscriptionRef.get(view), (now) => now.connection),
    alive,
    launch,
    act,
    service,
    offline: Effect.map(
      Effect.all([cli.status, cli.doctor], { concurrency: "unbounded" }),
      ([report, doctor]) => new OfflineView({ report, doctor }),
    ),
    heard,
    lost,
    refreshKey,
  } satisfies Shape
})

/** The proxy the app runs and follows. */
export class Engine extends Context.Service<Engine, Shape>()("slopmax-desktop/Engine") {
  static readonly layer: Layer.Layer<Engine, never, Cli | HttpClient.HttpClient> = Layer.effect(Engine, make)
}
