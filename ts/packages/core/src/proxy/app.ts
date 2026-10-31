// What the proxy's handlers share (the parts of `proxy/mod.rs` the
// submodules reach through `super::`): the app's state, the request's
// target and caller, and the replies. Apart from `mod.ts`, which imports
// every handler, so the handlers can import this without a cycle.
import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"

import { Deferred, Effect, PubSub, Result, Schema, type Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { type HttpServerError, type HttpServerRequest, HttpServerResponse } from "effect/http"

import { log, SignedDuration, text, Timestamp } from "@slopmax/common"
import { Client, type Origins } from "@slopmax/net"
import { Dialect, json } from "@slopmax/wire"

import { type Account, PinsSchema, Store, Tokens } from "../account.ts"
import { ensureFresh } from "../auth/connect.ts"
import { httpClient } from "../auth/mod.ts"
import { type ClientKey, Config, parse as parseConfig } from "../config.ts"
import { chain, Failure } from "../error.ts"
import * as fsx from "../fsx.ts"
import { type Entry, EntrySchema, Ledger, read as readLedger } from "../ledger.ts"
import type { Home } from "../paths.ts"
import { Inner, Pool, Routing, type State as PoolState } from "../pool.ts"
import { ProviderId, Spec } from "../provider/mod.ts"
import { build, Report } from "../report.ts"
import { header } from "./headers.ts"
import { Replay } from "./transcode.ts"

/** How many answered requests the live feed holds for a subscriber that lags. */
const FEED = 256

const utf8 = new TextEncoder()
const encodeEntry = Schema.encodeSync(EntrySchema)

/** Shared state for request handlers and background tasks. */
export class App {
  /** Reasoning state kept between turns of translated conversations. */
  readonly replay = new Replay()
  /** Each account's model list, and when it was read. */
  readonly catalogs = new Map<string, { readonly at: number; readonly models: ReadonlyArray<string> }>()
  /** The newest Codex release seen in requests. */
  codexVersion: string | undefined
  /** When each account was last warmed. */
  readonly warmed = new Map<string, number>()
  // Who listens to the live feed, so nothing is encoded for nobody.
  private listeners = 0

  private constructor(
    /** The config, swapped whole when config.toml changes. */
    private readonly configRef: SubscriptionRef.SubscriptionRef<Config>,
    /** The slopmax directory this proxy reads and writes. */
    readonly home: Home,
    readonly store: Store,
    readonly pool: Pool,
    /** Inference traffic: long-lived streams, so only a stall timeout. */
    readonly http: Client,
    /** OAuth and usage calls, with bounded timeouts. */
    readonly authHttp: Client,
    /** Completed by `POST /slopmax/shutdown`. */
    readonly shutdown: Deferred.Deferred<void>,
    /**
     * Held while redeeming a reset credit, so concurrent requests that all
     * find the pool spent redeem one credit, not one each.
     */
    readonly redeeming: Semaphore.Semaphore,
    /** Where answered requests are recorded for `slopmax usage`. */
    readonly ledger: Ledger,
    /** Each answered request, as JSON, for the dashboard's live feed. */
    private readonly events: PubSub.PubSub<Uint8Array>,
    /** The model Codex asked for last, which window warmups use. */
    private codexModel: string | undefined,
    /** config.toml as last read, to tell when it changes. */
    private configText: string | undefined,
    /** The app's lifetime: background work a request starts runs in it (`tokio::spawn`). */
    readonly scope: Scope.Scope,
  ) {}

  /**
   * The app for `home`. `origins` reroutes provider URLs; tests point them
   * at a mock. The ledger's writer runs until the scope closes.
   */
  static readonly make = Effect.fn("App.make")(function* (
    config: Config,
    home: Home,
    state: PoolState,
    origins: Origins,
  ): Effect.fn.Return<App, never, Scope.Scope> {
    const store = Store.at(home.accounts())
    // The ledger remembers which model Codex used last, across restarts.
    const monthAgo = Timestamp.sub(yield* Timestamp.now, SignedDuration.fromHours(24 * 30))
    const recent = yield* readLedger(home.usage(), monthAgo)
    const codexModel = recent.findLast((e) => e.provider === "codex")?.model
    const ledger = yield* Ledger.start(home.usage())
    const configText = yield* Effect.orElseSucceed(fsx.readText(home.config()), () => undefined)
    const http = yield* Client.builder()
      .connectTimeout("10 seconds")
      .readTimeout("600 seconds")
      .origins(origins)
      .build()
    const pool = yield* Pool.make(config.strategy, SignedDuration.fromMins(Number(config.sessionTtlMins)), state)
    yield* pool.setRouting(Routing.of(config))
    return new App(
      yield* SubscriptionRef.make(config),
      home,
      store,
      pool,
      http,
      yield* httpClient(origins),
      yield* Deferred.make<void>(),
      yield* Semaphore.make(1),
      ledger,
      yield* PubSub.sliding<Uint8Array>(FEED),
      codexModel,
      configText,
      yield* Effect.scope,
    )
  })

  /** The config as it stands. */
  get config(): Effect.Effect<Config> {
    return SubscriptionRef.get(this.configRef)
  }

  /**
   * Applies a changed config to requests from now on. The address, the
   * upstream proxy, and which background tasks run are set at start, so
   * changing those needs a restart; everything else applies at once.
   */
  setConfig(config: Config): Effect.Effect<void> {
    return Effect.andThen(this.pool.setRouting(Routing.of(config)), SubscriptionRef.set(this.configRef, config))
  }

  /**
   * Applies config.toml if it changed since it was last read. A config
   * that does not parse is logged and left unapplied.
   */
  get reloadConfig(): Effect.Effect<void> {
    return this.reloadConfigNow()
  }

  private readonly reloadConfigNow = Effect.fn("App.reloadConfig")(function* (this: App) {
    const read = yield* Effect.orElseSucceed(fsx.readText(this.home.config()), () => undefined)
    if (read === undefined || read === this.configText) return
    const parsed = parseConfig(read)
    if (Result.isSuccess(parsed)) {
      const current = yield* this.config
      // Bound at start: the listener stays where it is.
      const config: Config = {
        ...parsed.success,
        listen: current.listen,
        apiKey: parsed.success.apiKey === "" ? current.apiKey : parsed.success.apiKey,
      }
      log.info("config.toml changed; applying it")
      yield* this.setConfig(config)
    } else {
      log.warn(`config.toml is invalid, keeping the last good one: ${parsed.failure.message}`)
    }
    this.configText = read
  })

  /**
   * Reloads accounts and pins from disk, picking up logins, removals,
   * refreshed tokens, and `slopmax use` from other processes.
   */
  get sync(): Effect.Effect<void, Failure> {
    return this.syncNow()
  }

  private readonly syncNow = Effect.fn("App.sync")(function* (this: App): Effect.fn.Return<void, Failure> {
    const accounts = yield* this.store.list()
    const pins = yield* fsx
      .readJson(this.home.pins(), PinsSchema)
      .pipe(Effect.mapError((e) => new Failure({ message: e.message, cause: e })))
    yield* this.pool.sync(accounts, pins ?? {})
  })

  /** The account with current credentials, or undefined if it cannot be used. */
  readonly ready = Effect.fn("App.ready")(function* (
    this: App,
    picked: Account,
  ): Effect.fn.Return<Account | undefined> {
    const stored = yield* Effect.orElseSucceed(this.store.get(picked.id), () => undefined)
    const account = stored ?? picked
    // Another process may have found its sign-in revoked since the pool
    // last read the disk; trying it would cost a refusal and a refresh.
    if (account.authError !== undefined) {
      yield* this.pool.recordError(account.id, account.authError)
      return undefined
    }
    // Following a linked account's source is read-only, so it happens
    // even when refreshing is off.
    if (!(yield* this.config).refreshTokens && account.link === undefined) return account
    const fresh = yield* Effect.result(ensureFresh(this.authHttp, this.store, account, false))
    if (Result.isSuccess(fresh)) return fresh.success
    const e = fresh.failure
    if (e._tag === "Transient" && !Tokens.isExpired(account.tokens, yield* Timestamp.now)) {
      log.warn(`${account.id}: refresh failed, using current token: ${chain(e.error)}`)
      return account
    }
    log.warn(`${account.id}: ${e.message}`)
    yield* this.pool.recordError(account.id, e.message)
    return undefined
  })

  /**
   * Puts the pool's usage windows in place of the serving account's in
   * response headers, so the agent sees its provider's accounts as one.
   */
  readonly showPool = Effect.fn("App.showPool")(function* (this: App, provider: ProviderId, headers: Headers) {
    if (!Spec.isSubscription(ProviderId.spec(provider))) return
    const windows = yield* this.pool.pooled(provider, yield* Timestamp.now)
    if (windows.length > 0) ProviderId.get(provider).showPool(windows, headers)
  })

  /** The model Codex asked for last. */
  lastCodexModel(): string | undefined {
    return this.codexModel
  }

  /**
   * Tells the dashboard's live feed about an answered request, and
   * remembers the model of a Codex one.
   */
  broadcast(entry: Entry): void {
    if (entry.provider === "codex" && entry.model !== undefined) this.codexModel = entry.model
    if (this.listeners > 0) PubSub.publishUnsafe(this.events, utf8.encode(JSON.stringify(encodeEntry(entry))))
  }

  /** Records an answered (or failed) request: the live feed, then the ledger. */
  record(entry: Entry): void {
    this.broadcast(entry)
    this.ledger.record(entry)
  }

  /**
   * The live feed: each answered request's ledger line, from now until the
   * scope closes. A subscriber that falls 256 behind loses the oldest.
   */
  get feed(): Effect.Effect<PubSub.Subscription<Uint8Array>, never, Scope.Scope> {
    return Effect.andThen(
      Effect.acquireRelease(
        Effect.sync(() => {
          this.listeners++
        }),
        () =>
          Effect.sync(() => {
            this.listeners--
          }),
      ),
      PubSub.subscribe(this.events),
    )
  }

  get report(): Effect.Effect<Report> {
    return this.reportNow()
  }

  private readonly reportNow = Effect.fn("App.report")(function* (this: App): Effect.fn.Return<Report> {
    const now = yield* Timestamp.now
    const inner = yield* this.pool.get
    const config = yield* this.config
    const report = build(
      inner.accounts,
      (id) => Inner.state(inner, id),
      inner.pins,
      Inner.sessionCounts(inner, now),
      config.strategy,
      true,
      now,
    )
    return Report.withNudges(Report.withNext(report, inner, now), config, now)
  })
}

/** The web headers of a request served by `@slopmax/net`'s server. */
export const headersOf = (request: HttpServerRequest.HttpServerRequest): Headers => {
  const source = request.source
  if (source instanceof Request) return source.headers
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) headers.append(name, value)
  return headers
}

