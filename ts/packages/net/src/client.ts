// Outbound HTTP/1.1 over Bun's fetch: pooled keep-alive connections,
// optional HTTP CONNECT or SOCKS5 proxies, and timeouts. Responses are
// never decompressed: bodies and `content-encoding` pass through as the
// upstream sent them. A request that asks for an upgrade (a WebSocket
// handshake) goes over a connection of its own, which a `101` hands over.
// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { Buffer } from "node:buffer"
import { lookup } from "node:dns/promises"
import type { Socket } from "node:net"

import { ids, text as texts } from "@slopmax/common"
import { Clock, Config, Data, Duration, Effect, Exit, Layer, Option, Result, Schema, type Scope, Stream } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"

import * as body from "./body.ts"
import { CONNECT_ELAPSED, Conn, errorText, IoError, openTcpWithin, startTls, systemRoots, tunnel } from "./conn.ts"
import * as form from "./form.ts"
import * as socks from "./socks.ts"
import * as uri from "./uri.ts"

/** Largest response body {@link Response.bytes} reads into memory. */
export const MAX_BODY = 64 * 1024 * 1024

/** Connect timeout when the builder sets none. */
const CONNECT_TIMEOUT = Duration.seconds(10)

/** How long the pool keeps an idle connection. */
const IDLE = Duration.seconds(60)

// http's canonical reasons, for `HTTP 404 Not Found`.
const REASONS: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
}

/** A status as http's `StatusCode` prints it: `404 Not Found`. */
export const statusText = (status: number): string => `${status} ${REASONS[status] ?? "<unknown status code>"}`

/** What went wrong with a request. */
export type ErrorKind = "Request" | "Connect" | "Timeout" | "Status" | "Body" | "Decode"

const WHAT: Readonly<Record<Exclude<ErrorKind, "Status">, string>> = {
  Request: "invalid request",
  Connect: "request failed",
  Timeout: "timed out",
  Body: "reading the response failed",
  Decode: "unexpected response",
}

/** Why a request failed. */
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly kind: ErrorKind
  /** The status, for a `Status` error. */
  readonly status?: number | undefined
  /** The root cause: "connection refused", a TLS alert, a JSON error. */
  readonly reason?: string | undefined
}> {
  override get message(): string {
    if (this.kind === "Status") return `HTTP ${statusText(this.status ?? 0)}`
    const what = WHAT[this.kind]
    return this.reason === undefined ? what : `${what}: ${this.reason}`
  }

  isTimeout(): boolean {
    return this.kind === "Timeout"
  }
}

const failure = (kind: ErrorKind, reason: string): HttpError => new HttpError({ kind, reason })

// The innermost cause, which is the useful part.
const rootCause = (cause: unknown): string => {
  let last = cause
  while (last instanceof Error && last.cause instanceof Error) last = last.cause
  if (last instanceof IoError) return last.reason
  if (last instanceof Error && !(last instanceof body.LengthLimitError) && !(last instanceof body.ReadError)) {
    return errorText(last)
  }
  return last instanceof Error ? last.message : String(last)
}

export type ProxyKind = "Http" | "Socks" | "SocksRemoteDns"

// A port as Rust's `u16` parses it (a leading `+` is allowed).
const isPort = (text: string): boolean => /^\+?\d+$/.test(text) && Number(text) <= 65535

// The port at the end of an authority, if it names one.
const portOf = (authority: string): string | undefined => {
  const colon = authority.lastIndexOf(":")
  if (colon < 0 || authority.indexOf("]", colon) >= 0) return undefined
  return authority.slice(colon + 1)
}

/**
 * An upstream proxy: `http://[user:pass@]host:port` (CONNECT tunnel),
 * `socks5://…` (local DNS), or `socks5h://…` (DNS at the proxy).
 */
export class Proxy {
  private constructor(
    /** `host:port`, as http's `Uri` reads it. */
    readonly authority: string,
    readonly kind: ProxyKind,
    readonly auth: readonly [user: string, pass: string] | undefined,
  ) {}

