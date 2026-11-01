// The running proxy, seen from another process: the CLI, the desktop app's
// main process, the doctor. It is found by its `/healthz`, talked to through
// slopmax's own typed API with the owner key, started in the background (by
// the login service when one is installed, else as a detached `serve`), and
// asked to stop.
//
// Every call goes straight to the proxy's address on this machine: never
// through HTTPS_PROXY or the like, which is for reaching providers.
import { SlopmaxApi } from "@slopmax/domain/api"
import { Context, Data, Duration, Effect, FileSystem, Layer, Option, type Path, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { causeText, type FileError, Home } from "./home.ts"
import {
  detectServiceManager,
  type ExitFailed,
  type ManagerKind,
  type NoServiceManager,
  selfCommand,
  type ServiceManager,
  type SpawnFailed,
} from "./service.ts"
import { SettingsService } from "./settings.ts"

/** Nothing answers as slopmax on its address. */
export class NotRunning extends Data.TaggedError("NotRunning")<{ readonly baseUrl: string }> {
  override get message(): string {
    return `slopmax is not running on ${this.baseUrl}; start it with \`slopmax start\``
  }
}

/** A background proxy was asked for and did not come up. */
export class StartFailed extends Data.TaggedError("StartFailed")<{ readonly log: string; readonly cause?: unknown }> {
  override get message(): string {
    const why = this.cause === undefined ? "" : ` (${causeText(this.cause)})`
    return `the proxy did not start${why}; see ${this.log}`
  }
}

/** The running proxy would not stop. */
export class StopFailed extends Data.TaggedError("StopFailed")<{ readonly cause: unknown }> {
  override get message(): string {
    return `the proxy would not stop: ${causeText(this.cause)}`
  }
}

/** slopmax's typed API client. */
export type SlopmaxClient = HttpApiClient.ForApi<typeof SlopmaxApi>

/**
 * The login service, as `slopmax service` uses it: installing frees the port
 * first and waits for the service's proxy. The system's manager is looked
 * for on first use, so commands that never touch the service never run
 * `systemctl` to find it.
 */
export interface BackgroundService {
  /** None with SLOPMAX_NO_SERVICE, or when the system has no manager slopmax can use. */
  readonly kind: Effect.Effect<Option.Option<ManagerKind>>
  readonly status: ServiceManager["status"]
  readonly install: Effect.Effect<string, ExitFailed | SpawnFailed | FileError | NoServiceManager | StartFailed>
  readonly uninstall: ServiceManager["uninstall"]
  readonly start: ServiceManager["start"]
}

export interface Shape {
  /** The proxy's address. */
  readonly baseUrl: string
  /** The running proxy's version; none when nothing, or something other than slopmax, answers. */
  readonly running: Effect.Effect<Option.Option<{ readonly version: string }>>
  /** The API of the running proxy, with the owner key. */
  readonly client: Effect.Effect<SlopmaxClient, NotRunning>
  /** Starts the proxy in the background unless one runs; whether this call started it. */
  readonly ensure: Effect.Effect<{ readonly started: boolean }, StartFailed>
  /** Asks a running proxy to stop and waits until it has; false when none was running. */
  readonly stop: Effect.Effect<boolean, StopFailed>
  readonly service: BackgroundService
}

/** What `/healthz` answers. Anything else on the port is not slopmax. */
const Health = Schema.Struct({ service: Schema.Literal("slopmax"), version: Schema.String })

/** How long a check of `/healthz` waits: the proxy answers it at once, so a slow answer is not slopmax. */
const healthWait = Duration.seconds(2)

/** The longest any API call may take. */
const callWait = Duration.seconds(30)

/** How often a starting or stopping proxy is checked, and for how long in all. */
const settleEvery = Duration.millis(100)
const settleWithin = Duration.seconds(5)

/** The proxy has not come up, or gone away, yet. */
class StillWaiting extends Data.TaggedError("StillWaiting")<{}> {}

/** How long the old proxy is given to let go of the port before the service starts another. */
const portRelease = Duration.millis(300)

/** Every call goes straight to the address, even when the environment names a proxy. */
const direct: BunFetchRequestInit = { proxy: false }

export interface Options {
  /** How this slopmax is started again; itself by default. */
  readonly exe?: ReadonlyArray<string> | undefined
  /** The login service; the system's own by default. */
  readonly manager?: ServiceManager | undefined
  /** How often a starting or stopping proxy is checked, and for how long in all; tests shorten the wait. */
  readonly settle?: { readonly every: Duration.Duration; readonly within: Duration.Duration } | undefined
}

/**
 * A `Background` over the given seams. Requests go through the `fetch` in
 * `FetchHttpClient.Fetch` (the real network unless a test layer gives one),
 * always without a proxy.
 */
export const makeWith = (
  options: Options = {},
): Effect.Effect<
  Shape,
  never,
  SettingsService | Home | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const settings = yield* SettingsService
    const home = yield* Home
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exe = options.exe ?? selfCommand()
    const context = yield* Effect.context<
      SettingsService | Home | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >()
    const manager = yield* Effect.cached(
      options.manager === undefined
        ? Effect.provideContext(detectServiceManager(exe), context)
        : Effect.succeed(options.manager),
    )
    const baseUrl = yield* settings.baseUrl
    const fetch = yield* FetchHttpClient.Fetch

    const http = (yield* Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer)).pipe(
      HttpClient.timeout(callWait),
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(FetchHttpClient.RequestInit, direct),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        ),
      ),
    )

    const running: Shape["running"] = http.get(`${baseUrl}/healthz`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
      Effect.timeout(healthWait),
      Effect.map((health) => Option.some({ version: health.version })),
      Effect.orElseSucceed(() => Option.none<{ readonly version: string }>()),
      Effect.withSpan("Background.running"),
    )

    const api = yield* HttpApiClient.make(SlopmaxApi, {
      baseUrl,
      // The key is read at each call, so a key changed in config.json is used at once.
      transformClient: HttpClient.mapRequestEffect((request) =>
        Effect.map(settings.get, (current) => HttpClientRequest.bearerToken(request, current.apiKey)),
      ),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http))

    const client: Shape["client"] = Effect.flatMap(running, (found) =>
      Option.isSome(found) ? Effect.succeed(api) : Effect.fail(new NotRunning({ baseUrl })),
    )

    /** Waits until the proxy answers (`up`) or stops answering (not `up`), for about 5 seconds at most. */
    const settle = (up: boolean) =>
      running.pipe(
        Effect.flatMap((found) => (Option.isSome(found) === up ? Effect.void : Effect.fail(new StillWaiting()))),
        Effect.retry(Schedule.spaced(options.settle?.every ?? settleEvery)),
        // A port that takes connections and never answers must not keep the wait going past its limit.
        Effect.timeoutOrElse({
          duration: options.settle?.within ?? settleWithin,
          orElse: () => Effect.fail(new StillWaiting()),
        }),
      )

    const launchDetached = Effect.gen(function* () {
      yield* home.privateDir(home.paths.root)
      const [program = "slopmax", ...leading] = exe
      // Its own process group and no terminal, so it outlives the shell that started it; it writes its own log.
      const command = ChildProcess.make(program, [...leading, "serve", "--log", home.paths.log], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      // Unreferenced for good: the effect that would reference it again is dropped on purpose.
      yield* Effect.scoped(Effect.flatMap(spawner.spawn(command), (handle) => Effect.asVoid(handle.unref)))
    })

    const ensure: Shape["ensure"] = Effect.gen(function* () {
      if (Option.isSome(yield* running)) return { started: false }
      const service = yield* manager
      const status = yield* service.status
      if (Option.isSome(service.kind) && status.installed) yield* service.start
      else yield* launchDetached
      yield* settle(true)
      return { started: true }
    }).pipe(
      Effect.mapError(
        (cause) => new StartFailed({ log: home.paths.log, ...(cause instanceof StillWaiting ? {} : { cause }) }),
      ),
      Effect.withSpan("Background.ensure"),
    )

    const stop: Shape["stop"] = Effect.gen(function* () {
      if (Option.isNone(yield* running)) return false
      yield* api.system.shutdown().pipe(Effect.mapError((cause) => new StopFailed({ cause })))
      yield* settle(false).pipe(Effect.mapError(() => new StopFailed({ cause: "it still answers after 5 seconds" })))
      return true
    }).pipe(Effect.withSpan("Background.stop"))

    const install: BackgroundService["install"] = Effect.gen(function* () {
      const service = yield* manager
      if (Option.isSome(service.kind)) {
        // The service's proxy needs the port, so a proxy started some other way stops first.
        yield* stop.pipe(Effect.mapError((cause) => new StartFailed({ log: home.paths.log, cause })))
        yield* Effect.sleep(portRelease)
      }
      const file = yield* service.install
      yield* settle(true).pipe(Effect.mapError(() => new StartFailed({ log: home.paths.log })))
      return file
    }).pipe(Effect.withSpan("Background.installService"))

    const service: BackgroundService = {
      kind: Effect.map(manager, (found) => found.kind),
      status: Effect.flatMap(manager, (found) => found.status),
      install,
      uninstall: Effect.flatMap(manager, (found) => found.uninstall),
      start: Effect.flatMap(manager, (found) => found.start),
    }

    return { baseUrl, running, client, ensure, stop, service }
  })

/** The running proxy, from outside. */
export class Background extends Context.Service<Background, Shape>()("@slopmax/core/Background", {
  make: makeWith(),
}) {
  static readonly layer: Layer.Layer<
    Background,
    never,
    SettingsService | Home | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > = Layer.effect(Background, Background.make)

  /** Tests: a given program to start, a given login service, a shorter wait. */
  static readonly layerWith = (
    options: Options,
  ): Layer.Layer<
    Background,
    never,
    SettingsService | Home | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > => Layer.effect(Background, makeWith(options))
}
