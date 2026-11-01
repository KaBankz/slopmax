// The front door: one `Bun.serve` for every client slopmax serves.
//
// Each request is classified by a pure function of its method, path and a
// few headers. `/healthz` is a prebuilt answer with no code run per
// request. Inference runs one Effect per request on services built once,
// and a client that hangs up before its answer starts interrupts it. The
// Codex WebSocket relay and the web app (slopmax's own API, the dashboard,
// the hub) plug into slots: until they are provided, a socket hears 426 (so
// Codex streams over HTTP) and a web path 404.
//
// Shutdown stops accepting, lets answers in flight finish for up to 10
// seconds, then closes what is left.
import { slopmaxVersion } from "@slopmax/domain"
import {
  Cause,
  Clock,
  Config,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  References,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { splitListen } from "./doctor.ts"
import { portHolder } from "./port-holder.ts"
import { classify, type Route } from "./proxy/classify.ts"
import { Proxy } from "./proxy/forward.ts"
import { drainWait, LiveStreams } from "./proxy/live.ts"
import { defect, health, healthBody, hello, noSocket, noWebApp, unknownPath } from "./proxy/replies.ts"
import { SettingsService } from "./settings.ts"

/** The listener's server, as the socket relay upgrades through it. */
export type SocketServer = Bun.Server<unknown>

/** The Codex WebSocket relay's slot. */
export interface RelayShape {
  /** Upgrades a socket handshake, answering instead when it will not relay it; undefined once upgraded. */
  readonly accept: (
    request: Request,
    server: SocketServer | undefined,
    route: Route,
  ) => Response | undefined | Promise<Response | undefined>
  /** Bun's handlers for relayed sockets. */
  readonly websocket: Bun.WebSocketHandler<unknown>
}

/** Relays Codex's WebSockets to ChatGPT. */
export class Relay extends Context.Service<Relay, RelayShape>()("@slopmax/core/Relay") {
  /** No relay: every handshake hears 426, so Codex streams over HTTP at once. */
  static readonly refuse: Layer.Layer<Relay> = Layer.succeed(Relay)({
    accept: () => noSocket(),
    websocket: { message: () => undefined },
  })
}

/** The web app's slot: slopmax's own API, the dashboard and the hub. */
export interface WebAppShape {
  readonly handle: (request: Request) => Response | Promise<Response>
}

/** Serves slopmax's own API, the dashboard and the hub, with the same services as the proxy. */
export class WebApp extends Context.Service<WebApp, WebAppShape>()("@slopmax/core/WebApp") {
  /** No web app: its paths answer 404. */
  static readonly none: Layer.Layer<WebApp> = Layer.succeed(WebApp)({ handle: noWebApp })
}

/** The proxy could not listen where the settings say. */
export class ListenFailed extends Data.TaggedError("ListenFailed")<{
  readonly address: string
  /** The program holding the port, when it can be named. */
  readonly holder: string | undefined
  readonly cause: unknown
}> {
  override get message(): string {
    return this.holder === undefined
      ? `cannot listen on ${this.address}`
      : `cannot listen on ${this.address}: ${this.holder} is using that port`
  }
}

export interface Shape {
  /** Where it listens, as `host:port`; `memory` when it answers in process only. */
  readonly address: string
  /** Answers one request, exactly as a client on the socket would be answered. */
  readonly fetch: (request: Request) => Response | Promise<Response>
  /** Stops accepting and lets answers in flight finish (at most 10 seconds). Runs once. */
  readonly drain: Effect.Effect<void>
}

type Fetch = (
  request: Request,
  server: SocketServer | undefined,
) => Response | undefined | Promise<Response | undefined>

/** The front door's handler, over services built once. */
const frontDoor = Effect.gen(function* () {
  const proxy = yield* Proxy
  const relay = yield* Relay
  const web = yield* WebApp
  // Every request runs on this context: the same clock, logger and services as the layer was built with.
  // Requests make no trace spans unless SLOPMAX_TRACE=1 asks for them: a span per step costs more than
  // the step on the hot path, and nobody reads them otherwise.
  const trace = yield* Config.Boolean("SLOPMAX_TRACE").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  )
  const context = Context.add(yield* Effect.context<never>(), References.TracerEnabled, trace)
  const run = Effect.runCallbackWith(context)
  const runFork = Effect.runForkWith(context)

  const answer = (
    request: Request,
    dialect: Route["dialect"] | undefined,
    name: string,
    effect: Effect.Effect<Response>,
  ) =>
    new Promise<Response>((resolve) => {
      const interrupt = run(trace ? Effect.withSpan(effect, name) : effect, {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) return resolve(exit.value)
          // A client that hung up needs no answer and is no fault; anything else is a bug in slopmax,
          // which its log must show whole.
          if (!Cause.hasInterruptsOnly(exit.cause)) {
            runFork(
              Effect.logError(
                `answering ${request.method} ${new URL(request.url).pathname} failed`,
                Cause.pretty(exit.cause),
              ),
            )
          }
          resolve(defect(dialect, exit.cause))
        },
      })
      // A client gone before its answer starts takes the request with it.
      request.signal.addEventListener("abort", () => interrupt(), { once: true })
    })

  const fetch: Fetch = (request, server) => {
    const entry = classify(request.method, request.url, request.headers)
    switch (entry._tag) {
      case "Health":
        return health()
      case "Hello":
        return hello()
      case "Unknown":
        return unknownPath()
      case "Web":
        return web.handle(request)
      case "Models":
        return answer(request, "chat", "Proxy.models", proxy.models(request))
      case "Socket":
        return relay.accept(request, server, entry.route)
      case "Inference":
        return answer(request, entry.route.dialect, "Proxy.handle", proxy.handle(request, entry.route))
    }
  }
  return { fetch, websocket: relay.websocket }
})

