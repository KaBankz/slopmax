// What a provider is to slopmax: a value with pure functions the proxy calls
// on every attempt (where requests go, how they are signed, how a refusal
// reads, what usage the headers show) and Effects for the cold path
// (signing in, refreshing, usage, catalogs, limit resets).
//
// `defineProvider` fills the defaults most providers share, so a new
// provider states only what makes it different.
import {
  type AgentId,
  agentFacts,
  type Dialect,
  type LimitReset,
  type Limits,
  matchesAny,
  parseHttpDate,
  parseInstant,
  type PoolWindow,
  type ProviderFacts,
  type ProviderId,
  providerFacts,
  type RedeemOutcome,
} from "@slopmax/domain"
import { common } from "@slopmax/wire"
import { Data, DateTime, Duration, Effect, Layer, Option, Redacted, Result, Schema, type Scope } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { Account, assignId, type Credential, Identity, identityKey, Tokens, withAssignedId } from "../account.ts"
import { Upstream } from "../upstream.ts"
import type { LoginUi } from "./oauth.ts"

// ---------------------------------------------------------------------------
// Errors

/** Signing in did not produce an account. */
export class LoginFailed extends Data.TaggedError("LoginFailed")<{ readonly message: string }> {}

/** Nobody finished authorizing in time. */
export class LoginTimedOut extends Data.TaggedError("LoginTimedOut")<{}> {
  override get message(): string {
    return "timed out waiting for authorization"
  }
}

/** The authorization that came back was started by someone else. */
export class StateMismatch extends Data.TaggedError("StateMismatch")<{}> {
  override get message(): string {
    return "OAuth state mismatch; start over"
  }
}

/** The provider will not refresh this sign-in again; only signing in again fixes it. */
export class RefreshRevoked extends Data.TaggedError("RefreshRevoked")<{ readonly reason: string }> {
  override get message(): string {
    return `${this.reason}; sign in again`
  }
}

/** A refresh failed in a way that may pass: the provider was down, or answered something unexpected. */
export class RefreshTransient extends Data.TaggedError("RefreshTransient")<{ readonly message: string }> {}

/** A provider API refused the account's token; a refresh may help. */
export class ProviderUnauthorized extends Data.TaggedError("ProviderUnauthorized")<{}> {
  override get message(): string {
    return "the provider rejected the token"
  }
}

/** A provider API call failed: unreachable, refused, or answered something unexpected. */
export class ProviderFailed extends Data.TaggedError("ProviderFailed")<{
  readonly message: string
  readonly status?: number
}> {}

/** The provider answers this call only to one agent, and slopmax has not seen that agent yet. */
export class NeedsAgent extends Data.TaggedError("NeedsAgent")<{ readonly agent: AgentId }> {
  override get message(): string {
    const agent = agentFacts[this.agent]
    return `${providerFacts[agent.provider].title} answers limit resets to ${agent.title} alone, and none of its requests has come through slopmax yet`
  }
}

// ---------------------------------------------------------------------------
// Values the proxy and the cold path pass around

/** How the proxy treats an answer that was not a success. */
export type Verdict = Data.TaggedEnum<{
  /** Hand the answer to the agent unchanged: it is the request's problem. */
  Final: {}
  /** The token was rejected: refresh it once, else set the account aside. */
  Unauthorized: {}
  /** The account may not serve this request. */
  Forbidden: {}
  /** The request carried conversation state another account minted; retry once without it. */
  StaleState: {}
  /** The account's quota is spent until `until`, for `model` only when set. */
  Exhausted: { readonly until?: DateTime.Utc; readonly model?: string }
  /** Briefly throttled; the account itself is fine. */
  Throttled: { readonly until?: DateTime.Utc }
}>
export const Verdict = Data.taggedEnum<Verdict>()

/** A spent quota, until a time and for a model when known. */
export const exhausted = (until: Option.Option<DateTime.Utc>, model?: string): Verdict =>
  Verdict.Exhausted({
    ...(Option.isSome(until) ? { until: until.value } : {}),
    ...(model === undefined ? {} : { model }),
  })