/**
 * A request's body. One without a body has none to read (the web's
 * `Request` has `body === null`, which `request.stream` refuses).
 */
export const bodyOf = (
  request: HttpServerRequest.HttpServerRequest,
): Stream.Stream<Uint8Array, HttpServerError.HttpServerError> => {
  const source = request.source
  return source instanceof Request && source.body === null ? Stream.empty : request.stream
}

/** A request's path and query, split. */
export const splitUrl = (url: string): readonly [path: string, query: string] => {
  const at = url.indexOf("?")
  return at < 0 ? [url, ""] : [url.slice(0, at), url.slice(at + 1)]
}

/** Where a request goes, judged from its path. */
export interface Target {
  /**
   * The provider whose API the path belongs to, if any. It serves the
   * request unless the model routes it elsewhere.
   */
  readonly provider: ProviderId | undefined
  /** The path to forward, relative to the API's base URL. */
  readonly path: string
  /** The format the client speaks. */
  readonly dialect: Dialect
  /** Whether the model in the body picks the provider. */
  readonly byModel: boolean
}

export const isWebsocket = (headers: Headers): boolean => {
  const value = header(headers, "upgrade")
  return value !== undefined && text.asciiLowercase(value) === "websocket"
}

/** A JSON answer with `status`. */
export const jsonReply = (status: number, value: json.Json): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.uint8Array(utf8.encode(json.stringify(value)), { status, contentType: "application/json" })