  static parse(input: string): Result.Result<Proxy, string> {
    const text = texts.trim(input)
    const split = text.indexOf("://")
    if (split < 0) return Result.fail(`proxy ${texts.debug(text)} needs a scheme, like http:// or socks5://`)
    const scheme = texts.asciiLowercase(text.slice(0, split))
    let kind: ProxyKind
    switch (scheme) {
      case "http":
        kind = "Http"
        break
      case "socks5":
        kind = "Socks"
        break
      case "socks5h":
        kind = "SocksRemoteDns"
        break
      default:
        return Result.fail(`unsupported proxy scheme ${texts.debug(scheme)}`)
    }
    let rest = text.slice(split + 3)
    while (rest.endsWith("/")) rest = rest.slice(0, -1)
    const at = rest.lastIndexOf("@")
    let auth: readonly [string, string] | undefined
    let host = rest
    if (at >= 0) {
      const userinfo = rest.slice(0, at)
      host = rest.slice(at + 1)
      const colon = userinfo.indexOf(":")
      const user = colon < 0 ? userinfo : userinfo.slice(0, colon)
      const pass = colon < 0 ? "" : userinfo.slice(colon + 1)
      auth = [form.percentDecode(user), form.percentDecode(pass)]
    }
    const defaultPort = kind === "Http" ? 80 : 1080
    const colon = host.lastIndexOf(":")
    const authority = colon >= 0 && isPort(host.slice(colon + 1)) ? host : `${host}:${defaultPort}`
    const parsed = uri.parse(`http://${authority}`)
    if (!parsed.ok) return Result.fail(`invalid proxy ${texts.debug(text)}: ${parsed.error}`)
    return Result.succeed(new Proxy(parsed.authority, kind, auth))
  }

  /** The proxy named by `HTTPS_PROXY` or `ALL_PROXY` (either case). */
  static readonly fromEnv: Effect.Effect<Proxy | undefined> = Effect.gen(function* () {
    for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      const value = yield* envVar(name)
      if (value !== undefined && texts.trim(value) !== "") {
        return Result.getOrUndefined(Proxy.parse(value))
      }
    }
    return undefined
  })

  /**
   * Makes `proxy` the default for every client built from now on, ahead
   * of the environment. Set once, from the config.
   */
  static setDefault(proxy: Proxy): void {
    defaultProxy ??= proxy
  }

  get hostname(): string {
    const port = portOf(this.authority)
    const host = port === undefined ? this.authority : this.authority.slice(0, -port.length - 1)
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  }

  /** The port; 80 when the authority names none (the `Uri` is `http://`). */
  get port(): number {
    const port = portOf(this.authority)
    return port !== undefined && isPort(port) ? Number(port) : 80
  }

  /** The proxy without its credentials. */
  toString(): string {
    const scheme = this.kind === "Http" ? "http" : this.kind === "Socks" ? "socks5" : "socks5h"
    return `${scheme}://${this.authority}`
  }
}

let defaultProxy: Proxy | undefined

// An environment variable through `Config`. An empty value counts as set
// when the provider keeps empty strings (`preserveEmptyStrings`), as
// `std::env::var` does.
const envVar = (name: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    return Option.getOrUndefined(yield* Config.option(Config.String(name)))
  }).pipe(Effect.orElseSucceed(() => undefined))

const isLoopback = (host: string): boolean => {
  if (host === "localhost") return true
  // Rust's `Ipv4Addr` parser: four decimal octets, no leading zeros.
  const v4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(host)
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255) && v4[1] === "127"
  if (!host.includes(":")) return false
  try {
    return new URL(`http://[${host}]/`).hostname === "[::1]"
  } catch {
    return false
  }
}

// A URL's host without IPv6 brackets.
const bare = (host: string): string => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

/**
 * Hosts that skip the proxy: loopback, plus `NO_PROXY` entries
 * (`*`, `example.com`, `.example.com`).
 */
export class Bypass {
  constructor(readonly entries: ReadonlyArray<string> = []) {}

  /** The comma-separated list in `NO_PROXY` (else `no_proxy`). */
  static parse(list: string): Bypass {
    return new Bypass(
      list
        .split(",")
        .map((entry) => texts.asciiLowercase(texts.trim(entry).replace(/^\.+/, "")))
        .filter((entry) => entry !== ""),
    )
  }

  static readonly fromEnv: Effect.Effect<Bypass> = Effect.gen(function* () {
    const list = (yield* envVar("NO_PROXY")) ?? (yield* envVar("no_proxy")) ?? ""
    return Bypass.parse(list)
  })

  skips(target: string): boolean {
    let host = target
    while (host.startsWith("[")) host = host.slice(1)
    while (host.endsWith("]")) host = host.slice(0, -1)
    host = texts.asciiLowercase(host)
    return (
      isLoopback(host) ||
      this.entries.some(
        (entry) =>
          entry === "*" || host === entry || (host.endsWith(entry) && host.slice(0, -entry.length).endsWith(".")),
      )
    )
  }
}

