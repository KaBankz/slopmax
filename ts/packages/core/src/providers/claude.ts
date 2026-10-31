// Claude Pro and Max subscriptions, as Claude Code uses them.
//
// Claude Code's requests are forwarded as it sent them. Only the credential
// changes: the account's OAuth token replaces slopmax's key, with the beta
// flag OAuth tokens need. Usage comes from the unified rate-limit headers
// on every answer and from the OAuth usage endpoint; agents see the pool's
// windows in those headers, following Claude Code's contract for gateways.
//
// Claude also banks limit resets ("cedar_ember" in its API). It lists and
// spends them only for Claude Code, so those two calls carry Claude Code's
// user agent as slopmax last saw it, and nothing else slopmax sends does.
import { LimitReset, Limits, newUuid, observed, type PoolWindow, type RedeemOutcome, Window } from "@slopmax/domain"
import { DateTime, Effect, Option, Redacted, Result, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Account, Credential, Identity } from "../account.ts"
import type { Upstream } from "../upstream.ts"
import { browserLogin, makePkce, newState } from "./oauth.ts"
import {
  bodyText,
  callText,
  defineProvider,
  exhausted,
  expiryOf,
  forwardable,
  type Grant,
  headerNumber,
  headerText,
  headerTime,
  inSeconds,
  latestAfter,
  listOf,
  LoginFailed,
  NeedsAgent,
  newAccount,
  optionalField,
  parseJsonBytes,
  parseTime,
  present,
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

/** Anthropic's API: Messages, the OAuth profile, usage, and limit resets. */
export const api = "https://api.anthropic.com"
export const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const authorizeEndpoint = "https://claude.ai/oauth/authorize"
export const tokenEndpoint = "https://platform.claude.com/v1/oauth/token"
export const profileEndpoint = `${api}/api/oauth/profile`
export const scopes = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
/** The loopback redirect registered for Claude Code's client. */
export const callbackPort = 54545
export const callbackPath = "/callback"
export const redirectUri = `http://localhost:${callbackPort}${callbackPath}`
/** The beta flag that lets OAuth tokens call the Messages API. */
export const oauthBeta = "oauth-2025-04-20"

// ---------------------------------------------------------------------------
// Signing in

/** Where the person authorizes, with the parameters in the order Claude Code sends them. */
export const authorizeUrl = (challenge: string, state: string): string =>
  `${authorizeEndpoint}?${new URLSearchParams([
    ["code", "true"],
    ["client_id", clientId],
    ["response_type", "code"],
    ["redirect_uri", redirectUri],
    ["scope", scopes],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
  ]).toString()}`

const optionalText = Schema.optional(Schema.NullOr(Schema.String))

const TokenAnswer = Schema.Struct({
  access_token: Schema.String,
  refresh_token: optionalText,
  expires_in: Schema.optional(Schema.NullOr(Schema.Finite)),
  account: Schema.optional(Schema.NullOr(Schema.Struct({ uuid: optionalText, email_address: optionalText }))),
  organization: Schema.optional(Schema.NullOr(Schema.Struct({ uuid: optionalText, name: optionalText }))),
})
type TokenAnswer = typeof TokenAnswer.Type
const decodeTokenAnswer = Schema.decodeUnknownOption(TokenAnswer)

const grantOf = (answer: TokenAnswer, now: DateTime.Utc): Grant => ({
  access: answer.access_token,
  refresh: answer.refresh_token ?? undefined,
  expiresAt: answer.expires_in == null ? undefined : inSeconds(now, answer.expires_in),
})

/** `GET /api/oauth/profile`: who the token belongs to and which plan it has. */
export const Profile = Schema.Struct({
  account: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        uuid: optionalText,
        email: optionalText,
        has_claude_max: Schema.optional(Schema.NullOr(Schema.Boolean)),
        has_claude_pro: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  organization: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        uuid: optionalText,
        name: optionalText,
        /** Such as `claude_max`, `claude_pro`, `claude_team`. */
        organization_type: optionalText,
        /** Such as `default_claude_max_20x`. */
        rate_limit_tier: optionalText,
      }),
    ),
  ),
})
export type Profile = typeof Profile.Type
const decodeProfile = Schema.decodeUnknownOption(Profile)

