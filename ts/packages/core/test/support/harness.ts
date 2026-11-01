// The real daemon for end-to-end scenarios: the proxy, its API, the hub and
// the socket relay, built from `Daemon.layerWith` with no schedules (a
// scenario runs a task itself when it needs one), over the accounts it is
// given and providers answered by scripts.
//
// - `Harness.memory`: an in-memory disk and providers answered in process;
//   requests go to the front door's handler directly. Fast, and the same
//   code path a socket reaches.
// - `Harness.ports`: a temporary home on the real disk, the daemon on
//   127.0.0.1:0, and the mock provider on another loopback port, reached by
//   rewriting every provider origin. Requests travel over real sockets, so
//   streaming, WebSockets and restarts behave as they do for people.
//
// Both run with the owner key `sm-test-key`, fill-first placement and token
// refreshing off unless the scenario's settings say otherwise.
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import type { AccountId, LedgerRecord, Settings } from "@slopmax/domain"
import { SlopmaxApi } from "@slopmax/domain/api"
import { TestHome } from "@slopmax/test"
import { Context, DateTime, Effect, Exit, Layer, References, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { type Account, accountText } from "../../src/account.ts"
import { Accounts } from "../../src/accounts.ts"
import type { CoreServices, DaemonError, DaemonServices } from "../../src/daemon.ts"
import { type FileError, Home } from "../../src/home.ts"
import { Ledger } from "../../src/ledger.ts"
import { Lock } from "../../src/lock.ts"
import { type Health, healthOf, Pool } from "../../src/pool.ts"
import { Settler } from "../../src/proxy/settle.ts"
import { Server } from "../../src/server.ts"
import { SettingsService } from "../../src/settings.ts"
import { Upstream } from "../../src/upstream.ts"
import { apiStack, daemonOver, client as inProcessClient } from "../api/stack.ts"
import {
  type ConnectProxy,
  connectProxy,
  type Client as SocketClient,
  openClient,
  type Refused,
} from "../dial/support.ts"
import * as Clients from "./clients.ts"
import { endpointsOrigin, providers } from "./fixtures.ts"
import type { MemoryUpstream, Route } from "./memory-upstream.ts"
import { type MockProvider, mockProvider } from "./mock-provider.ts"

export interface Options {
  /** The accounts in the store when the daemon starts. */
  readonly accounts?: ReadonlyArray<Account>
  /** The provider scripts: every provider in `fixtures.ts` by default. */
  readonly routes?: ReadonlyArray<Route>
  /** Settings beyond the harness's own, as `config.json` would write them. */
  readonly settings?: Partial<typeof Settings.Encoded>
  /** More files in the home when it starts, by path relative to it. */
  readonly files?: Readonly<Record<string, string>>
}

export interface PortsOptions extends Options {
  /**
   * Reach the mock through an HTTP CONNECT proxy, as behind a corporate
   * proxy: the mock goes by a name that is not loopback (loopback is always
   * reached directly), and the proxy tunnels that name to it.
   */
  readonly throughProxy?: boolean
}

/** A temporary home on the real disk. */
export type HomeShape = Effect.Success<ReturnType<typeof TestHome.make>>

/** What a scenario reaches inside the daemon. */
export type Services = DaemonServices | CoreServices

/** slopmax's typed client, as every front end uses it. */
export type ApiClient = HttpApiClient.ForApi<typeof SlopmaxApi>

export interface Harness {
  readonly transport: "memory" | "ports"
  /** The proxy's base URL, as clients are configured with it. */
  readonly base: string
  /** Every call that reached a provider, by the URL slopmax meant. */
  readonly upstream: MemoryUpstream
  /** Sends a request and hands back the answer as it streams; interrupting it cancels the request. */
  readonly fetch: (request: Request) => Effect.Effect<Response, Clients.Unanswered>
  /** Sends a request and reads the answer whole. */
  readonly send: (request: Request) => Effect.Effect<Clients.Answer, Clients.Unanswered>
  /** A request as Claude Code makes one. */
  readonly claude: (options?: Clients.CallOptions) => Effect.Effect<Clients.Answer, Clients.Unanswered>
  /** A request as Codex makes one. */
  readonly codex: (options?: Clients.CallOptions) => Effect.Effect<Clients.Answer, Clients.Unanswered>
  /** A Chat Completions request for `model`, as an OpenAI-style tool makes one. */
  readonly chat: (model: string, options?: Clients.CallOptions) => Effect.Effect<Clients.Answer, Clients.Unanswered>
  /** Any other call, with the owner key unless `key` says otherwise. */
  readonly call: (
    method: string,
    path: string,
    options?: Parameters<typeof Clients.other>[3],
  ) => Effect.Effect<Clients.Answer, Clients.Unanswered>
  /** slopmax's typed API client. */
  readonly api: Effect.Effect<ApiClient>
  /** Runs `effect` inside the daemon, on its services. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.Effect<A, E>
  /** Waits until every finished answer has been applied to the pool and the ledger. */
  readonly settled: Effect.Effect<void>
  /** Every ledger record so far, once settled and written. */
  readonly ledger: Effect.Effect<ReadonlyArray<LedgerRecord>, FileError>
  /** An account's health now. */
  readonly health: (id: AccountId) => Effect.Effect<Health>
}

export interface PortsHarness extends Harness {
  readonly transport: "ports"
  readonly mock: MockProvider
  /** The CONNECT proxy between slopmax and the mock, when the scenario asked for one. */
  readonly proxy: ConnectProxy | undefined
  readonly home: HomeShape
  /** Where the daemon listens, as `host:port`. */
  readonly address: string
  /** Opens a socket to `/codex/responses` as Codex does. */
  readonly socket: (headers: Readonly<Record<string, string>>) => Effect.Effect<SocketClient, Refused, Scope.Scope>
  /** Stops this daemon as `slopmax stop` would: drained, its last writes made, its lock let go. */
  readonly stop: Effect.Effect<void>
  /** Stops this daemon and starts another on the same home and providers. */
  readonly restart: Effect.Effect<PortsHarness, StartError, Scope.Scope>
  /** Starts a second daemon on the same home while this one runs (which the home's lock refuses). */
  readonly alongside: Effect.Effect<PortsHarness, StartError, Scope.Scope>
}

/** The settings every harness runs with, beneath the scenario's own. */
const baseSettings = (given: Partial<typeof Settings.Encoded> | undefined, listen: string) => ({
  strategy: "fill-first" as const,
  refreshTokens: false,
  listen,
  ...given,
})

/**
 * The daemon logs each request and its start and stop at Info; scenarios
 * check what it did through its services, so only warnings and errors are
 * shown, where they help explain a failure.
 */
const quiet = Layer.succeed(References.MinimumLogLevel)("Warn")

/**
 * What a scenario checks once answers are in, run inside the daemon: every
 * daemon-level test (the harness's and the proxy's) waits and reads the same way.
 */
export const inDaemon = {
  /** Waits until every finished answer has been applied to the pool and the ledger. */
  settled: Effect.flatMap(Settler, (settler) => settler.flush),
  /** Every ledger record so far, once settled and written. */
  ledger: Effect.gen(function* () {
    yield* Effect.flatMap(Settler, (settler) => settler.flush)
    const ledger = yield* Ledger
    yield* ledger.flush
    return yield* ledger.load(DateTime.makeUnsafe(0))
  }),
  /** An account's health now. */
  health: (id: AccountId) =>
    Effect.map(
      Effect.flatMap(Pool, (pool) => pool.model),
      (m) => healthOf(m, id),
    ),
} as const

/** The parts of a harness that only need a way to send and a context to run in. */
const common = (
  transport: "memory" | "ports",
  base: string,
  upstream: MemoryUpstream,
  context: Context.Context<Services>,
  send: (request: Request, signal: AbortSignal) => Promise<Response>,
  api: Effect.Effect<ApiClient>,
): Harness => {
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.provideContext(effect, context)
  const fetch = (request: Request) =>
    Effect.tryPromise({ try: (signal) => send(request, signal), catch: (cause) => new Clients.Unanswered({ cause }) })
  const sendWhole = (request: Request) => Effect.flatMap(fetch(request), Clients.read)
  return {
    transport,
    base,
    upstream,
    fetch,
    send: sendWhole,
    claude: (options) => sendWhole(Clients.claudeCode(base, options)),
    codex: (options) => sendWhole(Clients.codex(base, options)),
    chat: (model, options) => sendWhole(Clients.chat(base, model, options)),
    call: (method, path, options) => sendWhole(Clients.other(base, method, path, options)),
    api,
    run,
    settled: run(inDaemon.settled),
    ledger: run(inDaemon.ledger),
    health: (id) => run(inDaemon.health(id)),
  }
}

/** The daemon in process: an in-memory disk, providers answered in process, requests handed to the front door. */
const memory = (options: Options = {}): Effect.Effect<Harness, DaemonError, Scope.Scope> =>
  Effect.gen(function* () {
    const stack = apiStack({
      routes: options.routes ?? providers,
      accounts: options.accounts ?? [],
      settings: baseSettings(options.settings, "127.0.0.1:9"),
      ...(options.files === undefined ? {} : { files: options.files }),
    })
    const context = yield* Layer.build(stack.layer.pipe(Layer.provide(quiet)))
    const server = Context.get(context, Server)
    return common(
      "memory",
      "http://slopmax.test",
      stack.upstream,
      context,
      (request, signal) => Promise.resolve(server.fetch(new Request(request, { signal }))),
      Effect.provideContext(inProcessClient, context),
    )
  })

/** The real file system and paths, under every ports harness. */
const disk = Layer.merge(BunFileSystem.layer, BunPath.layer)

/** Writes the accounts and files a scenario starts with into the home. */
const seed = (home: HomeShape, options: Options) =>
  Effect.gen(function* () {
    const files = yield* Home
    for (const account of options.accounts ?? []) {
      yield* files.writeText(`${files.paths.accounts}/${account.id}.json`, accountText(account))
    }
    for (const [path, text] of Object.entries(options.files ?? {})) {
      yield* files.writeText(`${files.paths.root}/${path}`, text)
    }
  }).pipe(Effect.provide(Home.layerAt(home.slopmax).pipe(Layer.provide(disk))))

/**
 * `settings` with the mock as the outbound proxy, unless the scenario names
 * its own. Rewritten calls go to the mock on loopback, which skips any
 * proxy; a call to a host nobody rewrote goes to the mock as its proxy,
 * which refuses it and keeps it in `leaks`, so it never reaches the network.
 */
const guarded = <S extends Partial<typeof Settings.Encoded>>(mock: MockProvider, settings: S) => ({
  upstreamProxy: mock.url,
  ...settings,
})

/** Fails the scenario if any call reached for a host nobody rewrote. */
const noLeaks = (mock: MockProvider) =>
  Effect.addFinalizer(() =>
    mock.leaks.length === 0
      ? Effect.void
      : Effect.die(`calls to hosts nobody rewrote to the mock: ${mock.leaks.join(", ")}`),
  )

/** The daemon over the real disk at `home`, reaching providers at `mock`, listening on a free loopback port. */
const daemonOnPorts = (options: Options, mock: MockProvider, home: HomeShape) =>
  daemonOver(
    Accounts.layer.pipe(
      // Every outbound call goes to the mock: inference, sign-in, usage, limit resets and model lists.
      Layer.provideMerge(Upstream.layerOrigins(mock.origins([endpointsOrigin]))),
      Layer.provideMerge(SettingsService.layerValue(guarded(mock, baseSettings(options.settings, "127.0.0.1:0")))),
      Layer.provideMerge(Lock.layer),
      Layer.provideMerge(Home.layerAt(home.slopmax)),
      Layer.provideMerge(disk),
    ),
    { listen: true },
  )

/** Why a daemon on ports would not start. */
export type StartError = Layer.Error<ReturnType<typeof daemonOnPorts>>

/** Starts a daemon on `home` in a scope of its own under `parent`, so it can be stopped and started again. */
const startOnPorts = (
  options: Options,
  mock: MockProvider,
  proxy: ConnectProxy | undefined,
  home: HomeShape,
  parent: Scope.Scope,
): Effect.Effect<PortsHarness, StartError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(parent)
    const context = yield* Layer.buildWithScope(
      daemonOnPorts(options, mock, home).pipe(Layer.provide(quiet)),
      scope,
    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
    const server = Context.get(context, Server)
    const base = `http://${server.address}`
    const api = HttpApiClient.make(SlopmaxApi, {
      baseUrl: base,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(Clients.ownerKey)),
    }).pipe(Effect.provide(FetchHttpClient.layer))
    const stop = Scope.close(scope, Exit.void)
    const harness: PortsHarness = {
      ...common("ports", base, mock.upstream, context, (request, signal) => fetch(request, { signal }), api),
      transport: "ports",
      mock,
      proxy,
      home,
      address: server.address,
      socket: (headers) => openClient(`ws://${server.address}/codex/responses`, headers),
      stop,
      restart: Effect.flatMap(Effect.scope, (outer) =>
        Effect.andThen(stop, startOnPorts(options, mock, proxy, home, outer)),
      ),
      alongside: Effect.flatMap(Effect.scope, (outer) => startOnPorts(options, mock, proxy, home, outer)),
    }
    return harness
  })

