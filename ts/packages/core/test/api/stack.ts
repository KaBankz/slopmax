// The daemon in process for the API's tests: the real daemon layer without
// its schedules or a socket, over an account store on an in-memory disk and
// providers answered by scripts. Requests go straight to the front door, as
// a client on the socket would send them.
import type { Settings } from "@slopmax/domain"
import { SlopmaxApi } from "@slopmax/domain/api"
import { Effect, type FileSystem, Layer, type Path } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { type Account, accountText } from "../../src/account.ts"
import type { Accounts } from "../../src/accounts.ts"
import { type Asset, Assets } from "../../src/api/assets.ts"
import { ApiDoctorOptions } from "../../src/api/handlers.ts"
import { Background } from "../../src/background.ts"
import { Daemon } from "../../src/daemon.ts"
import { Events } from "../../src/events.ts"
import type { Home } from "../../src/home.ts"
import { Ledger } from "../../src/ledger.ts"
import type { Lock } from "../../src/lock.ts"
import { Server } from "../../src/server.ts"
import type { SettingsService } from "../../src/settings.ts"
import type { Upstream } from "../../src/upstream.ts"
import { home, storeLayer } from "../providers/support.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"
import { field, parseJson } from "../support/clients.ts"
import { memoryUpstream, type Route } from "../support/memory-upstream.ts"

export { field }

export { home }

export const key = "sm-test-key"

export interface Options {
  readonly routes?: ReadonlyArray<Route>
  readonly accounts?: ReadonlyArray<Account>
  readonly settings?: Partial<typeof Settings.Encoded>
  /** More files in the home, by path relative to it. */
  readonly files?: Readonly<Record<string, string>>
  readonly assets?: Readonly<Record<string, Asset>>
  /** Listen on the settings' address (else answer in process only). */
  readonly listen?: boolean
}

/** Nothing in these tests reaches a real address: the background client's probes fail at once. */
export const noNetwork = Layer.succeed(FetchHttpClient.Fetch)(
  Object.assign(() => Promise.reject(new Error("no network in tests")), { preconnect: () => undefined }),
)

/**
 * The real daemon without its schedules over `store` (the home, the
 * settings, the network and the accounts): the one composition every
 * daemon-level test runs on, whatever disk and providers lie beneath.
 */
export const daemonOver = <E, R>(
  store: Layer.Layer<SettingsService | Upstream | Accounts | Home | Lock | FileSystem.FileSystem | Path.Path, E, R>,
  options: { readonly listen?: boolean; readonly assets?: Readonly<Record<string, Asset>> } = {},
) => {
  const core = Layer.mergeAll(Ledger.layer, Background.layer.pipe(Layer.provide(noNetwork))).pipe(
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(store),
    // No program is on this machine: the doctor and the login service find none.
    Layer.provideMerge(recordingSpawner(() => "missing").layer),
  )
  return Daemon.layerWith({ schedules: false, listen: options.listen ?? false }).pipe(
    Layer.provideMerge(core),
    Layer.provideMerge(
      Layer.merge(
        options.assets === undefined ? Assets.none : Assets.layerFiles(options.assets),
        // The doctor's CLIProxyAPI and network checks look nowhere real.
        Layer.succeed(ApiDoctorOptions)({ cliProxyApiPort: 9, reach: [] }),
      ),
    ),
  )
}

/** The daemon over `options`, and the upstream it talks to. */
export const apiStack = (options: Options = {}) => {
  const upstream = memoryUpstream(options.routes ?? [])
  const files = Object.fromEntries([
    ...(options.accounts ?? []).map(
      (account) => [`${home}/accounts/${account.id}.json`, accountText(account)] as const,
    ),
    ...Object.entries(options.files ?? {}).map(([path, text]) => [`${home}/${path}`, text] as const),
  ])
  const store = storeLayer(
    upstream.layer,
    // Never the real proxy's address: the doctor and the background client look there.
    { strategy: "fill-first", refreshTokens: false, listen: "127.0.0.1:9", ...options.settings },
    { files },
  )
  const layer = daemonOver(store, {
    ...(options.listen === undefined ? {} : { listen: options.listen }),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
  })
  return { upstream, layer }
}

const base = "http://slopmax.test"

/** What a raw call answered. */
export interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  /** The body as JSON; `undefined` when it is none. */
  readonly body: unknown
}

/** A call to the front door, with the owner key unless `key` says otherwise (`null` for none). */
export const call = (
  method: string,
  path: string,
  options: {
    readonly body?: unknown
    readonly key?: string | null
    readonly headers?: Readonly<Record<string, string>>
  } = {},
) =>
  Effect.gen(function* () {
    const server = yield* Server
    const given = options.key === undefined ? key : options.key
    const headers: Record<string, string> = {
      ...(given === null ? {} : { authorization: `Bearer ${given}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    }
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        server.fetch(new Request(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) })),
      ),
    )
    const text = yield* Effect.promise(() => response.text())
    const answer: Answer = { status: response.status, headers: response.headers, text, body: parseJson(text) }
    return answer
  })

/** slopmax's typed client, as every front end uses it, talking to the front door in process. */
export const client = Effect.gen(function* () {
  const server = yield* Server
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: Request | string | URL, init?: RequestInit) =>
      Promise.resolve(server.fetch(input instanceof Request ? input : new Request(String(input), init))),
    { preconnect: () => undefined },
  )
  return yield* HttpApiClient.make(SlopmaxApi, {
    baseUrl: base,
    transformClient: (http) =>
      http.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
        HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch))
})

/** A list in a JSON answer; empty when there is none. */
export const items = (value: unknown, ...path: ReadonlyArray<string | number>): ReadonlyArray<unknown> => {
  const at = field(value, ...path)
  return Array.isArray(at) ? at : []
}