/** A short plan name: `max 20x`, `pro`, `team`. The organization's type comes first; a multiplier qualifies Max only. */
export const planOf = (profile: Profile): string | undefined => {
  const tier = profile.organization?.rate_limit_tier ?? ""
  const multiplier = tier.split("_").at(-1)
  const kind = profile.organization?.organization_type
  const base =
    kind != null
      ? kind.replace(/^(claude_)+/, "")
      : profile.account?.has_claude_max === true
        ? "max"
        : profile.account?.has_claude_pro === true
          ? "pro"
          : undefined
  if (base === undefined) return undefined
  return base === "max" && multiplier !== undefined && multiplier.endsWith("x") ? `max ${multiplier}` : base
}

/** The identity with what the profile says, never erasing what is known with a blank. */
export const withProfile = (identity: Identity, profile: Profile): Identity => {
  const plan = planOf(profile)
  return new Identity({
    ...identity,
    ...(present(profile.account?.uuid) ? { accountId: profile.account.uuid } : {}),
    ...(present(profile.account?.email) ? { email: profile.account.email } : {}),
    ...(present(profile.organization?.uuid) ? { orgId: profile.organization.uuid } : {}),
    ...(present(profile.organization?.name) ? { orgName: profile.organization.name } : {}),
    ...(present(plan) ? { plan } : {}),
  })
}

/** Reads the profile with an access token. */
export const profile = (token: string): Effect.Effect<Profile, ProviderFailed, Upstream> =>
  send(
    HttpClientRequest.get(profileEndpoint).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("anthropic-beta", oauthBeta),
    ),
  ).pipe(
    Effect.mapError(unreachable),
    Effect.flatMap((reply) => {
      if (!reply.ok)
        return Effect.fail(
          new ProviderFailed({ message: `profile lookup returned ${statusLine(reply.status)}`, status: reply.status }),
        )
      return Option.match(Option.flatMap(reply.json, decodeProfile), {
        onNone: () => Effect.fail(new ProviderFailed({ message: "unexpected profile" })),
        onSome: Effect.succeed,
      })
    }),
  )

/** Exchanges an authorization code for tokens and builds the account, identified by its profile. */
export const exchange = (
  code: string,
  state: string,
  verifier: string,
): Effect.Effect<Account, LoginFailed, Upstream> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const reply = yield* send(
      HttpClientRequest.post(tokenEndpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          state,
        }),
      ),
    ).pipe(Effect.mapError((error) => new LoginFailed({ message: callText(error) })))
    if (!reply.ok)
      return yield* new LoginFailed({ message: `token exchange failed (${statusLine(reply.status)}): ${reply.text}` })
    const answer = Option.flatMap(reply.json, decodeTokenAnswer)
    if (Option.isNone(answer)) return yield* new LoginFailed({ message: "unexpected token response" })
    const tokens = tokensOf(grantOf(answer.value, now), now)
    const fromAnswer = new Identity({
      ...(present(answer.value.account?.uuid) ? { accountId: answer.value.account.uuid } : {}),
      ...(present(answer.value.account?.email_address) ? { email: answer.value.account.email_address } : {}),
      ...(present(answer.value.organization?.uuid) ? { orgId: answer.value.organization.uuid } : {}),
      ...(present(answer.value.organization?.name) ? { orgName: answer.value.organization.name } : {}),
    })
    const identity = yield* profile(answer.value.access_token).pipe(
      Effect.map((found) => withProfile(fromAnswer, found)),
      Effect.catch((error) => Effect.as(Effect.logWarning(`profile lookup failed: ${error.message}`), fromAnswer)),
    )
    return yield* newAccount({ provider: "claude", credential: Credential.cases.OAuth.make({ tokens }), identity, now })
  })

const login: Provider["login"] = () =>
  Effect.gen(function* () {
    const pkce = yield* withCrypto(makePkce)
    const state = yield* withCrypto(newState)
    const callback = yield* browserLogin({
      title: "Claude",
      url: authorizeUrl(pkce.challenge, state),
      port: callbackPort,
      path: callbackPath,
      state,
    })
    return yield* exchange(callback.code, callback.state ?? state, pkce.verifier)
  })