/**
 * The daemon on a loopback port over a temporary home, reaching the mock
 * provider over the network. The home, the mock and the daemon last as long
 * as the scope.
 */
const ports = (options: PortsOptions = {}): Effect.Effect<PortsHarness, StartError | FileError, Scope.Scope> =>
  Effect.gen(function* () {
    const home = yield* TestHome.make("e2e").pipe(Effect.provide(disk), Effect.orDie)
    const throughProxy = options.throughProxy === true
    const mock = yield* mockProvider({
      routes: options.routes ?? providers,
      ...(throughProxy ? { alias: "provider.mock" } : {}),
    })
    yield* noLeaks(mock)
    const proxy = throughProxy
      ? yield* connectProxy(undefined, { host: "127.0.0.1", port: Number(new URL(mock.url).port) })
      : undefined
    const settings = proxy === undefined ? options.settings : { ...options.settings, upstreamProxy: proxy.url }
    yield* seed(home, options)
    return yield* startOnPorts(
      { ...options, ...(settings === undefined ? {} : { settings }) },
      mock,
      proxy,
      home,
      yield* Effect.scope,
    )
  })

/** slopmax's outbound client with every provider origin sent to `mock`, for checks below the daemon. */
const upstreamTo = (mock: MockProvider) =>
  Upstream.layerOrigins(mock.origins([endpointsOrigin])).pipe(
    Layer.provide(SettingsService.layerValue(guarded(mock, {}))),
  )

export const Harness = { memory, ports, upstreamTo } as const

/** Both harnesses, for scenarios that must behave the same in process and over the network. */
export const transports = [
  ["in process", memory],
  ["over the network", ports],
] as const