/**
 * URL prefixes to send elsewhere. Tests stand in for a provider this way:
 * `https://api.anthropic.com` → `http://127.0.0.1:PORT`.
 */
export class Origins {
  readonly pairs: ReadonlyArray<readonly [from: string, to: string]>

  constructor(pairs: Iterable<readonly [from: string, to: string]> = []) {
    this.pairs = [...pairs]
  }

  apply(url: string): string | undefined {
    for (const [from, to] of this.pairs) {
      if (!url.startsWith(from)) continue
      const rest = url.slice(from.length)
      if (rest === "" || rest.startsWith("/") || rest.startsWith("?")) return `${to}${rest}`
    }
    return undefined
  }
}

// How connections leave: through an HTTP proxy, through SOCKS5, or direct.
type Through =
  | { readonly _tag: "Http"; readonly proxy: Proxy; readonly auth: string | undefined }
  | { readonly _tag: "Socks"; readonly proxy: Proxy; readonly socks: socks.SocksProxy }

/** Configures a {@link Client}. */
export class Builder {
  private agent: string | undefined
  private connect: Duration.Duration | undefined
  private total: Duration.Duration | undefined
  private read: Duration.Duration | undefined
  private through: Proxy | undefined
  private rewrites = new Origins()
  private plain = false

  userAgent(agent: string): this {
    this.agent = agent
    return this
  }

  connectTimeout(timeout: Duration.Input): this {
    this.connect = Duration.fromInputUnsafe(timeout)
    return this
  }

  /** Total time for a request, including reading its body. */
  timeout(timeout: Duration.Input): this {
    this.total = Duration.fromInputUnsafe(timeout)
    return this
  }

  /** Longest wait for the response headers and between body chunks. */
  readTimeout(timeout: Duration.Input): this {
    this.read = Duration.fromInputUnsafe(timeout)
    return this
  }

  /** Sends requests through `proxy` (otherwise `HTTPS_PROXY`/`ALL_PROXY`). */
  proxy(proxy: Proxy | undefined): this {
    this.through = proxy
    return this
  }

  /**
   * Plain HTTP only, for calls to the local proxy. Loading the system's
   * trusted roots takes longer than such a call, so it is skipped.
   */
  plainHttp(): this {
    this.plain = true
    return this
  }

  /** Sends requests for some URL prefixes elsewhere. */
  origins(origins: Origins): this {
    this.rewrites = origins
    return this
  }

  /** The client. Reads `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` through `Config`. */
  build(): Effect.Effect<Client> {
    return Effect.gen({ self: this }, function* () {
      const proxy = this.through ?? defaultProxy ?? (yield* Proxy.fromEnv)
      const bypass = yield* Bypass.fromEnv
      let through: Through | undefined
      if (proxy !== undefined && proxy.kind === "Http") {
        const auth =
          proxy.auth === undefined
            ? undefined
            : `Basic ${Buffer.from(`${proxy.auth[0]}:${proxy.auth[1]}`, "utf8").toString("base64")}`
        through = { _tag: "Http", proxy, auth: auth !== undefined && validValue(auth) ? auth : undefined }
      } else if (proxy !== undefined) {
        through = {
          _tag: "Socks",
          proxy,
          socks: { host: proxy.hostname, port: proxy.port, auth: proxy.auth, localDns: proxy.kind === "Socks" },
        }
      }
      let noTls: string | undefined
      let ca: ReadonlyArray<string> = []
      if (this.plain) {
        noTls = "this client makes plain HTTP requests only"
      } else {
        ca = systemRoots()
        if (ca.length === 0) noTls = "no system CA certificates found; HTTPS is unavailable"
      }
      // Bun's fetch sockets get TCP_NODELAY and a 60 s keepalive of their own.
      const session = new Bun.FetchSession({
        keepAlive: { idleTimeout: Duration.toSeconds(IDLE) },
        ...(ca.length > 0 ? { tls: { ca: [...ca] } } : {}),
      })
      return new Client({
        session,
        noTls,
        ca,
        userAgent: this.agent !== undefined && validValue(this.agent) ? this.agent : undefined,
        timeout: this.total,
        readTimeout: this.read,
        connectTimeout: this.connect ?? CONNECT_TIMEOUT,
        origins: this.rewrites,
        through,
        bypass,
        used: new Map(),
      })
    })
  }
}

