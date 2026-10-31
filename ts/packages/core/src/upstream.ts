// Every byte slopmax sends to a provider goes out here.
//
// Inference requests are native `fetch` calls made inside `Effect.callback`,
// with exactly the headers the proxy built and no decompression: bodies and
// `content-encoding` reach the agent as the provider sent them. Cold calls
// (sign-in, usage, resets, catalogs, webhooks) use an `HttpClient` that
// decompresses as usual, sets slopmax's user agent, and never adds trace
// headers: extra headers on subscription traffic are an account risk.
//
// Both go through one route, decided once at start: the upstream proxy from
// the settings, else `HTTPS_PROXY`/`ALL_PROXY` (`HTTP_PROXY` is not read);
// loopback hosts and `NO_PROXY` entries go direct. SOCKS5 proxies are
// reached through a loopback bridge (`socks.ts`). TLS trusts the system's
// roots and Bun's bundled ones, so proxies that intercept TLS keep working.
import tls from "node:tls"
import { slopmaxVersion } from "@slopmax/domain"
import { Config, Context, Data, Duration, Effect, Layer, Option, Result, type Scope, Stream } from "effect"
import { type Dns, NetAddress } from "effect/net"
import * as BunDns from "@effect/platform-bun/BunDns"
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { dial as dialSocket, type DialRoute, type UpstreamSocket } from "./dial.ts"
import { causeText } from "./home.ts"
import { SettingsService } from "./settings.ts"
import { bridge, SocksFailed, type SocksTarget } from "./socks.ts"

export type { UpstreamSocket } from "./dial.ts"

/** The provider could not be reached, or the connection broke. */
export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly url: string; readonly cause: unknown }> {
  override get message(): string {
    return `request failed: ${causeText(this.cause)}`
  }
}

/** No answer within the wait. */
export class TimedOut extends Data.TaggedError("TimedOut")<{ readonly after: Duration.Duration }> {
  override get message(): string {
    return `timed out after ${Duration.format(this.after)}`
  }
}

/** A body was longer than slopmax reads whole. */
export class TooLarge extends Data.TaggedError("TooLarge")<{ readonly limit: number }> {
  override get message(): string {
    return `body exceeds ${this.limit} bytes`
  }
}

/** The upstream proxy setting is not a proxy slopmax can use. */
export class ProxyUrlInvalid extends Data.TaggedError("ProxyUrlInvalid")<{
  /** Where the value came from: `upstreamProxy` or an environment variable. */
  readonly source: string
  readonly reason: string
}> {
  override get message(): string {
    return `${this.source}: ${this.reason}`
  }
}

/** One inference request, exactly as the provider is to get it. */
export interface UpstreamRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: Uint8Array<ArrayBuffer> | string | undefined
}

/** An upstream proxy: an HTTP CONNECT proxy, or SOCKS5 with names resolved here or by the proxy. */
export interface ProxyTarget {
  readonly kind: "http" | "socks5" | "socks5h"
  readonly host: string
  readonly port: number
  readonly user?: string | undefined
  readonly password?: string | undefined
}

const percentDecode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * Reads a proxy URL: `http://`, `socks5://` or `socks5h://` (any case),
 * with optional `user:password@` (percent-decoded) and port (80 for http,
 * 1080 for SOCKS); a trailing `/` is ignored.
 */
export const parseProxyUrl = (input: string): Result.Result<ProxyTarget, string> => {
  const text = input.trim()
  const split = text.indexOf("://")
  if (split < 0) return Result.fail(`proxy ${JSON.stringify(text)} needs a scheme, like http:// or socks5://`)
  const scheme = text.slice(0, split).toLowerCase()
  if (scheme !== "http" && scheme !== "socks5" && scheme !== "socks5h") {
    return Result.fail(`unsupported proxy scheme ${JSON.stringify(scheme)}`)
  }
  const rest = text.slice(split + 3).replace(/\/+$/, "")
  const at = rest.lastIndexOf("@")
  const userinfo = at < 0 ? undefined : rest.slice(0, at)
  const authority = at < 0 ? rest : rest.slice(at + 1)
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  const plain = /^([^:/[\]]+)(?::(\d+))?$/.exec(authority)
  const [, host = "", portText] = bracketed ?? plain ?? []
  if (host === "") return Result.fail(`proxy ${JSON.stringify(text)} names no host`)
  const port = portText === undefined ? (scheme === "http" ? 80 : 1080) : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Result.fail(`proxy ${JSON.stringify(text)} has an invalid port`)
  }
  if (userinfo === undefined) return Result.succeed({ kind: scheme, host, port })
  const colon = userinfo.indexOf(":")
  const user = percentDecode(colon < 0 ? userinfo : userinfo.slice(0, colon))
  const password = percentDecode(colon < 0 ? "" : userinfo.slice(colon + 1))
  return Result.succeed({ kind: scheme, host, port, user, password })
}

