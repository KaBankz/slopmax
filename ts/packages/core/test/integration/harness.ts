// What the end-to-end tests stand on: a provider stand-in on a local port
// that records what it is sent, and slopmax's proxy served in-process
// from a throwaway home, with every provider URL pointed at the stand-in.
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { ids, SignedDuration, Timestamp } from "@slopmax/common"
import { Client, Origins, type client as net, server } from "@slopmax/net"
import type { Dialect } from "@slopmax/wire"

import { Account, Store, type Tokens } from "../../src/account.ts"
import type { Config } from "../../src/config.ts"
import * as ledger from "../../src/ledger.ts"
import { Home } from "../../src/paths.ts"
import { State } from "../../src/pool.ts"
import type { ProviderId } from "../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { App, headersOf, httpApp, splitUrl } from "../../src/proxy/mod.ts"
import { noEnv } from "../../src/testkit.ts"

export const KEY = "sm-test-key"

/** One request the stand-in received. */
export interface Seen {
  /** Path and query (`ws {uri}` and `ws message` for WebSockets). */
  readonly path: string
  readonly headers: Headers
  readonly body: Uint8Array
}

/** Everything the stand-in received, in order. */
export type Log = Array<Seen>

/** A stand-in's answer to the request in its context. */
export type Mock = (
  log: Log,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope>

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

export const bytes = (s: string): Uint8Array => utf8.encode(s)
export const text = (b: Uint8Array): string => fromUtf8.decode(b)

/** A value at `path` inside parsed JSON, or undefined. */
export const pick = (value: unknown, ...path: ReadonlyArray<string | number>): unknown => {
  let at: unknown = value
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined
    at = Reflect.get(at, key)
  }
  return at
}

export const parse = (body: string | Uint8Array): unknown => JSON.parse(typeof body === "string" ? body : text(body))

/** An answer with `status`, `headers`, and `body`; no content type unless given. */
export const reply = (
  status: number,
  headers: ReadonlyArray<readonly [string, string]>,
  body: string | Uint8Array,
): HttpServerResponse.HttpServerResponse => {
  const response = HttpServerResponse.uint8Array(typeof body === "string" ? bytes(body) : body, {
    status,
    headers,
  })
  return headers.some(([name]) => name === "content-type")
    ? response
    : HttpServerResponse.removeHeader(response, "content-type")
}

/** Unix seconds `secs` from now. */
export const resetIn = (secs: number): number => Timestamp.asSecond(Date.now() + secs * 1000)

/** Serves `app` on a free local port until the scope closes; returns its base URL. */
export const serve = (
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope>,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.gen(function* () {
    const listener = yield* server.bind({ hostname: "127.0.0.1", port: 0 }).pipe(Effect.orDie)
    yield* listener.serve(app)
    return `http://127.0.0.1:${listener.port}`
  })

/**
 * The stand-in's front: probes of `/` from other programs are answered 404
 * and not recorded; everything else is recorded (WebSockets by `mock`)
 * and answered by `mock`.
 */
export const recording =
  (
    answer: (
      log: Log,
      request: HttpServerRequest.HttpServerRequest,
      headers: Headers,
      body: Uint8Array,
    ) => ReturnType<Mock>,
    socket?: (log: Log, request: HttpServerRequest.HttpServerRequest, headers: Headers) => ReturnType<Mock>,
  ): Mock =>
  (log) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const headers = headersOf(request)
      if (socket !== undefined && headers.has("upgrade")) return yield* socket(log, request, headers)
      if (splitUrl(request.url)[0] === "/") return reply(404, [], "")
      const body = new Uint8Array(yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))))
      log.push({ path: request.url, headers, body })
      return yield* answer(log, request, headers, body)
    })

export interface Harness {
  readonly proxy: string
  /** The sandbox: accounts, and the usage ledger under `usage/`. */
  readonly dir: string
  readonly app: App
  readonly log: Log
  readonly ids: ReadonlyArray<string>
  readonly client: Client
}