const refresh: Provider["refresh"] = (account) =>
  Effect.gen(function* () {
    const token = Option.flatMap(account.tokens, (tokens) => Option.fromUndefinedOr(tokens.refresh))
    if (Option.isNone(token)) return yield* new RefreshRevoked({ reason: "no refresh token stored" })
    const now = yield* DateTime.now
    const reply = yield* send(
      HttpClientRequest.post(tokenEndpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          grant_type: "refresh_token",
          refresh_token: Redacted.value(token.value),
          client_id: clientId,
          scope: scopes,
        }),
      ),
    ).pipe(Effect.mapError((error) => new RefreshTransient({ message: `token refresh failed: ${callText(error)}` })))
    if (!reply.ok) return yield* refreshRefused(reply.status, reply.text)
    return yield* Option.match(Option.flatMap(reply.json, decodeTokenAnswer), {
      onNone: () =>
        Effect.fail(new RefreshTransient({ message: "token refresh answered something other than tokens" })),
      onSome: (answer) => Effect.succeed(grantOf(answer, now)),
    })
  })

const identify: Provider["identify"] = (account) =>
  profile(account.secret).pipe(
    Effect.map((found) => new Account({ ...account, identity: withProfile(account.identity, found) })),
    Effect.orElseSucceed(() => account),
  )

// ---------------------------------------------------------------------------
// The proxy's side

/** The agent's beta list with the OAuth flag added once. */
export const withOauthBeta = (existing: string | null): string => {
  const betas = (existing ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta !== "")
  return (betas.includes(oauthBeta) ? betas : [...betas, oauthBeta]).join(",")
}

/** Claude Code's user agent, such as `claude-cli/2.1.291 (external, cli)`, when it sent the request. */
export const claudeCodeAgent = (headers: Headers): string | undefined => {
  const agent = headers.get("user-agent")
  return agent !== null && agent.startsWith("claude-cli/") && agent.length <= 200 ? agent : undefined
}

const unified = "anthropic-ratelimit-unified-"

/** `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`: utilization is a fraction, resets are unix seconds. */
export const limitsFromHeaders = (headers: Headers, now: DateTime.Utc): Option.Option<Limits> =>
  observed(
    (["5h", "7d"] as const).flatMap((span) =>
      Option.match(headerNumber(headers, `${unified}${span}-utilization`), {
        onNone: () => [],
        onSome: (fraction) => [
          Window.of(span, fraction * 100, Option.getOrUndefined(headerTime(headers, `${unified}${span}-reset`))),
        ],
      }),
    ),
    now,
  )

/**
 * The answer's headers with the pool's standing in place of the account's:
 * the account's unified headers are removed and the pool's 5-hour and weekly
 * windows reported, warning past 75% and again past 95%.
 */
export const showPoolInHeaders = (headers: Headers, pool: ReadonlyArray<PoolWindow>): Headers => {
  const out = new Headers()
  for (const [name, value] of headers) if (!name.startsWith(unified)) out.append(name, value)
  let fullest: { readonly window: PoolWindow; readonly claim: string } | undefined
  for (const window of pool) {
    const slot = window.span === "5h" ? "five_hour" : window.span === "7d" ? "seven_day" : undefined
    if (slot === undefined) continue
    // Below 1 while requests are still served.
    const fraction = Math.min(0.99, Math.max(0, window.used / 100))
    const passed = [0.95, 0.75].find((threshold) => fraction >= threshold)
    out.set(`${unified}${window.span}-utilization`, fraction.toFixed(2))
    out.set(`${unified}${window.span}-status`, passed === undefined ? "allowed" : "allowed_warning")
    if (window.resetsAt !== undefined) out.set(`${unified}${window.span}-reset`, String(unixSeconds(window.resetsAt)))
    if (passed !== undefined) out.set(`${unified}${window.span}-surpassed-threshold`, String(passed))
    if (fullest === undefined || window.used > fullest.window.used) fullest = { window, claim: slot }
  }
  if (fullest === undefined) return out
  const warning = fullest.window.used >= 75
  out.set(`${unified}status`, warning ? "allowed_warning" : "allowed")
  if (warning) out.set(`${unified}representative-claim`, fullest.claim)
  if (fullest.window.resetsAt !== undefined) out.set(`${unified}reset`, String(unixSeconds(fullest.window.resetsAt)))
  return out
}

const UsageWindow = Schema.Struct({ utilization: Schema.Finite, resets_at: optionalField(Time) })
type UsageWindow = typeof UsageWindow.Type

/** A weekly window that covers one model, such as Opus. */
const ScopedLimit = Schema.Struct({
  kind: Schema.Literal("weekly_scoped"),
  percent: Schema.Finite,
  resets_at: optionalField(Time),
  scope: Schema.Struct({ model: Schema.Struct({ display_name: Schema.String }) }),
})