interface ClientState {
  readonly session: Bun.FetchSession
  /** Why HTTPS cannot work, when the system has no trusted roots. */
  readonly noTls: string | undefined
  readonly ca: ReadonlyArray<string>
  readonly userAgent: string | undefined
  readonly timeout: Duration.Duration | undefined
  readonly readTimeout: Duration.Duration | undefined
  readonly connectTimeout: Duration.Duration
  readonly origins: Origins
  readonly through: Through | undefined
  readonly bypass: Bypass
  /** When each `host:port` last answered, so the pool may hold a connection to it. */
  readonly used: Map<string, number>
}

// The `proxy` option of a fetch through an HTTP proxy.
const httpProxyOption = (through: Through & { readonly _tag: "Http" }): Bun.FetchProxyOption => ({
  url: `http://${through.proxy.authority}`,
  headers: through.auth === undefined ? undefined : { "proxy-authorization": through.auth },
  respectNoProxy: false,
})

/** An HTTP client. Sharing one shares its connection pool. */
export class Client {
  constructor(private readonly state: ClientState) {}

  static builder(): Builder {
    return new Builder()
  }

  get(url: string): RequestBuilder {
    return this.request("GET", url)
  }

  post(url: string): RequestBuilder {
    return this.request("POST", url)
  }

  request(method: string, url: string): RequestBuilder {
    return new RequestBuilder(this.state, method, this.state.origins.apply(url) ?? url)
  }

  /**
   * `fetch` with this client's pool, proxy, and origins, never
   * decompressing, for code that wants a plain fetch. A failed SOCKS5 dial
   * rejects with its reason.
   */
  readonly fetch = async (input: string | URL | Request, init?: BunFetchRequestInit): Promise<globalThis.Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = this.state.origins.apply(raw) ?? raw
    const request = input instanceof Request && url === raw ? input : url
    const through = this.state.bypass.skips(new URL(url).hostname) ? undefined : this.state.through
    const options = { redirect: "manual" as const, ...init, decompress: false, timeout: false }
    if (through?._tag !== "Socks") {
      const proxy = through === undefined ? false : httpProxyOption(through)
      return this.state.session.fetch(request, { ...options, proxy })
    }
    const via = await socks.bridge(through.socks, this.state.connectTimeout)
    const id = Buffer.from(ids.random(12)).toString("hex")
    const proxy = { url: via.url, headers: { [socks.REQUEST_HEADER]: id }, respectNoProxy: false }
    try {
      const response = await this.state.session.fetch(request, { ...options, proxy })
      const why = response.status === 502 ? socks.takeFailure(id) : undefined
      if (why === undefined) return response
      await response.body?.cancel().catch(() => undefined)
      throw new IoError({ reason: why })
    } catch (error) {
      const why = socks.takeFailure(id)
      throw why === undefined ? error : new IoError({ reason: why })
    } finally {
      socks.takeFailure(id)
    }
  }
}

/**
 * An `HttpClient` for `effect/http` that sends through `client` (its pool,
 * proxy, and origins; bodies never decompressed).
 */
export const layerHttpClient = (client: Client): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: BunFetchRequestInit) => client.fetch(input, init),
    { preconnect: globalThis.fetch.preconnect },
  )
  return FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
}

// http's token characters for a header name.
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// http's `HeaderValue::from_str`: visible characters, spaces, and tabs.
const validValue = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 32 && c !== 9) || c === 127) return false
  }
  return true
}

// Header text as bytes on the wire: UTF-8, one character per byte.
const wire = (value: string): string => {
  // oxlint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value)) return value
  return Buffer.from(value, "utf8").toString("latin1")
}

const utf8 = new TextEncoder()
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const latin1 = new TextDecoder("latin1")

/** A request being built; nothing is sent until {@link RequestBuilder.send}. */
export class RequestBuilder {
  /** Lowercase names with their values, in order. */
  private readonly headerList: Array<[string, string]> = []
  private payload: Uint8Array = new Uint8Array()
  private invalid: HttpError | undefined
  private deadline: Duration.Duration | undefined

  /** @internal Made by {@link Client.request}. */
  constructor(
    private readonly state: ClientState,
    private readonly method: string,
    private readonly url: string,
  ) {
    this.deadline = state.timeout
  }

  private check(name: string, value: string): string | undefined {
    if (!NAME.test(name)) {
      this.invalid = failure("Request", "invalid HTTP header name")
      return undefined
    }
    if (!validValue(value)) {
      this.invalid = failure("Request", "failed to parse header value")
      return undefined
    }
    return name.toLowerCase()
  }

  /** Sets a header, replacing any of the same name. */
  header(name: string, value: string): this {
    const lower = this.check(name, value)
    if (lower !== undefined) {
      this.remove(lower)
      this.headerList.push([lower, value])
    }
    return this
  }

