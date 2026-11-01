// The front door's first decision: what a request is, from its method, path
// and a few headers, before any key is checked or any byte of its body read.
//
// slopmax serves several clients on one port. Claude Code is pointed at
// `/claude`, Codex at `/codex`, and Anthropic- or OpenAI-style tools at the
// unprefixed `/v1`. Each path tells which format the client speaks and
// which provider's API the request belongs to unless its model says
// otherwise. slopmax's own API, the dashboard and the hub share the port.
import type { Dialect, ProviderId } from "@slopmax/domain"
import { Data } from "effect"

/** Where an inference request goes, judged from its path. */
export interface Route {
  /** The provider whose API the path belongs to; it serves the request unless the model routes it elsewhere. */
  readonly pathProvider: ProviderId | undefined
  /** The format the client speaks. */
  readonly dialect: Dialect
  /** The path and query to forward, relative to the API's base URL. */
  readonly path: string
  /** The request's method, as the client sent it. */
  readonly method: string
  /** Whether the model in the body picks the provider. */
  readonly byModel: boolean
  /** A `GET` for a model list: allowed to a client key held to some models, since it spends nothing. */
  readonly listing: boolean
  /** An agent's housekeeping (not a `POST`, or counting tokens): it takes no round-robin turn. */
  readonly housekeeping: boolean
  /** Messages' token counting, which slopmax can estimate when no Messages API serves the model. */
  readonly countTokens: boolean
}

/** What a request is. */
export type Entry = Data.TaggedEnum<{
  /** `GET /healthz`. */
  Health: {}
  /** `HEAD` anything, or `/api/hello`: Claude Code's probes. */
  Hello: {}
  /** slopmax's own API, the dashboard, and the hub. */
  Web: {}
  /** `GET /v1/models` from an OpenAI-style client: the list slopmax makes. */
  Models: {}
  Inference: { readonly route: Route }
  /** A WebSocket handshake on an inference path. */
  Socket: { readonly route: Route }
  Unknown: {}
}>
export const Entry = Data.taggedEnum<Entry>()

const health: Entry = Entry.Health()
const hello: Entry = Entry.Hello()
const web: Entry = Entry.Web()
const models: Entry = Entry.Models()
const unknown: Entry = Entry.Unknown()

/** The path and query of an absolute URL, without parsing it: the request line's target. */
export const targetOf = (url: string): string => {
  const scheme = url.indexOf("://")
  const slash = url.indexOf("/", scheme < 0 ? 0 : scheme + 3)
  return slash < 0 ? "/" : url.slice(slash)
}

const pathOnly = (target: string): string => {
  const query = target.indexOf("?")
  return query < 0 ? target : target.slice(0, query)
}

/** `rest` with `prefix` taken off, when the prefix is a whole path segment: followed by the end, `/` or `?`. */
const strip = (target: string, prefix: string): string | undefined => {
  if (!target.startsWith(prefix)) return undefined
  const next = target.charCodeAt(prefix.length)
  return Number.isNaN(next) || next === 0x2f || next === 0x3f ? target.slice(prefix.length) : undefined
}

/** Whether a path (query ignored) is `prefix` or under it. */
const under = (target: string, prefix: string): boolean => {
  const path = pathOnly(target)
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * Whether `GET /v1/models` wants the list of every model slopmax can serve
 * an OpenAI-style client. Claude Code (by its user agent or the
 * `anthropic-version` header) and Codex (by `client_version=`) list their
 * own provider's models instead, which the proxy forwards.
 */
export const wantsModelList = (headers: Headers, query: string): boolean =>
  !(headers.get("user-agent")?.startsWith("claude-cli/") ?? false) &&
  !headers.has("anthropic-version") &&
  !query.includes("client_version=")

const routeOf = (
  method: string,
  pathProvider: ProviderId | undefined,
  dialect: Dialect,
  path: string,
  byModel: boolean,
): Route => {
  const bare = pathOnly(path)
  return {
    pathProvider,
    dialect,
    path,
    method,
    byModel,
    listing: method === "GET" && bare.endsWith("/models"),
    housekeeping: method !== "POST" || path.includes("/count_tokens"),
    countTokens: bare.startsWith("/v1/messages/count_tokens"),
  }
}

const claude = (method: string, path: string): Route =>
  routeOf(method, "claude", "messages", path, under(path, "/v1/messages"))

const codex = (method: string, path: string): Route =>
  routeOf(method, "codex", "responses", path, under(path, "/responses"))

/** The route for an inference path, or none when slopmax does not serve it. */
export const routeFor = (method: string, target: string, headers: Headers): Route | undefined => {
  const claudeRest = strip(target, "/claude")
  if (claudeRest !== undefined) return claude(method, claudeRest)
  const codexRest = strip(target, "/codex")
  if (codexRest !== undefined) return codex(method, codexRest)
  // Unprefixed `/v1`, as an Anthropic- or OpenAI-style base URL sends.
  const rest = strip(target, "/v1")
  if (rest === undefined) return undefined
  if (under(rest, "/chat/completions")) return routeOf(method, undefined, "chat", rest, true)
  const path = pathOnly(rest)
  const isCodex =
    path.startsWith("/responses") ||
    (path === "/models" && rest.includes("client_version=") && !headers.has("anthropic-version"))
  return isCodex ? codex(method, rest) : claude(method, `/v1${rest}`)
}

const isWebSocket = (headers: Headers): boolean => headers.get("upgrade")?.toLowerCase() === "websocket"

/**
 * What a request is. The order matters: `/healthz`, then the probes (so
 * even `HEAD /slopmax/…` is an empty 200), then slopmax's own paths, then
 * the model list, then the proxy's routes.
 */
export const classify = (method: string, url: string, headers: Headers): Entry => {
  const target = targetOf(url)
  const path = pathOnly(target)
  if (method === "GET" && path === "/healthz") return health
  if (method === "HEAD" || path === "/api/hello") return hello
  if (path.startsWith("/slopmax/") || path === "/slopmax" || path.startsWith("/v0/management/")) return web
  if (method === "GET" && path === "/v1/models" && wantsModelList(headers, target.slice(path.length))) return models
  const route = routeFor(method, target, headers)
  if (route === undefined) return unknown
  return isWebSocket(headers) ? Entry.Socket({ route }) : Entry.Inference({ route })
}