/** Throttling, until a time when known. */
export const throttled = (until: Option.Option<DateTime.Utc>): Verdict =>
  Verdict.Throttled(Option.isSome(until) ? { until: until.value } : {})

/** The answer for statuses every provider treats alike. */
export const verdictOfStatus = (status: number): Verdict =>
  status === 401 ? Verdict.Unauthorized() : status === 403 ? Verdict.Forbidden() : Verdict.Final()

/** An answer that was not a success, as the proxy read it. */
export interface Refusal {
  readonly status: number
  readonly headers: Headers
  /** The start of the body, read whole up to a limit. */
  readonly body: Uint8Array
  /** The model the request asked for. */
  readonly model?: string | undefined
  readonly now: DateTime.Utc
}

/** Tokens a code exchange or refresh returned. */
export interface Grant {
  readonly access: string
  readonly refresh?: string | undefined
  readonly idToken?: string | undefined
  readonly expiresAt?: DateTime.Utc | undefined
}

/** A compatible endpoint, as people describe it when adding one. */
export interface EndpointOptions {
  /** Request paths are appended to this. */
  readonly baseUrl: string
  readonly dialect: Dialect
  /** Model names or patterns; when empty, the endpoint is asked for its list. */
  readonly models: ReadonlyArray<string>
}

/** What a sign-in is given. The key is redacted, so options can be logged without leaking it. */
export interface LoginOptions {
  /** Sign in with a device code instead of a browser (ChatGPT). */
  readonly device?: boolean | undefined
  /** For a compatible endpoint: where it is and what it serves. */
  readonly endpoint?: EndpointOptions | undefined
  /** For API keys and compatible endpoints. */
  readonly key?: Redacted.Redacted<string> | undefined
  /** A name people give the account; a later sign-in without one keeps it. */
  readonly label?: string | undefined
}

/** The client headers a provider rebuilds an upstream request from, and what slopmax remembers about the agents. */
export interface HeaderInput {
  readonly client: Headers
  readonly account: Account
  /** The session just moved here from another account. */
  readonly moved: boolean
  /** The last user agent each provider's agent sent, such as Claude Code's. */
  readonly agents: Readonly<Partial<Record<ProviderId, string>>>
  /** The newest Codex release seen, and the model it last asked for. */
  readonly codex: { readonly version?: string | undefined; readonly lastModel?: string | undefined }
}

/** What a provider adds to Codex's WebSocket relay. */
export interface SocketHooks {
  /** The windows a rate-limit event reports. */
  readonly limitsFromEvent: (event: unknown, now: DateTime.Utc) => Option.Option<Limits>
  /** The event with the pool's windows in place of the account's, so the agent sees one account. */
  readonly showPoolInEvent: (event: Record<string, unknown>, pool: ReadonlyArray<PoolWindow>) => Record<string, unknown>
  /** A turn's request without state bound to the account a moved session left; none when nothing was dropped. */
  readonly rebindTurn: (request: Record<string, unknown>) => Option.Option<Record<string, unknown>>
  /** Whether a failure event is the account's (spent or throttled) rather than the request's. */
  readonly eventVerdict: (event: unknown, now: DateTime.Utc) => Option.Option<Verdict>
}

/** Banked limit resets: listing them in spend order, and redeeming one. */
export interface Resets {
  /** Whether the usage endpoint counts them, so a changed count means a new list (else they are listed on a timer). */
  readonly counted: boolean
  /** Whether only the provider's own agent may list and redeem them, with its user agent. */
  readonly needsAgent: boolean
  readonly list: (
    account: Account,
    userAgent: string | undefined,
  ) => Effect.Effect<ReadonlyArray<LimitReset>, ProviderFailed | NeedsAgent, Upstream>
  /** Redeems the named reset, or the one the provider would spend next. */
  readonly redeem: (
    account: Account,
    id: string | undefined,
    userAgent: string | undefined,
  ) => Effect.Effect<RedeemOutcome, ProviderFailed | NeedsAgent, Upstream>
}

/** What signing in needs from its surroundings. */
export type LoginServices = Upstream | LoginUi | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner

export interface Provider extends ProviderFacts {
  // Hot path: pure, called per attempt.
  /** The base URL the account's requests go to. */
  readonly apiOf: (account: Account) => string
  /** The formats the account's API speaks, preferred first. */
  readonly dialectsOf: (account: Account) => ReadonlyArray<Dialect>
  readonly serves: (account: Account, model: string) => boolean
  /** The agent's headers with the account's credential in place of slopmax's key. */
  readonly headers: (input: HeaderInput) => Headers
  readonly verdict: (refusal: Refusal) => Verdict
  /** The usage windows response headers report. */
  readonly limitsFrom: (headers: Headers, now: DateTime.Utc) => Option.Option<Limits>
  /** The response headers with the pool's windows in place of the account's. */
  readonly showPool: (headers: Headers, pool: ReadonlyArray<PoolWindow>) => Headers
  /** The body without state bound to another account; none when there is nothing to drop. */
  readonly rebind: (body: Uint8Array) => Option.Option<Uint8Array>
  /** The last touch on a body slopmax translated into this provider's format. */
  readonly shape: (body: Record<string, unknown>) => Record<string, unknown>
  readonly socket: Option.Option<SocketHooks>
  // Cold path.
  /** Who the account is at the provider: what tells accounts with separate limits apart. */
  readonly identity: (account: Account) => string | undefined
  readonly login: (
    options: LoginOptions,
  ) => Effect.Effect<Account, LoginFailed | LoginTimedOut | StateMismatch, LoginServices>
  /** Redeems the account's refresh token. */
  readonly refresh: (account: Account) => Effect.Effect<Grant, RefreshRevoked | RefreshTransient, Upstream>
  /** The account with email, plan and organization brought up to date after new tokens; failures change nothing. */
  readonly identify: (account: Account) => Effect.Effect<Account, never, Upstream>
  readonly usage: Option.Option<
    (account: Account) => Effect.Effect<Limits, ProviderUnauthorized | ProviderFailed, Upstream>
  >
  /** The models the account offers, for model lists. */
  readonly catalog: (
    account: Account,
    context: { readonly codexVersion?: string | undefined },
  ) => Effect.Effect<ReadonlyArray<string>, ProviderFailed, Upstream>
  readonly resets: Option.Option<Resets>
}

/** What a provider states; everything else takes the shared default. */
export type ProviderParts = Pick<Provider, "id" | "identity" | "login" | "headers" | "verdict"> &
  Partial<Omit<Provider, "id" | "identity" | "login" | "headers" | "verdict" | keyof ProviderFacts>>

/**
 * A provider from its parts, with the shared defaults for the rest. Each
 * behaviour is set by name rather than spread from the parts, so every
 * provider has the same fixed shape on the proxy's per-attempt calls.
 */
export const defineProvider = (parts: ProviderParts): Provider => {
  const facts: ProviderFacts = providerFacts[parts.id]
  return {
    ...facts,
    apiOf: parts.apiOf ?? (() => facts.api),
    dialectsOf: parts.dialectsOf ?? (() => facts.dialects),
    serves: parts.serves ?? ((_account, model) => matchesAny(facts.models, model)),
    headers: parts.headers,
    verdict: parts.verdict,
    limitsFrom: parts.limitsFrom ?? (() => Option.none()),
    showPool: parts.showPool ?? ((headers) => headers),
    rebind: parts.rebind ?? (() => Option.none()),
    shape: parts.shape ?? ((body) => body),
    socket: parts.socket ?? Option.none(),
    identity: parts.identity,
    login: parts.login,
    refresh:
      parts.refresh ?? (() => Effect.fail(new RefreshRevoked({ reason: `${facts.title} keys cannot be refreshed` }))),
    identify: parts.identify ?? Effect.succeed,
    usage: parts.usage ?? Option.none(),
    catalog: parts.catalog ?? (() => Effect.succeed([])),
    resets: parts.resets ?? Option.none(),
  }
}

// ---------------------------------------------------------------------------
// Headers

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const neverForwarded = new Set(["host", "content-length", "authorization", "x-api-key", "cookie"])

/** The agent's headers that may go upstream: all but hop-by-hop ones, the agent's local credentials, cookies, and slopmax's own. */
export const forwardable = (client: Headers): Headers => {
  const out = new Headers()
  for (const [name, value] of client) {
    if (hopByHop.has(name) || neverForwarded.has(name) || name.startsWith("x-slopmax-")) continue
    out.append(name, value)
  }
  return out
}