  private remove(lower: string): void {
    for (let i = this.headerList.length - 1; i >= 0; i--) {
      if (this.headerList[i]?.[0] === lower) this.headerList.splice(i, 1)
    }
  }

  /** Adds every header in `headers`, replacing same-named ones. */
  headers(headers: Iterable<readonly [string, string]>): this {
    const seen = new Set<string>()
    for (const [name, value] of headers) {
      const lower = this.check(name, value)
      if (lower === undefined) continue
      if (!seen.has(lower)) {
        seen.add(lower)
        this.remove(lower)
      }
      this.headerList.push([lower, value])
    }
    return this
  }

  bearerAuth(token: string): this {
    return this.header("authorization", `Bearer ${token}`)
  }

  json(value: unknown): this {
    let text: string | undefined
    try {
      text = JSON.stringify(value)
    } catch (error) {
      this.invalid = failure("Request", rootCause(error))
      return this
    }
    if (text === undefined) {
      this.invalid = failure("Request", "the value has no JSON form")
      return this
    }
    this.payload = utf8.encode(text)
    return this.header("content-type", "application/json")
  }

  form(pairs: Iterable<readonly [string, string]>): this {
    this.payload = utf8.encode(form.encode(pairs))
    return this.header("content-type", "application/x-www-form-urlencoded")
  }

  body(bytes: Uint8Array | string): this {
    this.payload = typeof bytes === "string" ? utf8.encode(bytes) : bytes
    return this
  }

  timeout(timeout: Duration.Input): this {
    this.deadline = Duration.fromInputUnsafe(timeout)
    return this
  }

  send(): Effect.Effect<Response, HttpError> {
    if (this.invalid !== undefined) return Effect.fail(this.invalid)
    return send(this.state, {
      method: this.method,
      url: this.url,
      headers: this.headerList.slice(),
      payload: this.payload,
      deadline: this.deadline,
    })
  }
}

interface Outgoing {
  readonly method: string
  readonly url: string
  readonly headers: Array<[string, string]>
  readonly payload: Uint8Array
  readonly deadline: Duration.Duration | undefined
}

// Fails the request when a TCP connect to `host:port` outlasts `timeout`,
// as hyper's connector did; otherwise never finishes. Bun's fetch has no
// connect timeout, so this runs beside a fetch that may have to connect.
// Name resolution is not timed, as it was not in Rust.
const connectGuard = (host: string, port: number, timeout: Duration.Duration): Effect.Effect<never, HttpError> =>
  Effect.tryPromise(() => lookup(host)).pipe(
    Effect.flatMap((found) => openTcpWithin(found.address, port, timeout)),
    Effect.matchEffect({
      onFailure: (error) =>
        error instanceof IoError && error.reason === CONNECT_ELAPSED
          ? Effect.fail(failure("Connect", CONNECT_ELAPSED))
          : Effect.never,
      onSuccess: (socket) =>
        Effect.andThen(
          Effect.sync(() => socket.destroy()),
          Effect.never,
        ),
    }),
  )