export const emptyReply = (status: number): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status })

/** Maps a request path to its target. */
export const route = (pathAndQuery: string, headers: Headers): Target | undefined => {
  const strip = (prefix: string): string | undefined => {
    if (!pathAndQuery.startsWith(prefix)) return undefined
    const rest = pathAndQuery.slice(prefix.length)
    return rest === "" || rest.startsWith("/") || rest.startsWith("?") ? rest : undefined
  }
  const starts = (path: string, prefix: string): boolean => {
    const bare = splitUrl(path)[0]
    if (!bare.startsWith(prefix)) return false
    const rest = bare.slice(prefix.length)
    return rest === "" || rest.startsWith("/")
  }
  const claude = (path: string): Target => ({
    provider: "claude",
    byModel: starts(path, "/v1/messages"),
    dialect: "messages",
    path,
  })
  const codex = (path: string): Target => ({
    provider: "codex",
    byModel: starts(path, "/responses"),
    dialect: "responses",
    path,
  })
  const underClaude = strip("/claude")
  if (underClaude !== undefined) return claude(underClaude)
  const underCodex = strip("/codex")
  if (underCodex !== undefined) return codex(underCodex)
  // Unprefixed /v1 paths, as an OpenAI- or Anthropic-style base URL sends.
  const rest = strip("/v1")
  if (rest === undefined) return undefined
  if (starts(rest, "/chat/completions")) return { provider: undefined, path: rest, dialect: "chat", byModel: true }
  const path = splitUrl(rest)[0]
  const isCodex =
    path.startsWith("/responses") ||
    (path === "/models" && rest.includes("client_version=") && !headers.has("anthropic-version"))
  return isCodex ? codex(rest) : claude(`/v1${rest}`)
}