/** A header's value, trimmed. */
export const headerText = (headers: Headers, name: string): string | undefined => headers.get(name)?.trim()

/** A header read as a finite number. */
export const headerNumber = (headers: Headers, name: string): Option.Option<number> => {
  const text = headerText(headers, name)
  if (text === undefined || text === "") return Option.none()
  const value = Number(text)
  return Number.isFinite(value) ? Option.some(value) : Option.none()
}

/** Unix seconds, as providers write times, as a time; a fraction of a second is dropped. */
export const fromUnixSeconds = (seconds: number): DateTime.Utc => DateTime.makeUnsafe(Math.trunc(seconds) * 1000)

/** A time as whole unix seconds, the way providers' headers and answers carry it. */
export const unixSeconds = (at: DateTime.DateTime): number => Math.floor(DateTime.toEpochMillis(at) / 1000)

/** A unix-seconds header as a time; a fraction of a second is dropped. */
export const headerTime = (headers: Headers, name: string): Option.Option<DateTime.Utc> =>
  Option.map(headerNumber(headers, name), fromUnixSeconds)

/** `retry-after`, as seconds from now (never negative) or an HTTP date. */
export const retryAfter = (headers: Headers, now: DateTime.Utc): Option.Option<DateTime.Utc> => {
  const text = headerText(headers, "retry-after")
  if (text === undefined || text === "") return Option.none()
  const seconds = Number(text)
  if (Number.isFinite(seconds))
    return Option.some(DateTime.addDuration(now, Duration.millis(Math.max(0, seconds) * 1000)))
  return parseHttpDate(text)
}

/** A time in a JSON answer: RFC 3339 text with any offset, or unix seconds. */
export const parseTime = (value: string | number | undefined): Option.Option<DateTime.Utc> => {
  if (typeof value === "string") return parseInstant(value)
  if (typeof value === "number") return Option.some(fromUnixSeconds(value))
  return Option.none()
}

/** The latest of some times, keeping only those after `now`. */
export const latestAfter = (now: DateTime.Utc, times: ReadonlyArray<Option.Option<DateTime.Utc>>) =>
  times.reduce<Option.Option<DateTime.Utc>>((latest, time) => {
    if (Option.isNone(time) || !DateTime.isGreaterThan(time.value, now)) return latest
    return Option.isSome(latest) && DateTime.isGreaterThanOrEqualTo(latest.value, time.value) ? latest : time
  }, Option.none())

// ---------------------------------------------------------------------------
// Bodies
//
// Provider answers are read with lenient Schemas: only the fields slopmax
// uses are declared, a field of an unexpected kind reads as absent, and a
// list keeps the items that fit. Providers add and change fields often, and
// one odd value should cost that value, not the whole answer.

/** A field read when it is there and of the expected kind; absent otherwise. */
export const optionalField = common.field

/** A list read item by item, dropping the items that do not fit. */
export const listOf = common.listOf

/** A time as provider answers write it: RFC 3339 text, or unix seconds. */
export const Time = Schema.Union([Schema.String, Schema.Finite])

const utf8 = new TextDecoder()

/** JSON text as a value; none when it is not JSON. */
export const parseJson: (text: string) => Option.Option<unknown> = Option.liftThrowable((text: string): unknown =>
  JSON.parse(text),
)

/** JSON bytes as a value; none when they are not JSON. */
export const parseJsonBytes = (bytes: Uint8Array): Option.Option<unknown> => parseJson(utf8.decode(bytes))

/** Whether optional text from a file or an answer is there and not blank. */
export const present = (text: string | null | undefined): text is string => text != null && text !== ""

/** Bytes as text, for looking for words in an error body. */
export const bodyText = (bytes: Uint8Array): string => utf8.decode(bytes)

/** Whether a value is a JSON object, for rewriting request bodies slopmax forwards as they came. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// Cold calls

const reasons: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
}

/** A status as people read it: `401 Unauthorized`, `502 Bad Gateway`. */
export const statusLine = (status: number): string => {
  const reason = reasons[status]
  return reason === undefined ? String(status) : `${status} ${reason}`
}