const hostText = (host: string) => (host.includes(":") ? `[${host}]` : host)

/** A proxy as people see it: never with its credentials. */
export const showProxy = (proxy: ProxyTarget): string => `${proxy.kind}://${hostText(proxy.host)}:${proxy.port}`

/** `Basic base64(user:password)` for a proxy that has credentials. */
export const basicAuthorization = (user: string, password: string): string => {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  return `Basic ${btoa(String.fromCodePoint(...bytes))}`
}

/** The environment variables a proxy is read from, in order. `HTTP_PROXY` is not one of them. */
export const proxyVariables = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const

/**
 * The proxy to use: the setting, else the first environment variable that is
 * set and not empty. A bad setting is an error; a bad environment value
 * means no proxy, as other tools read it.
 */
export const chooseProxy = (
  setting: Option.Option<string>,
  env: ReadonlyArray<readonly [name: string, value: Option.Option<string>]>,
): Result.Result<Option.Option<ProxyTarget>, ProxyUrlInvalid> => {
  if (Option.isSome(setting)) {
    return Result.match(parseProxyUrl(setting.value), {
      onSuccess: (proxy) => Result.succeed(Option.some(proxy)),
      onFailure: (reason) => Result.fail(new ProxyUrlInvalid({ source: "upstreamProxy in config.json", reason })),
    })
  }
  for (const [, value] of env) {
    if (Option.isNone(value) || value.value.trim() === "") continue
    return Result.succeed(Result.getSuccess(parseProxyUrl(value.value)))
  }
  return Result.succeed(Option.none())
}

const stripBrackets = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

/** Whether a host is this machine: `localhost`, or a loopback address. */
export const isLoopback = (host: string): boolean => {
  const bare = stripBrackets(host).toLowerCase()
  if (bare === "localhost" || bare.endsWith(".localhost")) return true
  return Result.match(NetAddress.ipFromString(bare), {
    onSuccess: (ip) =>
      NetAddress.isLoopback(ip) ||
      (ip._tag === "Ipv6Address" && Option.exists(NetAddress.fromIpv4Mapped(ip), (v4) => NetAddress.isLoopback(v4))),
    onFailure: () => false,
  })
}

/** `NO_PROXY`'s entries: comma-separated, case-insensitive, with leading dots dropped. */
export const parseNoProxy = (text: string): ReadonlyArray<string> =>
  text
    .split(",")
    .map((entry) => stripBrackets(entry.trim().toLowerCase().replace(/^\.+/, "")))
    .filter((entry) => entry !== "")

/** Whether requests to `host` skip the proxy: loopback, or `*`, the host itself, or a parent domain in `NO_PROXY`. */
export const bypassesProxy = (host: string, noProxy: ReadonlyArray<string>): boolean => {
  const bare = stripBrackets(host).toLowerCase()
  return isLoopback(bare) || noProxy.some((entry) => entry === "*" || bare === entry || bare.endsWith(`.${entry}`))
}

/**
 * Sends a URL whose start matches a key to the key's value instead, when the
 * match ends the URL or is followed by `/` or `?`. Tests point providers at a
 * mock this way.
 */
export const rewriteOrigin = (url: string, origins: Readonly<Record<string, string>>): string => {
  for (const [prefix, replacement] of Object.entries(origins)) {
    if (!url.startsWith(prefix)) continue
    const rest = url.slice(prefix.length)
    if (rest === "" || rest.startsWith("/") || rest.startsWith("?")) return `${replacement.replace(/\/+$/, "")}${rest}`
  }
  return url
}

/** The system's trusted roots and Bun's bundled ones, read once. */
export const trustedRoots = (): ReadonlyArray<string> => [
  ...new Set([...tls.getCACertificates("system"), ...tls.getCACertificates("bundled")]),
]

type FetchInit = BunFetchRequestInit
type FetchFunction = (input: string | URL | Request, init?: FetchInit) => Promise<Response>

/** The longest slopmax waits for a provider's response headers. */
export const headersWait = Duration.seconds(600)

/** The longest a cold call may take, headers and body together. */
export const coldWait = Duration.seconds(30)

/** The longest slopmax waits for Codex's upstream socket to open. */
export const dialWait = Duration.seconds(15)