const send = Effect.fn("Client.send")(function* (state: ClientState, request: Outgoing) {
  // Rust's `Uri` decides what is a valid URL, so the same ones fail.
  const parsed = uri.parse(request.url)
  if (!parsed.ok) return yield* failure("Request", `invalid URL ${texts.debug(request.url)}: ${parsed.error}`)
  if (parsed.scheme === undefined || parsed.authority === "") {
    return yield* failure("Connect", "client error (UserAbsoluteUriRequired)")
  }
  if (parsed.scheme !== "http" && parsed.scheme !== "https") {
    return yield* failure("Connect", `unsupported scheme ${parsed.scheme}`)
  }
  const url = URL.parse(request.url)
  if (url === null) return yield* failure("Request", `invalid URL ${texts.debug(request.url)}: invalid host`)
  if (state.noTls !== undefined && url.protocol === "https:") return yield* failure("Connect", state.noTls)
  const headers = request.headers
  if (state.userAgent !== undefined && !headers.some(([name]) => name === "user-agent")) {
    headers.push(["user-agent", state.userAgent])
  }

  const now = yield* Clock.currentTimeMillis
  const deadline = request.deadline === undefined ? undefined : now + Duration.toMillis(request.deadline)
  const read = state.readTimeout === undefined ? undefined : now + Duration.toMillis(state.readTimeout)
  const wait = deadline === undefined ? read : read === undefined ? deadline : Math.min(deadline, read)
  const bounded = <A>(effect: Effect.Effect<A, HttpError>): Effect.Effect<A, HttpError> =>
    wait === undefined
      ? effect
      : Effect.timeoutOrElse(effect, {
          duration: Math.max(0, wait - now),
          orElse: () => Effect.fail(failure("Timeout", "no response")),
        })

  if (headers.some(([name]) => name === "upgrade")) {
    const answer = yield* bounded(
      exchange(state, request.method, url, headers, request.payload).pipe(
        Effect.mapError((cause) => failure("Connect", rootCause(cause))),
      ),
    )
    return new Response(answer.status, answer.headers, { _tag: "Raw", ...answer }, deadline, state.readTimeout)
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  const through = state.bypass.skips(url.hostname) ? undefined : state.through
  let proxy: Bun.FetchProxyOption = false
  let id: string | undefined
  // Where fetch connects, when a connect there may stall.
  let target: readonly [host: string, port: number] | undefined
  if (through === undefined) {
    if (!isLoopback(bare(url.hostname))) target = [bare(url.hostname), port]
  } else if (through._tag === "Http") {
    proxy = httpProxyOption(through)
    target = [through.proxy.hostname, through.proxy.port]
  } else {
    // The bridge dials the SOCKS5 proxy with the connect timeout itself.
    const via = yield* Effect.tryPromise({
      try: () => socks.bridge(through.socks, state.connectTimeout),
      catch: (cause) => failure("Connect", rootCause(cause)),
    })
    id = Buffer.from(ids.random(12)).toString("hex")
    proxy = { url: via.url, headers: { [socks.REQUEST_HEADER]: id }, respectNoProxy: false }
  }
  const init: BunFetchRequestInit = {
    method: request.method,
    headers: headers.map(([name, value]): [string, string] => [name, wire(value)]),
    redirect: "manual",
    decompress: false,
    proxy,
    // Stalls are timed here, on the Clock, not by Bun's socket timer.
    timeout: false,
    ...(request.payload.length > 0 ? { body: request.payload } : {}),
    ...(url.protocol === "https:" ? { protocol: "http1.1" as const } : {}),
  }
  const socksFailure = (): string | undefined => (id === undefined ? undefined : socks.takeFailure(id))
  let fetching = Effect.tryPromise({
    try: (signal) => state.session.fetch(request.url, { ...init, signal }),
    catch: (cause) => failure("Connect", socksFailure() ?? rootCause(cause)),
  }).pipe(
    Effect.flatMap((response) => {
      // The bridge answers 502 when it could not dial; say why instead.
      const why = response.status === 502 ? socksFailure() : undefined
      if (why === undefined) return Effect.succeed(response)
      return Effect.andThen(
        Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve()),
        Effect.fail(failure("Connect", why)),
      )
    }),
  )
  const key = target === undefined ? undefined : `${target[0]}:${target[1]}`
  const lastUsed = key === undefined ? undefined : state.used.get(key)
  if (target !== undefined && (lastUsed === undefined || now - lastUsed >= Duration.toMillis(IDLE))) {
    fetching = Effect.raceFirst(fetching, connectGuard(target[0], target[1], state.connectTimeout))
  }
  const response = yield* bounded(fetching).pipe(Effect.ensuring(Effect.sync(socksFailure)))
  if (key !== undefined) state.used.set(key, yield* Clock.currentTimeMillis)
  return new Response(response.status, response.headers, { _tag: "Fetch", response }, deadline, state.readTimeout)
})

type Source =
  | { readonly _tag: "Fetch"; readonly response: globalThis.Response }
  | { readonly _tag: "Raw"; readonly conn: Conn; readonly body: Uint8Array }

/** The connection a `101 Switching Protocols` handed over. */
export interface Upgraded {
  /** The next chunk, or undefined once the peer has finished. */
  readonly read: Effect.Effect<Uint8Array | undefined, IoError>
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, IoError>
  /** Sends what is buffered, then closes. */
  readonly close: Effect.Effect<void>
}