/** An answer to a cold call, read whole. */
export interface Reply {
  readonly status: number
  readonly ok: boolean
  readonly text: string
  /** The body as JSON, when it is JSON. */
  readonly json: Option.Option<unknown>
}

/** Sends a cold call through `Upstream.http` and reads the answer whole. */
export const send = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Reply, HttpClientError.HttpClientError, Upstream> =>
  Effect.gen(function* () {
    const upstream = yield* Upstream
    const response = yield* HttpClient.execute(request).pipe(
      Effect.provideService(HttpClient.HttpClient, upstream.http),
    )
    const text = yield* response.text
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text,
      json: parseJson(text),
    }
  })

/** Why a cold call failed, in one line. */
export const callText = (error: HttpClientError.HttpClientError): string => error.message

/** Refresh tokens are single-use, so only an explicit rejection means the sign-in is gone. */
const rejections = ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]

/** A token endpoint's refusal of a refresh: revoked when it says so, else passing. */
export const refreshRefused = (status: number, body: string): RefreshRevoked | RefreshTransient =>
  status === 401 || (status >= 400 && status < 500 && rejections.some((code) => body.includes(code)))
    ? new RefreshRevoked({ reason: `refresh token rejected (${statusLine(status)})` })
    : new RefreshTransient({ message: `token refresh failed (${statusLine(status)}): ${body}` })

/** A usage endpoint's answer: 401 asks for a refresh; other failures carry the start of the body. */
export const usageAnswer = (reply: Reply): Result.Result<unknown, ProviderUnauthorized | ProviderFailed> => {
  if (reply.status === 401) return Result.fail(new ProviderUnauthorized())
  if (!reply.ok) {
    return Result.fail(
      new ProviderFailed({
        message: `usage endpoint returned ${statusLine(reply.status)}: ${reply.text.slice(0, 200)}`,
        status: reply.status,
      }),
    )
  }
  return Option.match(reply.json, {
    onNone: () => Result.fail(new ProviderFailed({ message: "usage endpoint answered something other than JSON" })),
    onSome: Result.succeed,
  })
}

/** A usage call that could not be made. */
export const unreachable = (error: HttpClientError.HttpClientError) => new ProviderFailed({ message: callText(error) })

const crypto = Layer.merge(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)

/** Runs an Effect with Web Crypto's hashes and randomness. */
export const withCrypto = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Digest.Digest | SecureRandom.SecureRandom>> => Effect.provide(effect, crypto)

/** The account with its id computed from who it is. */
export const identified = (account: Account): Effect.Effect<Account> => withCrypto(withAssignedId(account))

/** A duration in whole seconds from now. */
export const inSeconds = (now: DateTime.Utc, seconds: number): DateTime.Utc =>
  DateTime.addDuration(now, Duration.seconds(seconds))

/** A grant's tokens, stamped as refreshed now. */
export const tokensOf = (grant: Grant, now: DateTime.Utc): Tokens =>
  new Tokens({
    access: Redacted.make(grant.access),
    ...(grant.refresh === undefined ? {} : { refresh: Redacted.make(grant.refresh) }),
    ...(grant.idToken === undefined ? {} : { idToken: Redacted.make(grant.idToken) }),
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
    refreshedAt: now,
  })

/** A newly signed-in account, with its id computed from who it is. */
export const newAccount = (fields: {
  readonly provider: ProviderId
  readonly credential: Credential
  readonly identity?: Identity | undefined
  readonly now: DateTime.Utc
}): Effect.Effect<Account> => {
  const identity = fields.identity ?? new Identity({})
  const key = identityKey({ provider: fields.provider, credential: fields.credential, identity })
  return Effect.map(
    withCrypto(assignId(fields.provider, key)),
    (id) =>
      new Account({ id, provider: fields.provider, credential: fields.credential, identity, addedAt: fields.now }),
  )
}

/** When a limit reset expires, for sorting soonest first: one that never expires comes last. */
export const expiryOf = (reset: LimitReset): number =>
  reset.expiresAt === undefined ? Number.POSITIVE_INFINITY : DateTime.toEpochMillis(reset.expiresAt)