/** `GET /api/oauth/usage`. */
const Usage = Schema.Struct({
  five_hour: optionalField(UsageWindow),
  seven_day: optionalField(UsageWindow),
  // Older answers carry per-model weekly windows as top-level keys.
  seven_day_opus: optionalField(UsageWindow),
  seven_day_sonnet: optionalField(UsageWindow),
  limits: optionalField(listOf(ScopedLimit)),
})
const decodeUsage = Schema.decodeUnknownOption(Usage)

const windowsOf = (window: UsageWindow | undefined, span: "5h" | "7d", model?: string): ReadonlyArray<Window> =>
  window === undefined
    ? []
    : [Window.of(span, window.utilization, Option.getOrUndefined(parseTime(window.resets_at)), model)]

/** The usage endpoint's answer: the 5-hour and weekly windows, and weekly windows scoped to one model. */
export const limitsFromUsage = (body: unknown, now: DateTime.Utc): Limits => {
  const windows: Array<Window> = []
  for (const usage of Option.toArray(decodeUsage(body))) {
    windows.push(...windowsOf(usage.five_hour, "5h"), ...windowsOf(usage.seven_day, "7d"))
    for (const limit of usage.limits ?? []) {
      const resetsAt = Option.getOrUndefined(parseTime(limit.resets_at))
      windows.push(Window.of("7d", limit.percent, resetsAt, limit.scope.model.display_name))
    }
    for (const [window, model] of [
      [usage.seven_day_opus, "Opus"],
      [usage.seven_day_sonnet, "Sonnet"],
    ] as const) {
      if (!windows.some((found) => found.model === model)) windows.push(...windowsOf(window, "7d", model))
    }
  }
  return new Limits({ windows, observedAt: now })
}

/** An API error body: `{"error": {"message": …}}`. */
const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))

const status = (headers: Headers, key: string) => headerText(headers, `${unified}${key}status`)

/**
 * Whether a 429 refuses fast mode for want of usage credits rather than for
 * a spent window. That is the request's problem: every account would answer
 * the same, and all of them stay healthy for ordinary requests.
 */
export const fastModeRefused = (headers: Headers, body: Uint8Array): boolean => {
  if (status(headers, "5h-") === "rejected" || status(headers, "7d-") === "rejected") return false
  const message = Option.match(Option.flatMap(parseJsonBytes(body), decodeErrorBody), {
    onNone: () => bodyText(body),
    onSome: (answer) => answer.error.message,
  }).toLowerCase()
  return (
    message.includes("fast request rejected") ||
    (message.includes("fast") && (message.includes("usage credits") || message.includes("credits are required")))
  )
}

/**
 * A 429 read from the unified headers. A rejected 5-hour or weekly window
 * blocks the whole account until the latest of the rejected resets; a
 * rejection that involves only the overage window or extra usage caps the
 * request's model, not the account; anything else is throttling.
 */
export const refusalOf = (refusal: Refusal): Verdict => {
  const { headers, now } = refusal
  const reset = (key: string) => headerTime(headers, `${unified}${key}reset`)
  const shared = ["5h-", "7d-"].filter((key) => status(headers, key) === "rejected")
  if (shared.length > 0) {
    return exhausted(latestAfter(now, [...shared.map(reset), retryAfter(headers, now), reset("")]))
  }
  if (status(headers, "") === "rejected") {
    const overageOnly =
      status(headers, "7d_oi-") === "rejected" ||
      status(headers, "overage-") === "rejected" ||
      (headerText(headers, `${unified}representative-claim`) ?? "").includes("overage")
    return exhausted(
      latestAfter(now, [reset("7d_oi-"), reset(""), retryAfter(headers, now)]),
      overageOnly ? refusal.model : undefined,
    )
  }
  return throttled(retryAfter(headers, now))
}

const verdict = (refusal: Refusal): Verdict => {
  if (refusal.status !== 429) return verdictOfStatus(refusal.status)
  return fastModeRefused(refusal.headers, refusal.body) ? Verdict.Final() : refusalOf(refusal)
}

const usage = (account: Account): Effect.Effect<Limits, ProviderUnauthorized | ProviderFailed, Upstream> =>
  Effect.gen(function* () {
    const reply = yield* send(
      HttpClientRequest.get(`${api}/api/oauth/usage`).pipe(
        HttpClientRequest.bearerToken(account.secret),
        HttpClientRequest.setHeader("anthropic-beta", oauthBeta),
      ),
    ).pipe(Effect.mapError(unreachable))
    const body = yield* Effect.fromResult(usageAnswer(reply))
    return limitsFromUsage(body, yield* DateTime.now)
  })