/** A front-door answer as a response: a socket that was upgraded has none, which in-process callers hear as 426. */
const settled = (answered: Response | undefined | Promise<Response | undefined>): Response | Promise<Response> => {
  if (answered === undefined) return noSocket()
  return answered instanceof Promise ? answered.then((response) => response ?? noSocket()) : answered
}

const healthResponse = new Response(healthBody, { headers: { "content-type": "application/json" } })

const listen = Effect.gen(function* () {
  const settings = yield* SettingsService
  const live = yield* LiveStreams
  const { fetch, websocket } = yield* frontDoor
  const address = settings.running.listen
  const { host: hostname, port } = splitListen(address)
  const server = yield* Effect.try({
    try: () =>
      Bun.serve<unknown>({
        hostname,
        port,
        // Answers can be quiet for minutes; the stall sweeper, not the socket, decides when one is dead.
        idleTimeout: 0,
        // The proxy refuses an oversized body itself, in the client's own format; Bun's refusal is an empty 413.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        routes: { "/healthz": { GET: healthResponse } },
        fetch: (request, srv) => fetch(request, srv),
        websocket,
      }),
    catch: (cause) => new ListenFailed({ address, holder: undefined, cause }),
  }).pipe(
    // Name the program holding the port, when the system can say.
    Effect.catchTag("ListenFailed", (failed) =>
      Effect.flatMap(
        Effect.orElseSucceed(portHolder(port), () => Option.none<string>()),
        (holder) =>
          Effect.fail(new ListenFailed({ address, holder: Option.getOrUndefined(holder), cause: failed.cause })),
      ),
    ),
  )
  // Startup code stays in the interpreter; serving gets the full JIT from here on.
  Bun.unsafe.setJITPolicy(1)
  const bound = `${server.hostname?.includes(":") === true ? `[${server.hostname}]` : (server.hostname ?? hostname)}:${server.port ?? port}`

  // Run once, however many times it is asked for: by the API's shutdown, then by the scope closing.
  const drain = yield* Effect.cached(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const stopped = server.stop(false)
      yield* live.drain(drainWait)
      // Requests still waiting on a provider get what is left of the wait, then every connection closes.
      const left = Duration.toMillis(drainWait) - ((yield* Clock.currentTimeMillis) - startedAt)
      yield* Effect.callback<void>((resume) => {
        stopped.then(
          () => resume(Effect.void),
          () => resume(Effect.void),
        )
      }).pipe(Effect.timeoutOption(Duration.millis(Math.max(0, left))))
      yield* Effect.promise(() => server.stop(true))
    }),
  )
  yield* Effect.addFinalizer(() => drain)
  yield* Effect.logInfo(`slopmax ${slopmaxVersion} listening on http://${bound}`)
  return { address: bound, fetch: (request) => settled(fetch(request, server)), drain } satisfies Shape
})

const inMemory = Effect.gen(function* () {
  const live = yield* LiveStreams
  const { fetch } = yield* frontDoor
  const drain = yield* Effect.cached(live.drain(drainWait))
  return { address: "memory", fetch: (request: Request) => settled(fetch(request, undefined)), drain } satisfies Shape
})

/** The proxy's listener. */
export class Server extends Context.Service<Server, Shape>()("@slopmax/core/Server") {
  /** Listens where the settings say until the scope closes, then drains. */
  static readonly layer: Layer.Layer<
    Server,
    ListenFailed,
    | Proxy
    | Relay
    | WebApp
    | SettingsService
    | LiveStreams
    | FileSystem.FileSystem
    | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(Server, listen)

  /** The same front door with no socket: tests and in-process callers hand it requests directly. */
  static readonly layerMemory: Layer.Layer<Server, never, Proxy | Relay | WebApp | LiveStreams> = Layer.effect(
    Server,
    inMemory,
  )
}
