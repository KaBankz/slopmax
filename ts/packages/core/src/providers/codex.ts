// ChatGPT Plus, Pro and Team subscriptions, as Codex uses them.
//
// Codex requests go to the ChatGPT backend with the account's token and
// workspace. Encrypted reasoning in a conversation is bound to the account
// that produced it, so it is dropped when a session moves to another
// account; the readable summaries stay. Usage comes from the `x-codex-*`
// headers, from `codex.rate_limits` events on Codex's WebSocket, and from
// the usage endpoint, which also counts banked reset credits.
import {
  exhaustedUntil,
  LimitReset,
  Limits,
  LoginEvent,
  newUuid,
  observed,
  type PoolWindow,
  type RedeemOutcome,
  spanFor,
  spanMinutes,
  Window,
} from "@slopmax/domain"
import { Data, DateTime, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Account, Credential, Identity } from "../account.ts"
import type { Upstream } from "../upstream.ts"
import { browserLogin, jwtClaims, jwtExpiry, LoginUi, makePkce, newState } from "./oauth.ts"
import {
  bodyText,
  callText,
  defineProvider,
  exhausted,
  expiryOf,
  forwardable,
  type Grant,
  headerNumber,
  headerTime,
  inSeconds,
  isRecord,
  listOf,
  LoginFailed,
  newAccount,
  optionalField,
  parseJsonBytes,
  parseTime,
  type Provider,
  ProviderFailed,
  type ProviderUnauthorized,
  type Refusal,
  refreshRefused,
  RefreshRevoked,
  RefreshTransient,
  retryAfter,
  send,
  statusLine,
  type SocketHooks,
  throttled,
  Time,
  tokensOf,
  unreachable,
  usageAnswer,
  Verdict,
  verdictOfStatus,
  withCrypto,
  unixSeconds,
} from "./provider.ts"

/** The ChatGPT backend: the Codex API, usage, and reset credits. */
export const backend = "https://chatgpt.com/backend-api"
export const clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
export const issuer = "https://auth.openai.com"
export const scopes = "openid profile email offline_access"
/** OpenAI accepts only this loopback redirect for Codex's client. */
export const callbackPort = 1455
export const callbackPath = "/auth/callback"
export const redirectUri = `http://localhost:${callbackPort}${callbackPath}`
export const deviceVerifyUrl = "https://auth.openai.com/codex/device"
export const deviceRedirectUri = "https://auth.openai.com/deviceauth/callback"
/** How long a device code may wait for approval. */
export const deviceWait = Duration.minutes(15)

/** The claim objects that carry the ChatGPT workspace, plan and email. */
const authClaim = "https://api.openai.com/auth"
const profileClaim = "https://api.openai.com/profile"

// ---------------------------------------------------------------------------
// Signing in

/** Where the person authorizes, with the parameters in the order Codex sends them. */
export const authorizeUrl = (challenge: string, state: string): string =>
  `${issuer}/oauth/authorize?${new URLSearchParams([
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["scope", scopes],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    // Always show the account picker, so a second account can be added.
    ["prompt", "login"],
    ["state", state],
    ["originator", "codex_cli_rs"],
  ]).toString()}`

const optionalText = Schema.optional(Schema.NullOr(Schema.String))
const TokenAnswer = Schema.Struct({ access_token: Schema.String, refresh_token: optionalText, id_token: optionalText })
const decodeTokenAnswer = Schema.decodeUnknownOption(TokenAnswer)

const grantOf = (answer: typeof TokenAnswer.Type): Grant => ({
  access: answer.access_token,
  refresh: answer.refresh_token ?? undefined,
  idToken: answer.id_token ?? undefined,
  expiresAt: Option.getOrUndefined(jwtExpiry(answer.access_token)),
})

const claimText = optionalField(Schema.NonEmptyString)