// ---------------------------------------------------------------------------
// Limit resets

/** The program Claude's API files the resets under. */
const program = "cedar_ember"
/** More resets than one grant could sensibly hold. */
const mostPerGrant = 20

const asClaudeCode = (request: HttpClientRequest.HttpClientRequest, account: Account, agent: string) =>
  request.pipe(
    HttpClientRequest.bearerToken(account.secret),
    HttpClientRequest.setHeader("anthropic-beta", oauthBeta),
    HttpClientRequest.setHeader("user-agent", agent),
  )

/** A label as a title: whitespace collapsed, control characters dropped, at most 120 characters. */
const titleOf = (label: string | undefined): string | undefined => {
  if (label === undefined) return undefined
  const text = label
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ")
    .replace(/\p{Cc}/gu, "")
    .slice(0, 120)
  return text === "" ? undefined : text
}

/** One grant of resets; the id goes into a request, so only plain ids are taken. */
const ResetGrant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,40}$/)),
  resets_left: Schema.Int.check(Schema.isGreaterThan(0)),
  starts_at: optionalField(Time),
  ends_at: optionalField(Time),
  label: optionalField(Schema.String),
})

/** The usage answer's account of the resets, when asked for them. */
const ResetListing = Schema.Struct({
  next_grant_id: optionalField(Schema.String),
  grants: optionalField(listOf(ResetGrant)),
  eligible: optionalField(Schema.Boolean),
  ineligible_reason: optionalField(Schema.String),
})
type ResetListing = typeof ResetListing.Type
const decodeResetsReply = Schema.decodeUnknownOption(Schema.Struct({ [program]: optionalField(Schema.Unknown) }))
const decodeResetListing = Schema.decodeUnknownOption(ResetListing)

/** The resets part of a usage answer; none when the account has none. */
const resetListing = (body: unknown): Result.Result<Option.Option<ResetListing>, ProviderFailed> => {
  const reply = decodeResetsReply(body)
  if (Option.isNone(reply)) return Result.fail(new ProviderFailed({ message: "unexpected usage reply" }))
  const listing = reply.value[program]
  if (listing == null) return Result.succeed(Option.none())
  return Option.match(decodeResetListing(listing), {
    onNone: () => Result.fail(new ProviderFailed({ message: "unexpected limit reset status" })),
    onSome: (found) => Result.succeed(Option.some(found)),
  })
}

/** The resets left in a listing, one per reset, in spend order. */
const resetsOf = (listing: ResetListing, now: DateTime.Utc): ReadonlyArray<LimitReset> => {
  const live = (listing.grants ?? []).flatMap((grant) => {
    const expiresAt = parseTime(grant.ends_at)
    if (Option.isSome(expiresAt) && !DateTime.isGreaterThan(expiresAt.value, now)) return []
    const grantedAt = parseTime(grant.starts_at)
    const title = titleOf(grant.label)
    const reset = new LimitReset({
      id: grant.id,
      ...(title === undefined ? {} : { title }),
      ...(Option.isSome(grantedAt) ? { grantedAt: grantedAt.value } : {}),
      ...(Option.isSome(expiresAt) ? { expiresAt: expiresAt.value } : {}),
    })
    return [{ reset, left: Math.min(grant.resets_left, mostPerGrant) }]
  })
  const next = listing.next_grant_id
  const sorted = live.toSorted(
    (a, b) => Number(a.reset.id !== next) - Number(b.reset.id !== next) || expiryOf(a.reset) - expiryOf(b.reset),
  )
  return sorted.flatMap(({ reset, left }) => Array.from({ length: left }, () => reset))
}

/**
 * The resets left in a usage answer, one per reset: the grant Claude would
 * spend next first, then the soonest to expire. None when the account has
 * none or may not use them.
 */
export const availableResets = (
  body: unknown,
  now: DateTime.Utc,
): Result.Result<ReadonlyArray<LimitReset>, ProviderFailed> =>
  Result.map(resetListing(body), (listing) =>
    Option.match(listing, { onNone: () => [], onSome: (found) => resetsOf(found, now) }),
  )