export interface Shape {
  /** Inference: native fetch; decompression off; the route's proxy and roots; redirects passed through. */
  readonly send: (request: UpstreamRequest) => Effect.Effect<Response, Unreachable | TimedOut>
  /** Reads a body whole, failing past `limit` bytes. For error bodies, which are never streamed to the agent. */
  readonly readAll: (response: Response, limit: number) => Effect.Effect<Uint8Array, Unreachable | TooLarge>
  /** Cold calls: sign-in, usage, resets, catalogs, webhooks. */
  readonly http: HttpClient.HttpClient
  /** Codex's upstream socket, waiting at most 15 s for it to open. */
  readonly dial: (url: string, headers: Headers) => Effect.Effect<UpstreamSocket, Unreachable | TimedOut, Scope.Scope>
  /** The proxy in use, as people see it, if any. */
  readonly proxy: Option.Option<string>
}

/** The chunks read so far and their total size. */
interface Collected {
  readonly chunks: Array<Uint8Array>
  readonly size: number
}

const joinChunks = ({ chunks, size }: Collected): Uint8Array => {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Reads a body whole, giving up (and cancelling the read) past `limit` bytes. */
const readAll = (response: Response, limit: number): Effect.Effect<Uint8Array, Unreachable | TooLarge> => {
  const body = response.body
  if (body === null) return Effect.succeed(new Uint8Array(0))
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new Unreachable({ url: response.url, cause }),
  }).pipe(
    Stream.runFoldEffect(
      (): Collected => ({ chunks: [], size: 0 }),
      (collected, chunk): Effect.Effect<Collected, TooLarge> => {
        const size = collected.size + chunk.length
        if (size > limit) return Effect.fail(new TooLarge({ limit }))
        collected.chunks.push(chunk)
        return Effect.succeed({ chunks: collected.chunks, size })
      },
    ),
    Effect.map(joinChunks),
  )
}

/** Statuses whose responses never carry a body. */
const bodiless = new Set([101, 103, 204, 205, 304])

/**
 * Reads a cold call's body before the call counts as answered, so the 30 s
 * timeout covers a provider that sends its headers and then stalls. Cold
 * answers are small JSON documents, so holding one in memory costs nothing.
 */
const readWhole = <E, R>(
  effect: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, E | HttpClientError.HttpClientError, R> =>
  Effect.flatMap(effect, (response) =>
    Option.match(HttpClientResponse.toWeb(response), {
      onNone: () => Effect.succeed(response),
      onSome: (source) =>
        Effect.map(response.arrayBuffer, (bytes) =>
          HttpClientResponse.fromWeb(
            response.request,
            new Response(bodiless.has(source.status) ? null : bytes, {
              status: source.status,
              statusText: source.statusText,
              headers: source.headers,
            }),
          ),
        ),
    }),
  )

/** How requests leave this process: a fetch for each, and how sockets are dialed. */
interface Route {
  readonly fetch: FetchFunction
  readonly dialRoute: (url: string) => DialRoute
  readonly proxy: Option.Option<string>
}

const build = (route: Route): Effect.Effect<Shape> =>
  Effect.gen(function* () {
    const send = (request: UpstreamRequest): Effect.Effect<Response, Unreachable | TimedOut> =>
      Effect.callback<Response, Unreachable>((resume, signal) => {
        route
          .fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal,
            decompress: false,
            redirect: "manual",
          })
          .then(
            (response) => resume(Effect.succeed(response)),
            (cause: unknown) => resume(Effect.fail(new Unreachable({ url: request.url, cause }))),
          )
      }).pipe(
        Effect.timeoutOrElse({
          duration: headersWait,
          orElse: () => Effect.fail(new TimedOut({ after: headersWait })),
        }),
      )

    const fetchForClient = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => route.fetch(input, init),
      { preconnect: fetch.preconnect },
    )
    const base = yield* Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer)
    const userAgent = `slopmax/${slopmaxVersion}`
    const http = base.pipe(
      HttpClient.mapRequest((request) =>
        request.headers["user-agent"] === undefined
          ? HttpClientRequest.setHeader(request, "user-agent", userAgent)
          : request,
      ),
      // The request is aborted when its scope closes: on the timeout, or once
      // the body has been read whole.
      HttpClient.withScope,
      HttpClient.transformResponse(readWhole),
      HttpClient.timeout(coldWait),
      HttpClient.transformResponse((effect) =>
        Effect.scoped(effect).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetchForClient),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        ),
      ),
    )

    const dial = (url: string, headers: Headers) =>
      dialSocket(url, headers, route.dialRoute(url)).pipe(
        Effect.timeoutOrElse({ duration: dialWait, orElse: () => Effect.fail(new TimedOut({ after: dialWait })) }),
        Effect.catchTags({
          DialRefused: (error) => Effect.fail(new Unreachable({ url, cause: error.cause })),
          DialTimedOut: (error) => Effect.fail(new TimedOut({ after: error.after })),
        }),
      )

    return { send, readAll, http, dial, proxy: route.proxy }
  })

const hostOf = (input: string): string => URL.parse(input)?.hostname ?? ""

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url