/** A response whose headers have arrived; the body has not been read yet. */
export class Response {
  /** @internal Made by {@link RequestBuilder.send}. */
  constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly source: Source,
    private readonly deadline: number | undefined,
    private readonly readTimeout: Duration.Duration | undefined,
  ) {}

  /** Fails with the status when it is not a success. */
  errorForStatus(): Effect.Effect<this, HttpError> {
    return this.status >= 200 && this.status < 300
      ? Effect.succeed(this)
      : Effect.fail(new HttpError({ kind: "Status", status: this.status }))
  }

  private raw(): body.Body<body.ReadError> {
    const source = this.source
    if (source._tag === "Raw") return source.body.length === 0 ? body.empty : body.full(source.body)
    return Stream.fromReadableStream({
      evaluate: () => source.response.body ?? new ReadableStream<Uint8Array>(),
      onError: (cause) => new body.ReadError({ reason: rootCause(cause) }),
    })
  }

  /** Reads the whole body (up to 64 MiB). */
  bytes(): Effect.Effect<Uint8Array, HttpError> {
    const reading = body.read(this.raw(), MAX_BODY).pipe(Effect.mapError((error) => failure("Body", rootCause(error))))
    const deadline = this.deadline
    if (deadline === undefined) return reading
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.timeoutOrElse(reading, {
        duration: Math.max(0, deadline - now),
        orElse: () => Effect.fail(failure("Timeout", "reading the body")),
      }),
    )
  }

  /** The body as text; invalid UTF-8 is replaced. */
  text(): Effect.Effect<string, HttpError> {
    return Effect.map(this.bytes(), (bytes) => lossy.decode(bytes))
  }

  /** The body as JSON, checked against `schema` when one is given. */
  json(): Effect.Effect<unknown, HttpError>
  json<S extends Schema.ConstraintDecoder<unknown>>(schema: S): Effect.Effect<S["Type"], HttpError>
  json<S extends Schema.ConstraintDecoder<unknown>>(schema?: S): Effect.Effect<unknown, HttpError> {
    return Effect.flatMap(this.bytes(), (bytes) => {
      let value: unknown
      try {
        value = JSON.parse(strict.decode(bytes))
      } catch (error) {
        return Effect.fail(failure("Decode", rootCause(error)))
      }
      if (schema === undefined) return Effect.succeed(value)
      const decoded = Schema.decodeUnknownResult(schema)(value)
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(failure("Decode", decoded.failure.message))
    })
  }

  /**
   * The connection, once a `101 Switching Protocols` hands it over (a
   * WebSocket handshake). It is closed when the scope ends.
   */
  upgrade(): Effect.Effect<Upgraded, HttpError, Scope.Scope> {
    const source = this.source
    if (source._tag === "Raw" && this.status === 101) {
      return Effect.acquireRelease(Effect.succeed(source.conn), (conn) => conn.close)
    }
    return Effect.fail(failure("Connect", "the connection was not upgraded"))
  }

  /**
   * The body as a stream of chunks, failing if it stalls for longer than
   * the client's read timeout.
   */
  intoBody(): body.Body<body.ReadError | body.Stalled> {
    return this.readTimeout === undefined ? this.raw() : body.idleTimeout(this.raw(), this.readTimeout)
  }

  /** Lets go of the response without reading its body (or upgrading it). */
  get close(): Effect.Effect<void> {
    const source = this.source
    if (source._tag === "Raw") return Effect.sync(() => source.conn.destroy())
    if (source.response.bodyUsed || source.response.body === null) return Effect.void
    const stream = source.response.body
    return Effect.promise(() => stream.cancel().catch(() => undefined))
  }
}

// Runs `use` on what `open` gave, destroying it if `use` fails or is
// interrupted. Nothing opened is ever left behind.
const opened = <A, B, E1, E2>(
  open: Effect.Effect<A, E1>,
  use: (a: A) => Effect.Effect<B, E2>,
  destroy: (a: A) => void,
): Effect.Effect<B, E1 | E2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(open), (a) => restore(use(a)).pipe(Effect.onError(() => Effect.sync(() => destroy(a))))),
  )

// A connection to `host:port`, through the proxy unless the host bypasses
// it, with TLS for https. The TCP connect (to the proxy, when there is one)
// is bounded by the connect timeout.
const dial = (state: ClientState, host: string, port: number, https: boolean): Effect.Effect<Conn, IoError> => {
  const through = state.bypass.skips(host) ? undefined : state.through
  let socket: Effect.Effect<Socket, IoError>
  if (through?._tag === "Http") {
    socket = opened(
      openTcpWithin(through.proxy.hostname, through.proxy.port, state.connectTimeout),
      (raw) => Effect.as(tunnel(new Conn(raw), host, port, through.auth), raw),
      (raw) => raw.destroy(),
    )
  } else if (through?._tag === "Socks") {
    socket = Effect.map(socks.dial(through.socks, bare(host), port, state.connectTimeout), (conn) => {
      conn.detach()
      return conn.socket
    })
  } else {
    socket = openTcpWithin(bare(host), port, state.connectTimeout)
  }
  if (https)
    socket = opened(
      socket,
      (raw) => startTls(raw, bare(host), state.ca),
      (raw) => raw.destroy(),
    )
  return Effect.map(socket, (raw) => new Conn(raw))
}

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly conn: Conn
  readonly body: Uint8Array
}