export interface Options {
  /** The temp dir's name before its random part. */
  readonly prefix: string
  readonly mock: Mock
  /** The accounts, given the stand-in's base URL (for compatible endpoints). */
  readonly accounts: (upstream: string) => ReadonlyArray<Account>
  readonly config: Config
  /** Provider URL prefixes to send to the stand-in, given its base URL. */
  readonly origins: (upstream: string) => ReadonlyArray<readonly [string, string]>
}

/** A stand-in and the proxy in front of it, both stopped and the home removed when the scope closes. */
export const harness = (options: Options): Effect.Effect<Harness, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() => join(tmpdir(), `${options.prefix}-${ids.token()}`)),
      (made) => Effect.sync(() => rmSync(made, { recursive: true, force: true })),
    )
    const log: Log = []
    const upstream = yield* serve(options.mock(log))
    const store = Store.at(join(dir, "accounts"))
    const saved: Array<string> = []
    for (const account of options.accounts(upstream)) {
      const [stored] = yield* store.upsert(account).pipe(Effect.orDie)
      saved.push(stored.id)
    }
    const origins = new Origins(options.origins(upstream))
    const app = yield* App.make(options.config, Home.at(dir), State.empty(), origins).pipe(Effect.provide(noEnv))
    yield* app.pool.sync(yield* app.store.list().pipe(Effect.orDie), {})
    const proxy = yield* serve(httpApp(app))
    const client = yield* Client.builder().build().pipe(Effect.provide(noEnv))
    return { proxy, dir, app, log, ids: saved, client }
  })

const now = (): Timestamp => Date.now()

/** An OAuth account, tried in order of `added` (fill-first by age). */
export const oauth = (
  provider: ProviderId,
  name: string,
  token: string,
  refresh: string,
  added: number,
  fields: Partial<Account> = {},
): Account => {
  const tokens: Tokens = {
    accessToken: token,
    refreshToken: refresh,
    expiresAt: Timestamp.add(now(), SignedDuration.fromHours(8)),
  }
  return Account.assignId({
    ...Account.make(provider, tokens, now()),
    email: `${name}@example.com`,
    accountId: `acct-${name}`,
    addedAt: Timestamp.fromSecond(added) ?? 0,
    ...fields,
  })
}

/** An API-key account. */
export const key = (provider: ProviderId, apiKey: string): Account =>
  Account.make(provider, { accessToken: apiKey }, now())

/** A compatible endpoint at `baseUrl`. */
export const endpointAt = (
  baseUrl: string,
  dialect: Dialect,
  models: ReadonlyArray<string>,
  apiKey: string,
  added?: number,
): Account =>
  Account.assignId({
    ...key("compat", apiKey),
    endpoint: { baseUrl, dialect, models: [...models] },
    ...(added === undefined ? {} : { addedAt: Timestamp.fromSecond(added) ?? 0 }),
  })

/** What came back for a request: its status, headers, and whole body. */
export interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly body: string
}

export const send = (request: net.RequestBuilder): Effect.Effect<Answer> =>
  Effect.gen(function* () {
    const response = yield* request.send()
    return { status: response.status, headers: response.headers, body: yield* response.text() }
  }).pipe(Effect.orDie)

/** Sends `request` and lets go of the answer unread (a HEAD's has no body to read). */
export const status = (request: net.RequestBuilder): Effect.Effect<number> =>
  Effect.gen(function* () {
    const response = yield* request.send()
    yield* response.close
    return response.status
  }).pipe(Effect.orDie)

/** Retries `check` every 20 ms, up to 50 times: ledger writes and background effects are asynchronous. */
export const eventually = (check: Effect.Effect<boolean>): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      if (yield* check) return
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error("condition not met"))
  })

/** The ledger's entries from `since` on. */
export const entries = (h: Harness, since: Timestamp): Effect.Effect<ReadonlyArray<ledger.Entry>> =>
  ledger.read(join(h.dir, "usage"), since)

/** Every path the stand-in was asked for, in order. */
export const paths = (h: Harness): Array<string> => h.log.map((s) => s.path)