/** What the route is built from. */
export interface RouteOptions {
  readonly proxy: Option.Option<ProxyTarget>
  readonly noProxy: ReadonlyArray<string>
  readonly origins: Readonly<Record<string, string>>
}

/** The route over the network: sessions for direct and proxied calls, starting a SOCKS bridge when needed. */
export const networkRoute = (options: RouteOptions): Effect.Effect<Route, SocksFailed, Scope.Scope | Dns.Dns> =>
  Effect.gen(function* () {
    const ca = trustedRoots()
    const tlsOptions = { ca: [...ca] }
    let viaProxy: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined
    if (Option.isSome(options.proxy)) {
      const proxy = options.proxy.value
      if (proxy.kind === "http") {
        const headers: Record<string, string> =
          proxy.user === undefined
            ? {}
            : { "proxy-authorization": basicAuthorization(proxy.user, proxy.password ?? "") }
        viaProxy = { url: `http://${hostText(proxy.host)}:${proxy.port}`, headers }
      } else {
        const socks: SocksTarget = { ...proxy, remoteDns: proxy.kind === "socks5h" }
        const started = yield* bridge(socks)
        viaProxy = { url: started.url, headers: { "proxy-authorization": started.authorization } }
      }
    }
    // `false` goes direct even when the environment names a proxy: slopmax decides, not the runtime.
    const proxyOption: FetchInit["proxy"] =
      viaProxy === undefined ? false : { url: viaProxy.url, headers: viaProxy.headers, respectNoProxy: false }
    // Whether a host skips the proxy is worked out once per host: the same
    // few providers are asked on every request.
    const direct = new Map<string, boolean>()
    const hostGoesDirect = (host: string): boolean => {
      const known = direct.get(host)
      if (known !== undefined) return known
      const decided = bypassesProxy(host, options.noProxy)
      if (direct.size >= 1024) direct.clear()
      direct.set(host, decided)
      return decided
    }
    const goesDirect = (url: string) => viaProxy === undefined || hostGoesDirect(hostOf(url))
    const routed: FetchFunction = (input, init) => {
      const url = rewriteOrigin(urlOf(input), options.origins)
      const target = typeof input === "string" || input instanceof URL ? url : new Request(url, input)
      return fetch(target, { ...init, proxy: goesDirect(url) ? false : proxyOption, tls: tlsOptions })
    }
    return {
      fetch: routed,
      dialRoute: (url) => ({ proxy: goesDirect(rewriteOrigin(url, options.origins)) ? undefined : viaProxy, ca }),
      proxy: Option.map(options.proxy, showProxy),
    }
  })

const env = (name: string) => Config.option(Config.String(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()))

/** The route the settings and the environment ask for, with `origins` rewritten. */
const routeFromSettings = (origins: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService
    const variables: Array<readonly [string, Option.Option<string>]> = []
    for (const name of proxyVariables) variables.push([name, yield* env(name)])
    const proxy = yield* Effect.fromResult(chooseProxy(settings.running.upstreamProxy, variables))
    const upper = yield* env("NO_PROXY")
    const lower = yield* env("no_proxy")
    const noProxy = Option.getOrElse(
      Option.orElse(
        Option.filter(upper, (value) => value.trim() !== ""),
        () => lower,
      ),
      () => "",
    )
    return yield* networkRoute({ proxy, noProxy: parseNoProxy(noProxy), origins })
  })

/** Every outbound call slopmax makes. */
export class Upstream extends Context.Service<Upstream, Shape>()("@slopmax/core/Upstream", {
  make: Effect.flatMap(routeFromSettings({}), build),
}) {
  static readonly layer: Layer.Layer<Upstream, ProxyUrlInvalid | SocksFailed, SettingsService> = Layer.effect(
    Upstream,
    Upstream.make,
  ).pipe(Layer.provide(BunDns.layer))

  /** Tests: every URL starting with a key goes to its value instead. */
  static readonly layerOrigins = (
    origins: Readonly<Record<string, string>>,
  ): Layer.Layer<Upstream, ProxyUrlInvalid | SocksFailed, SettingsService> =>
    Layer.effect(Upstream, Effect.flatMap(routeFromSettings(origins), build)).pipe(Layer.provide(BunDns.layer))

  /** Tests: every call is answered by `handler` in this process, with no sockets. */
  static readonly layerHandler = (handler: (request: Request) => Response | Promise<Response>): Layer.Layer<Upstream> =>
    Layer.effect(
      Upstream,
      build({
        fetch: async (input, init) =>
          handler(input instanceof Request ? new Request(input, init) : new Request(urlOf(input), init)),
        dialRoute: () => ({ proxy: undefined, ca: [] }),
        proxy: Option.none(),
      }),
    )
}