/** The claims ChatGPT's tokens carry about the workspace, the plan and the person. */
const readClaims = jwtClaims(
  Schema.Struct({
    email: claimText,
    [authClaim]: optionalField(Schema.Struct({ chatgpt_account_id: claimText, chatgpt_plan_type: claimText })),
    [profileClaim]: optionalField(Schema.Struct({ email: claimText })),
  }),
)

/**
 * The identity with what the tokens' claims say: the workspace, the plan and
 * the email, looked for in the id token first, then the access token. Blank
 * claims are ignored and known values kept when a claim is absent.
 */
export const withClaims = (
  identity: Identity,
  tokens: { readonly access: string; readonly idToken?: string | undefined },
): Identity => {
  const claims = [tokens.idToken, tokens.access].flatMap((token) =>
    token === undefined ? [] : Option.toArray(readClaims(token)),
  )
  const find = (pick: (found: (typeof claims)[number]) => string | undefined) =>
    claims.reduce<string | undefined>((value, found) => value ?? pick(found), undefined)
  const accountId = find((c) => c[authClaim]?.chatgpt_account_id)
  const plan = find((c) => c[authClaim]?.chatgpt_plan_type)
  const email = find((c) => c.email) ?? find((c) => c[profileClaim]?.email)
  return new Identity({
    ...identity,
    ...(accountId === undefined ? {} : { accountId }),
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
  })
}

/** The account's tokens as plain text, for reading their claims. */
const tokenTexts = (account: Account) =>
  Option.match(account.tokens, {
    onNone: () => ({ access: account.secret }),
    onSome: (tokens) => ({
      access: Redacted.value(tokens.access),
      idToken: tokens.idToken === undefined ? undefined : Redacted.value(tokens.idToken),
    }),
  })

/** Exchanges an authorization code for tokens and builds the account, named by its claims. */
export const exchange = (
  code: string,
  verifier: string,
  redirect: string,
): Effect.Effect<Account, LoginFailed, Upstream> =>
  Effect.gen(function* () {
    const reply = yield* send(
      HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: verifier,
        }),
      ),
    ).pipe(Effect.mapError((error) => new LoginFailed({ message: callText(error) })))
    if (!reply.ok)
      return yield* new LoginFailed({ message: `token exchange failed (${statusLine(reply.status)}): ${reply.text}` })
    const answer = Option.flatMap(reply.json, decodeTokenAnswer)
    if (Option.isNone(answer)) return yield* new LoginFailed({ message: "unexpected token response" })
    const now = yield* DateTime.now
    const grant = grantOf(answer.value)
    return yield* newAccount({
      provider: "codex",
      credential: Credential.cases.OAuth.make({ tokens: tokensOf(grant, now) }),
      identity: withClaims(new Identity({}), grant),
      now,
    })
  })

const DeviceCode = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.optional(Schema.String),
  usercode: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Unknown),
})
const decodeDeviceCode = Schema.decodeUnknownOption(DeviceCode)
const DeviceGrant = Schema.Struct({ authorization_code: Schema.String, code_verifier: Schema.String })
const decodeDeviceGrant = Schema.decodeUnknownOption(DeviceGrant)

/** The seconds between polls: a number or numeric text, 5 when absent, at least 1. */
export const pollInterval = (value: unknown): number => {
  const seconds =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 5
  return Number.isFinite(seconds) ? Math.max(1, Math.trunc(seconds)) : 5
}

/** The device code has not been approved yet. */
class NotApproved extends Data.TaggedError("NotApproved")<{}> {}

const loginCall = (request: HttpClientRequest.HttpClientRequest) =>
  send(request).pipe(Effect.mapError((error) => new LoginFailed({ message: callText(error) })))