// One request over a connection of its own: a handshake whose `101` hands
// the connection over. Other answers are read whole and the connection
// closed; so is the connection if anything fails or is interrupted.
const exchange = (
  state: ClientState,
  method: string,
  url: URL,
  headers: ReadonlyArray<readonly [string, string]>,
  payload: Uint8Array,
): Effect.Effect<Answer, IoError | body.LengthLimitError> => {
  const https = url.protocol === "https:"
  const port = Number(url.port || (https ? 443 : 80))
  return Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(dial(state, url.hostname, port, https)), (conn) =>
      restore(talk(conn, method, url, headers, payload)).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) && exit.value.status === 101 ? Effect.void : Effect.sync(() => conn.destroy()),
        ),
      ),
    ),
  )
}

const talk = Effect.fn("Client.exchange")(function* (
  conn: Conn,
  method: string,
  url: URL,
  headers: ReadonlyArray<readonly [string, string]>,
  payload: Uint8Array,
) {
  let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`
  if (!headers.some(([name]) => name === "host")) head += `host: ${url.host}\r\n`
  for (const [name, value] of headers) head += `${name}: ${wire(value)}\r\n`
  if (payload.length > 0) head += `content-length: ${payload.length}\r\n`
  head += "\r\n"
  yield* conn.write(Buffer.from(head, "latin1"))
  if (payload.length > 0) yield* conn.write(payload)
  const answer = parseHead(
    yield* conn.readHead(1024 * 1024, "connection closed before message completed", "message head is too large"),
  )
  if (answer instanceof IoError) return yield* answer
  if (answer.status === 101) return { ...answer, conn, body: new Uint8Array() }
  const bodyless = method === "HEAD" || answer.status === 204 || answer.status === 304 || answer.status < 200
  const read = bodyless ? new Uint8Array() : yield* readBody(conn, answer.headers)
  return { ...answer, conn, body: read }
})

const parseHead = (head: Uint8Array): { readonly status: number; readonly headers: Headers } | IoError => {
  const lines = latin1.decode(head).split("\r\n")
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "")?.[1]
  if (status === undefined) return new IoError({ reason: "invalid HTTP status-code parsed" })
  const headers = new Headers()
  for (const line of lines.slice(1)) {
    if (line === "") continue
    const colon = line.indexOf(":")
    if (colon <= 0) return new IoError({ reason: "invalid HTTP header parsed" })
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    } catch {
      return new IoError({ reason: "invalid HTTP header parsed" })
    }
  }
  return { status: Number(status), headers }
}

const DIGITS = /^\d+$/
const HEX_DIGITS = /^[0-9a-fA-F]+$/

// A whole body by its length, its chunks, or the end of the connection.
const readBody = Effect.fn("Client.readBody")(function* (conn: Conn, headers: Headers) {
  const chunks: Array<Uint8Array> = []
  let size = 0
  const keep = (chunk: Uint8Array): Effect.Effect<void, body.LengthLimitError> => {
    size += chunk.length
    if (size > MAX_BODY) return Effect.fail(new body.LengthLimitError({ limit: MAX_BODY }))
    chunks.push(chunk)
    return Effect.void
  }
  const length = headers.get("content-length")
  if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    for (;;) {
      const line = latin1.decode(yield* conn.readLine(64 * 1024))
      const digits = (line.split(";")[0] ?? "").trim()
      if (!HEX_DIGITS.test(digits) || digits.length > 15) {
        return yield* new IoError({ reason: "invalid chunk size line" })
      }
      const n = Number.parseInt(digits, 16)
      if (n === 0) {
        while ((yield* conn.readLine(64 * 1024)).length > 0);
        break
      }
      if (size + n > MAX_BODY) return yield* new body.LengthLimitError({ limit: MAX_BODY })
      yield* keep(yield* conn.readExact(n))
      yield* conn.readExact(2)
    }
  } else if (length !== null) {
    if (!DIGITS.test(length)) return yield* new IoError({ reason: "invalid content-length parsed" })
    const n = Number(length)
    if (n > MAX_BODY) return yield* new body.LengthLimitError({ limit: MAX_BODY })
    yield* keep(yield* conn.readExact(n))
  } else {
    for (let chunk = yield* conn.read; chunk !== undefined; chunk = yield* conn.read) yield* keep(chunk)
  }
  return Buffer.concat(chunks, size)
})