/** Why Claude would not list the resets to this caller, when it refused the caller rather than the account. */
const refusedCaller = (listing: ResetListing): string | undefined => {
  const reason = listing.ineligible_reason
  return listing.eligible === false && (reason === "surface" || reason === "cli_version") ? reason : undefined
}

const listResets = (account: Account, agent: string | undefined) =>
  Effect.gen(function* () {
    if (agent === undefined) return yield* new NeedsAgent({ agent: "claude-code" })
    const reply = yield* send(
      asClaudeCode(HttpClientRequest.get(`${api}/api/oauth/usage?cedar_ember=1&skip_spend=1`), account, agent),
    ).pipe(Effect.mapError(unreachable))
    if (!reply.ok) {
      return yield* new ProviderFailed({
        message: `listing limit resets failed (${statusLine(reply.status)})`,
        status: reply.status,
      })
    }
    if (Option.isNone(reply.json)) return yield* new ProviderFailed({ message: "unexpected usage reply" })
    const listing = yield* Effect.fromResult(resetListing(reply.json.value))
    if (Option.isNone(listing)) return []
    const refused = refusedCaller(listing.value)
    if (refused !== undefined)
      yield* Effect.logInfo(`${account.id}: Claude would not list its limit resets (${refused})`)
    return resetsOf(listing.value, yield* DateTime.now)
  })

/** Whether an id is a UUID, as an organization's is: it goes in the path. */
export const isUuid = (id: string): boolean =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)

/** What spending a reset came to, from Claude's `result` and `reason`. */
export const claimOutcome = (result: string, reason: string | undefined): RedeemOutcome => {
  if (result === "reset") return "reset"
  if (result === "not_limited") return "nothing-to-reset"
  if (result === "already_used") return "already-redeemed"
  if (reason === "no_grant" || reason === "unknown_grant" || reason === "expired") return "no-credit"
  // Paused, cooling down, or not offered to the account now.
  return "declined"
}

/** Claude's answer to spending a reset. */
const decodeClaimReply = Schema.decodeUnknownOption(
  Schema.Struct({ result: optionalField(Schema.String), reason: optionalField(Schema.String) }),
)

const redeemReset = (account: Account, id: string | undefined, agent: string | undefined) =>
  Effect.gen(function* () {
    if (agent === undefined) return yield* new NeedsAgent({ agent: "claude-code" })
    const org = account.identity.orgId
    if (org === undefined || !isUuid(org)) {
      return yield* new ProviderFailed({ message: "the account's organization is unknown; sign in again" })
    }
    const grant = id ?? (yield* listResets(account, agent))[0]?.id
    if (grant === undefined) return "no-credit" as const
    // The request id is reused on a retry, so a lost answer cannot spend two resets.
    const requestId = yield* withCrypto(newUuid)
    const request = asClaudeCode(
      HttpClientRequest.post(`${api}/api/organizations/${org}/reset_rate_limits`),
      account,
      agent,
    ).pipe(HttpClientRequest.bodyJsonUnsafe({ program, grant_id: grant, request_id: requestId }))
    const reply = yield* send(request).pipe(Effect.retry({ times: 1 }), Effect.mapError(unreachable))
    if (!reply.ok) {
      return yield* new ProviderFailed({
        message: `using a limit reset failed (${statusLine(reply.status)})`,
        status: reply.status,
      })
    }
    const result = Option.flatMap(reply.json, decodeClaimReply)
    if (Option.isNone(result)) return yield* new ProviderFailed({ message: "unexpected reply to using a limit reset" })
    const claimed = result.value.result ?? ""
    const reason = result.value.reason
    const outcome = claimOutcome(claimed, reason)
    if (outcome === "declined") {
      yield* Effect.logInfo(`${account.id}: Claude kept its limit reset (${claimed}, ${reason ?? "no reason given"})`)
    }
    return outcome
  })

export const claude: Provider = defineProvider({
  id: "claude",
  identity: (account) => account.identity.orgId ?? account.identity.accountId,
  login,
  refresh,
  identify,
  usage: Option.some(usage),
  headers: ({ client, account }) => {
    const out = forwardable(client)
    out.set("anthropic-beta", withOauthBeta(client.get("anthropic-beta")))
    out.set("authorization", `Bearer ${account.secret}`)
    return out
  },
  verdict,
  limitsFrom: limitsFromHeaders,
  showPool: showPoolInHeaders,
  resets: Option.some({ counted: false, needsAgent: true, list: listResets, redeem: redeemReset }),
})