/** Signs in with a short code entered at auth.openai.com, for machines without a browser. */
export const deviceLogin: Effect.Effect<Account, LoginFailed, Upstream | LoginUi> = Effect.gen(function* () {
  const ui = yield* LoginUi
  const started = yield* loginCall(
    HttpClientRequest.post(`${issuer}/api/accounts/deviceauth/usercode`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ client_id: clientId }),
    ),
  )
  if (!started.ok) return yield* new LoginFailed({ message: "device login is unavailable" })
  const code = Option.flatMap(started.json, decodeDeviceCode)
  const userCode = Option.flatMap(code, (found) => Option.fromUndefinedOr(found.user_code ?? found.usercode))
  if (Option.isNone(code) || Option.isNone(userCode)) {
    return yield* new LoginFailed({ message: "device login is unavailable" })
  }
  const interval = Duration.seconds(pollInterval(code.value.interval))
  yield* ui.tell(LoginEvent.cases.DeviceCode.make({ url: deviceVerifyUrl, code: userCode.value }))
  const poll = Effect.gen(function* () {
    const reply = yield* loginCall(
      HttpClientRequest.post(`${issuer}/api/accounts/deviceauth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ device_auth_id: code.value.device_auth_id, user_code: userCode.value }),
      ),
    )
    if (reply.status === 403 || reply.status === 404) return yield* new NotApproved()
    if (!reply.ok)
      return yield* new LoginFailed({ message: `device login failed (${statusLine(reply.status)}): ${reply.text}` })
    return yield* Option.match(Option.flatMap(reply.json, decodeDeviceGrant), {
      onNone: () => Effect.fail(new LoginFailed({ message: "unexpected device login response" })),
      onSome: Effect.succeed,
    })
  })
  // Asked every interval, the first time one interval after the code is shown, for as long as the code lives.
  const grant = yield* Effect.sleep(interval).pipe(
    Effect.andThen(poll),
    Effect.retry({ schedule: Schedule.spaced(interval), while: (error) => error._tag === "NotApproved" }),
    Effect.timeoutOrElse({
      duration: deviceWait,
      orElse: () => Effect.fail(new LoginFailed({ message: "device code expired; run login again" })),
    }),
    Effect.catchTag("NotApproved", () =>
      Effect.fail(new LoginFailed({ message: "device code expired; run login again" })),
    ),
  )
  return yield* exchange(grant.authorization_code, grant.code_verifier, deviceRedirectUri)
}).pipe(Effect.withSpan("codex.deviceLogin"))

const login: Provider["login"] = (options) =>
  options.device === true
    ? deviceLogin
    : Effect.gen(function* () {
        const pkce = yield* withCrypto(makePkce)
        const state = yield* withCrypto(newState)
        const callback = yield* browserLogin({
          title: "ChatGPT",
          url: authorizeUrl(pkce.challenge, state),
          port: callbackPort,
          path: callbackPath,
          state,
        })
        return yield* exchange(callback.code, pkce.verifier, redirectUri)
      })

const refresh: Provider["refresh"] = (account) =>
  Effect.gen(function* () {
    const token = Option.flatMap(account.tokens, (tokens) => Option.fromUndefinedOr(tokens.refresh))
    if (Option.isNone(token)) return yield* new RefreshRevoked({ reason: "no refresh token stored" })
    // The same shape as Codex itself sends: JSON, and no scope.
    const reply = yield* send(
      HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: Redacted.value(token.value),
        }),
      ),
    ).pipe(Effect.mapError((error) => new RefreshTransient({ message: `token refresh failed: ${callText(error)}` })))
    if (!reply.ok) return yield* refreshRefused(reply.status, reply.text)
    return yield* Option.match(Option.flatMap(reply.json, decodeTokenAnswer), {
      onNone: () =>
        Effect.fail(new RefreshTransient({ message: "token refresh answered something other than tokens" })),
      onSome: (answer) => Effect.succeed(grantOf(answer)),
    })
  })

const identify: Provider["identify"] = (account) =>
  Effect.succeed(new Account({ ...account, identity: withClaims(account.identity, tokenTexts(account)) }))

// ---------------------------------------------------------------------------
// The proxy's side

/** `0.159.3` from a user agent like `codex_exec/0.159.3 (Linux; x86_64)`, when it is Codex's. */
export const clientVersion = (headers: Headers): string | undefined => {
  const agent = headers.get("user-agent")
  if (agent === null) return undefined
  const slash = agent.indexOf("/")
  if (slash < 0 || !agent.slice(0, slash).startsWith("codex")) return undefined
  const version = /^[\d.]*/.exec(agent.slice(slash + 1))?.[0] ?? ""
  return version.split(".").length === 3 ? version : undefined
}

const upstreamHeaders: Provider["headers"] = ({ client, account, moved, codex }) => {
  const out = forwardable(client)
  out.set("authorization", `Bearer ${account.secret}`)
  if (account.identity.accountId !== undefined) out.set("chatgpt-account-id", account.identity.accountId)
  // The per-turn routing token belongs to the backend session of the account the session left.
  if (moved) out.delete("x-codex-turn-state")
  // Uncompressed streams can be read for usage and refusals inside them.
  out.set("accept-encoding", "identity")
  // The backend gates some models on the client's version, which custom providers do not send.
  const version = clientVersion(client) ?? codex.version
  if (!out.has("version") && version !== undefined) out.set("version", version)
  return out
}

/** A Responses body without state bound to another account; none when it carries none. */
export const withoutAccountState = (request: Record<string, unknown>): Option.Option<Record<string, unknown>> => {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if (key === "previous_response_id") {
      changed = true
      continue
    }
    out[key] = value
  }
  const input = out["input"]
  if (Array.isArray(input)) {
    out["input"] = input.map((item: unknown) => {
      if (!isRecord(item) || item["type"] !== "reasoning" || !("encrypted_content" in item)) return item
      changed = true
      const { encrypted_content: _dropped, ...kept } = item
      return kept
    })
  }
  return changed ? Option.some(out) : Option.none()
}

const utf8 = new TextEncoder()

/** The body without encrypted reasoning or a previous response id; none when there is neither or it is not JSON. */
export const rebind = (body: Uint8Array): Option.Option<Uint8Array> =>
  Option.flatMap(Option.filter(parseJsonBytes(body), isRecord), (request) =>
    Option.map(withoutAccountState(request), (out) => utf8.encode(JSON.stringify(out))),
  )

/** Whether a 400 says the request carried state another account minted. */
export const rejectsAccountState = (body: Uint8Array): boolean => {
  const text = bodyText(body).toLowerCase()
  return (
    text.includes("encrypted content") ||
    text.includes("invalid_encrypted_content") ||
    text.includes("not issued to this caller") ||
    (text.includes("item with id") && text.includes("not found"))
  )
}

/** Whether a 5xx is really a spent quota; the backend sometimes says so with a 502. */
export const reportsUsageLimit = (body: Uint8Array): boolean => {
  const text = bodyText(body).toLowerCase()
  return text.includes("usage_limit_reached") || text.includes("usage limit has been reached")
}

const spanOfMinutes = (minutes: Option.Option<number>) =>
  Option.match(minutes, { onNone: () => "7d" as const, onSome: (value) => spanFor(Math.trunc(value * 60)) })

/** `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`. */
export const limitsFromHeaders = (headers: Headers, now: DateTime.Utc): Option.Option<Limits> =>
  observed(
    ["primary", "secondary"].flatMap((slot) =>
      Option.match(headerNumber(headers, `x-codex-${slot}-used-percent`), {
        onNone: () => [],
        onSome: (used) => [
          Window.of(
            spanOfMinutes(headerNumber(headers, `x-codex-${slot}-window-minutes`)),
            used,
            Option.getOrUndefined(headerTime(headers, `x-codex-${slot}-reset-at`)),
          ),
        ],
      }),
    ),
    now,
  )

const slots = ["primary", "secondary"] as const
const slotFields = ["used-percent", "window-minutes", "reset-at", "reset-after-seconds", "over-secondary-limit-percent"]

/** The headers with the pool's windows, shortest first, in place of the account's, so Codex shows one account. */
export const showPoolInHeaders = (headers: Headers, pool: ReadonlyArray<PoolWindow>): Headers => {
  const out = new Headers(headers)
  for (const [index, slot] of slots.entries()) {
    for (const name of slotFields) out.delete(`x-codex-${slot}-${name}`)
    const window = pool[index]
    if (window === undefined) continue
    out.set(`x-codex-${slot}-used-percent`, window.used.toFixed(1))
    out.set(`x-codex-${slot}-window-minutes`, String(spanMinutes(window.span)))
    if (window.resetsAt !== undefined) out.set(`x-codex-${slot}-reset-at`, String(unixSeconds(window.resetsAt)))
  }
  return out
}

/** A `codex.rate_limits` socket event with the pool's windows in place of the account's. */
export const showPoolInEvent = (
  event: Record<string, unknown>,
  pool: ReadonlyArray<PoolWindow>,
): Record<string, unknown> => {
  const limits = event["rate_limits"]
  if (!isRecord(limits)) return event
  const out: Record<string, unknown> = { ...limits }
  for (const [index, slot] of slots.entries()) {
    const window = pool[index]
    out[slot] =
      window === undefined
        ? null
        : {
            used_percent: Math.round(window.used * 10) / 10,
            window_minutes: spanMinutes(window.span),
            reset_at: window.resetsAt === undefined ? null : unixSeconds(window.resetsAt),
          }
  }
  const full = pool.some((window) => window.used >= 100)
  out["limit_reached"] = full
  out["allowed"] = !full
  return { ...event, rate_limits: out }
}

const EventWindow = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: optionalField(Schema.Finite),
  reset_at: optionalField(Time),
})

/** A `codex.rate_limits` socket event. */
const RateLimitsEvent = Schema.Struct({
  rate_limits: Schema.Struct({ primary: optionalField(EventWindow), secondary: optionalField(EventWindow) }),
})
const decodeRateLimitsEvent = Schema.decodeUnknownOption(RateLimitsEvent)

/** The windows a `codex.rate_limits` event reports, which ChatGPT sends on sockets in place of headers. */
export const limitsFromEvent = (event: unknown, now: DateTime.Utc): Option.Option<Limits> =>
  Option.flatMap(decodeRateLimitsEvent(event), ({ rate_limits }) =>
    observed(
      slots.flatMap((slot) => {
        const window = rate_limits[slot]
        if (window === undefined) return []
        const span = spanOfMinutes(Option.fromUndefinedOr(window.window_minutes))
        return [Window.of(span, window.used_percent, Option.getOrUndefined(parseTime(window.reset_at)))]
      }),
      now,
    ),
  )

const spentKinds = new Set(["usage_limit_reached", "usage_limit_exceeded", "usage_not_included", "insufficient_quota"])

/** What an error body or a failure event says about a refusal. */
const ErrorDetail = Schema.Struct({
  type: optionalField(Schema.String),
  code: optionalField(Schema.String),
  resets_in_seconds: optionalField(Schema.Finite),
  resets_at: optionalField(Time),
})
type ErrorDetail = typeof ErrorDetail.Type
const decodeErrorDetail = Schema.decodeUnknownOption(ErrorDetail)
const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: ErrorDetail }))

/** An error body's detail: `{"error": {…}}`, or the fields at the top. */
const errorDetailOf = (body: Uint8Array): ErrorDetail | undefined => {
  const json = parseJsonBytes(body)
  return Option.getOrUndefined(
    Option.orElse(
      Option.map(Option.flatMap(json, decodeErrorBody), (found) => found.error),
      () => Option.flatMap(json, decodeErrorDetail),
    ),
  )
}

/**
 * A refusal as its error detail tells it. A spent quota names when it comes
 * back (`resets_at`, or `resets_in_seconds`); else the headers' full windows
 * say, else `retry-after`. Never scoped to a model.
 */
const detailVerdict = (
  status: number,
  headers: Headers,
  detail: ErrorDetail | undefined,
  now: DateTime.Utc,
): Verdict => {
  const kind = detail?.type ?? detail?.code ?? ""
  if (status !== 402 && !spentKinds.has(kind)) return throttled(retryAfter(headers, now))
  const inSecondsField = detail?.resets_in_seconds
  const fromBody = Option.orElse(parseTime(detail?.resets_at), () =>
    inSecondsField === undefined ? Option.none() : Option.some(inSeconds(now, Math.trunc(inSecondsField))),
  ).pipe(Option.filter((at) => DateTime.isGreaterThan(at, now)))
  const until = Option.orElse(fromBody, () =>
    Option.orElse(
      Option.flatMap(limitsFromHeaders(headers, now), (limits) => exhaustedUntil(limits, now)),
      () => retryAfter(headers, now),
    ),
  )
  return exhausted(until)
}

/** A 429 or 402, read from its body and headers. */
export const refusalOf = (status: number, headers: Headers, body: Uint8Array, now: DateTime.Utc): Verdict =>
  detailVerdict(status, headers, errorDetailOf(body), now)

const verdict = ({ status, headers, body, now }: Refusal): Verdict => {
  if (status === 429 || status === 402) return refusalOf(status, headers, body, now)
  if (status === 400 && rejectsAccountState(body)) return Verdict.StaleState()
  if (status >= 500 && reportsUsageLimit(body)) return exhausted(Option.none())
  return verdictOfStatus(status)
}

const throttleKinds = new Set(["server_is_overloaded", "slow_down", "rate_limit_exceeded"])

/** A failure event on Codex's socket: the error inside its response, or at the top. */
const FailureEvent = Schema.Struct({
  response: optionalField(Schema.Struct({ error: ErrorDetail })),
  error: optionalField(ErrorDetail),
})
const decodeFailureEvent = Schema.decodeUnknownOption(FailureEvent)

/** A failure event on Codex's socket that is the account's rather than the request's. */
export const eventVerdict = (event: unknown, now: DateTime.Utc): Option.Option<Verdict> =>
  Option.flatMap(decodeFailureEvent(event), (found) => {
    const error = found.response?.error ?? found.error
    if (error === undefined) return Option.none()
    const code = error.code ?? error.type ?? ""
    if (spentKinds.has(code)) return Option.some(detailVerdict(429, new Headers(), error, now))
    return throttleKinds.has(code) ? Option.some(throttled(Option.none())) : Option.none()
  })

/** A turn on a socket that moved accounts, without what the old account's backend session minted. */
export const rebindTurn = (request: Record<string, unknown>): Option.Option<Record<string, unknown>> => {
  const metadata = request["client_metadata"]
  const hadTurnState = isRecord(metadata) && "x-codex-turn-state" in metadata
  const base: Record<string, unknown> = hadTurnState
    ? {
        ...request,
        client_metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "x-codex-turn-state")),
      }
    : request
  const stripped = withoutAccountState(base)
  return Option.isSome(stripped) ? stripped : hadTurnState ? Option.some(base) : Option.none()
}

const socket: SocketHooks = { limitsFromEvent, showPoolInEvent, rebindTurn, eventVerdict }

const withWorkspace = (request: HttpClientRequest.HttpClientRequest, account: Account) => {
  const signed = HttpClientRequest.bearerToken(request, account.secret)
  const workspace = account.identity.accountId
  return workspace === undefined ? signed : HttpClientRequest.setHeader(signed, "chatgpt-account-id", workspace)
}

const UsageWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: optionalField(Schema.Finite),
  reset_after_seconds: optionalField(Schema.Finite),
  reset_at: optionalField(Time),
})
type UsageWindow = typeof UsageWindow.Type

/** `GET /wham/usage`. */
const Usage = Schema.Struct({
  rate_limit: optionalField(
    Schema.Struct({
      primary_window: optionalField(UsageWindow),
      secondary_window: optionalField(UsageWindow),
      tertiary_window: optionalField(UsageWindow),
    }),
  ),
  rate_limit_reset_credits: optionalField(
    Schema.Struct({ available_count: optionalField(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) }),
  ),
  plan_type: optionalField(Schema.String),
})
const decodeUsage = Schema.decodeUnknownOption(Usage)

const usageWindow = (window: UsageWindow, now: DateTime.Utc): Window => {
  const length = window.limit_window_seconds
  const after = window.reset_after_seconds
  const resetsAt = Option.orElse(parseTime(window.reset_at), () =>
    after === undefined ? Option.none() : Option.some(inSeconds(now, Math.trunc(after))),
  )
  const span = length === undefined ? "7d" : spanFor(Math.trunc(length))
  return Window.of(span, window.used_percent, Option.getOrUndefined(resetsAt))
}

/** The usage endpoint's answer: up to three windows, the plan, and the banked reset credits. */
export const limitsFromUsage = (body: unknown, now: DateTime.Utc): Limits =>
  Option.match(decodeUsage(body), {
    onNone: () => new Limits({ windows: [], observedAt: now }),
    onSome: (usage) => {
      const limit = usage.rate_limit
      const windows = [limit?.primary_window, limit?.secondary_window, limit?.tertiary_window].flatMap((window) =>
        window === undefined ? [] : [usageWindow(window, now)],
      )
      const credits = usage.rate_limit_reset_credits?.available_count
      return new Limits({
        windows,
        observedAt: now,
        ...(credits === undefined ? {} : { resetCredits: credits }),
        ...(usage.plan_type === undefined ? {} : { plan: usage.plan_type }),
      })
    },
  })

const usage = (account: Account): Effect.Effect<Limits, ProviderUnauthorized | ProviderFailed, Upstream> =>
  Effect.gen(function* () {
    const reply = yield* send(withWorkspace(HttpClientRequest.get(`${backend}/wham/usage`), account)).pipe(
      Effect.mapError(unreachable),
    )
    const body = yield* Effect.fromResult(usageAnswer(reply))
    return limitsFromUsage(body, yield* DateTime.now)
  })

/** `GET /codex/models`: the models the account's plan offers Codex. */
const decodeCatalog = Schema.decodeUnknownOption(
  Schema.Struct({
    models: optionalField(listOf(Schema.Struct({ slug: Schema.String, visibility: optionalField(Schema.String) }))),
  }),
)

/** The models the account's plan offers Codex, except hidden ones. */
export const catalogModels = (body: unknown): ReadonlyArray<string> =>
  Option.match(decodeCatalog(body), {
    onNone: () => [],
    onSome: ({ models }) => (models ?? []).flatMap((model) => (model.visibility === "hide" ? [] : [model.slug])),
  })

const catalog: Provider["catalog"] = (account, context) =>
  Effect.gen(function* () {
    const url = `${backend}/codex/models?${new URLSearchParams([["client_version", context.codexVersion ?? ""]]).toString()}`
    const reply = yield* send(withWorkspace(HttpClientRequest.get(url), account)).pipe(Effect.mapError(unreachable))
    if (!reply.ok)
      return yield* new ProviderFailed({
        message: `the model list returned ${statusLine(reply.status)}`,
        status: reply.status,
      })
    if (Option.isNone(reply.json)) return yield* new ProviderFailed({ message: "unexpected model list" })
    return catalogModels(reply.json.value)
  })

// ---------------------------------------------------------------------------
// Reset credits

/** The kind of credit that resets Codex's windows. */
const codexResets = "codex_rate_limits"

const Credit = Schema.Struct({
  id: Schema.String,
  status: optionalField(Schema.String),
  reset_type: optionalField(Schema.String),
  title: optionalField(Schema.String),
  granted_at: optionalField(Schema.String),
  expires_at: optionalField(Schema.String),
})

/** `GET /wham/rate-limit-reset-credits`. */
const decodeCredits = Schema.decodeUnknownOption(
  Schema.Struct({ credits: Schema.optional(Schema.NullOr(listOf(Credit))) }),
)

/** Unspent credits that reset Codex's windows, soonest to expire first. */
export const availableCredits = (body: unknown): Option.Option<ReadonlyArray<LimitReset>> =>
  Option.map(decodeCredits(body), ({ credits }) =>
    (credits ?? [])
      .flatMap((credit) => {
        const status = credit.status ?? ""
        if (status !== "" && status.toLowerCase() !== "available") return []
        if (credit.reset_type !== undefined && credit.reset_type !== codexResets) return []
        const grantedAt = parseTime(credit.granted_at)
        const expiresAt = parseTime(credit.expires_at)
        return [
          new LimitReset({
            id: credit.id,
            ...(credit.title === undefined ? {} : { title: credit.title }),
            ...(Option.isSome(grantedAt) ? { grantedAt: grantedAt.value } : {}),
            ...(Option.isSome(expiresAt) ? { expiresAt: expiresAt.value } : {}),
          }),
        ]
      })
      .toSorted((a, b) => expiryOf(a) - expiryOf(b)),
  )

const listCredits = (account: Account) =>
  Effect.gen(function* () {
    const reply = yield* send(
      withWorkspace(HttpClientRequest.get(`${backend}/wham/rate-limit-reset-credits`), account),
    ).pipe(Effect.mapError(unreachable))
    if (!reply.ok) {
      return yield* new ProviderFailed({
        message: `listing reset credits failed (${statusLine(reply.status)})`,
        status: reply.status,
      })
    }
    return yield* Option.match(Option.flatMap(reply.json, availableCredits), {
      onNone: () => Effect.fail(new ProviderFailed({ message: "unexpected reset credit list" })),
      onSome: Effect.succeed,
    })
  })

/** What redeeming came to, in Codex's words and in slopmax's. */
const outcomes = {
  reset: "reset",
  nothing_to_reset: "nothing-to-reset",
  no_credit: "no-credit",
  already_redeemed: "already-redeemed",
  declined: "declined",
} as const satisfies Record<string, RedeemOutcome>

/** The answer to redeeming: one of the codes above; any other is unexpected. */
const decodeRedeemReply = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed", "declined"]) }),
)

const redeemCredit = (account: Account, id: string | undefined) =>
  Effect.gen(function* () {
    // The request id is reused on a retry, so a lost answer cannot spend two credits.
    const requestId = yield* withCrypto(newUuid)
    const request = withWorkspace(
      HttpClientRequest.post(`${backend}/wham/rate-limit-reset-credits/consume`),
      account,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        redeem_request_id: requestId,
        ...(id === undefined ? {} : { credit_id: id }),
      }),
    )
    const reply = yield* send(request).pipe(Effect.retry({ times: 1 }), Effect.mapError(unreachable))
    if (!reply.ok) {
      return yield* new ProviderFailed({
        message: `redeeming a reset credit failed (${statusLine(reply.status)})`,
        status: reply.status,
      })
    }
    const answer = Option.flatMap(reply.json, decodeRedeemReply)
    if (Option.isNone(answer)) return yield* new ProviderFailed({ message: "unexpected redeem response" })
    return outcomes[answer.value.code]
  })

export const codex: Provider = defineProvider({
  id: "codex",
  identity: (account) => account.identity.accountId,
  login,
  refresh,
  identify,
  usage: Option.some(usage),
  catalog,
  headers: upstreamHeaders,
  verdict,
  limitsFrom: limitsFromHeaders,
  showPool: showPoolInHeaders,
  rebind,
  // The ChatGPT backend sets output limits itself and refuses them.
  shape: (body) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "max_output_tokens")),
  socket: Option.some(socket),
  resets: Option.some({
    counted: true,
    needsAgent: false,
    list: (account) => listCredits(account),
    redeem: (account, id) => redeemCredit(account, id),
  }),
})