/** Who a request comes from, by the key it presents. */
export type Caller =
  /** The owner's `api_key`. */
  | { readonly _tag: "Owner" }
  /** One of the config's client keys. */
  | { readonly _tag: "Client"; readonly key: ClientKey }

const OWNER: Caller = { _tag: "Owner" }

/** The key a request presents, as a bearer token or `x-api-key`. */
export const caller = (config: Config, headers: Headers): Caller | undefined => {
  const authorization = header(headers, "authorization")
  const bearer =
    authorization === undefined
      ? undefined
      : authorization.startsWith("Bearer ") || authorization.startsWith("bearer ")
        ? authorization.slice(7)
        : undefined
  const presented = bearer ?? header(headers, "x-api-key")
  if (presented === undefined) return undefined
  const key = Buffer.from(text.trim(presented), "utf8")
  const known = keysOf(config)
  if (sameBytes(key, known.owner)) return OWNER
  const at = known.clients.findIndex((k) => sameBytes(key, k))
  const client = config.keys[at]
  return client === undefined ? undefined : { _tag: "Client", key: client }
}

// Each config's keys, encoded once rather than on every request.
const encodedKeys = new WeakMap<Config, { readonly owner: Buffer; readonly clients: ReadonlyArray<Buffer> }>()

const keysOf = (config: Config): { readonly owner: Buffer; readonly clients: ReadonlyArray<Buffer> } => {
  let known = encodedKeys.get(config)
  if (known === undefined) {
    known = { owner: Buffer.from(config.apiKey, "utf8"), clients: config.keys.map((k) => Buffer.from(k.key, "utf8")) }
    encodedKeys.set(config, known)
  }
  return known
}

const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

/** Whether the request carries the owner's key, which slopmax's own API requires. */
export const authorized = (config: Config, headers: Headers): boolean => caller(config, headers)?._tag === "Owner"

/** Whether `a` holds `b`'s UTF-8 bytes, compared in constant time (the hub checks `x-management-key` with it). */
export const constantTimeEq = (a: Buffer, b: string): boolean => sameBytes(a, Buffer.from(b, "utf8"))

export const unauthorized = (dialect: Dialect | undefined): HttpServerResponse.HttpServerResponse =>
  error(dialect, 401, "missing or invalid slopmax key; see `slopmax env`")

/** The kind an error reply of `status` names. */
const kindOf = (status: number): string => {
  switch (status) {
    case 401:
      return "authentication_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_error"
    case 529:
      return "overloaded_error"
    default:
      return status >= 500 ? "api_error" : "invalid_request_error"
  }
}

/** An error in the shape the agent understands (Messages when unknown). */
export const error = (
  dialect: Dialect | undefined,
  status: number,
  message: string,
): HttpServerResponse.HttpServerResponse =>
  jsonReply(status, Dialect.error(dialect ?? "messages", kindOf(status), message))

interface EntryParts {
  readonly at: Timestamp
  readonly account: string
  readonly provider: ProviderId
  readonly model: string | undefined
  readonly status: number
  readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  readonly ms: number
  readonly firstByteMs: number | undefined
  readonly attempts: number
  readonly agent: string | undefined
  readonly session: string | undefined
}

/** A ledger entry, its absent parts left out. */
export const entry = (parts: EntryParts): Entry => ({
  at: parts.at,
  account: parts.account,
  provider: parts.provider,
  ...(parts.model === undefined ? {} : { model: parts.model }),
  status: parts.status,
  input: parts.usage?.input ?? 0,
  output: parts.usage?.output ?? 0,
  cacheRead: parts.usage?.cacheRead ?? 0,
  cacheWrite: parts.usage?.cacheWrite ?? 0,
  ms: Math.max(0, parts.ms),
  ...(parts.firstByteMs === undefined ? {} : { firstByteMs: Math.max(0, parts.firstByteMs) }),
  attempts: parts.attempts,
  ...(parts.agent === undefined ? {} : { agent: parts.agent }),
  ...(parts.session === undefined ? {} : { session: parts.session }),
})

/** `{outcome:?}`: the Rust variant's name. */
export const outcomeDebug = (outcome: string): string =>
  outcome
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
