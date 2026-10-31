// Anthropic OAuth for Claude Pro/Max accounts (the Claude Code client).
import { Effect, Schema } from "effect"

import { ids, log, SignedDuration, Timestamp } from "@slopmax/common"
import { type Client, client, form } from "@slopmax/net"

import { Account, without } from "../../account.ts"
import { browserLogin } from "../../auth/callback.ts"
import { Grant, type LoginOptions, type Prompt, RefreshError, transient } from "../../auth/mod.ts"
import { Pkce } from "../../auth/pkce.ts"
import { chain, Failure, lift } from "../../error.ts"
import * as fsx from "../../fsx.ts"
import { opt, withDefault } from "../../serde.ts"

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
export const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

/** Registered loopback redirect for this client. */
export const CALLBACK_PORT = 54545
export const CALLBACK_PATH = "/callback"

/** Beta flag that lets OAuth access tokens call the Messages API. */
export const OAUTH_BETA = "oauth-2025-04-20"

export const redirectUri = (): string => `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`

export const authorizeUrl = (pkce: Pkce, state: string): string => {
  const params: ReadonlyArray<readonly [string, string]> = [
    ["code", "true"],
    ["client_id", CLIENT_ID],
    ["response_type", "code"],
    ["redirect_uri", redirectUri()],
    ["scope", SCOPES],
    ["code_challenge", pkce.challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
  ]
  return `${AUTHORIZE_URL}?${form.encode(params)}`
}

const TokenResponseSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: opt(Schema.String),
  expiresIn: opt(Schema.Int),
  account: opt(
    Schema.Struct({ uuid: opt(Schema.String), emailAddress: opt(Schema.String) }).pipe(
      Schema.encodeKeys({ emailAddress: "email_address" }),
    ),
  ),
  organization: opt(Schema.Struct({ uuid: opt(Schema.String), name: opt(Schema.String) })),
}).pipe(Schema.encodeKeys({ accessToken: "access_token", refreshToken: "refresh_token", expiresIn: "expires_in" }))

type TokenResponse = typeof TokenResponseSchema.Type

const grantOf = (token: TokenResponse, now: Timestamp): Grant => ({
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  idToken: undefined,
  expiresAt: token.expiresIn === undefined ? undefined : Timestamp.add(now, SignedDuration.fromSecs(token.expiresIn)),
})

/** `GET /api/oauth/profile`, the source of plan and organization details. */
export const ProfileSchema = Schema.Struct({
  account: withDefault(
    Schema.Struct({
      uuid: opt(Schema.String),
      email: opt(Schema.String),
      hasClaudeMax: withDefault(Schema.Boolean, false),
      hasClaudePro: withDefault(Schema.Boolean, false),
    }).pipe(Schema.encodeKeys({ hasClaudeMax: "has_claude_max", hasClaudePro: "has_claude_pro" })),
    {},
  ),
  organization: withDefault(
    Schema.Struct({
      uuid: opt(Schema.String),
      name: opt(Schema.String),
      /** e.g. `claude_max`, `claude_pro`, `claude_team`. */
      organizationType: opt(Schema.String),
      /** e.g. `default_claude_max_20x`. */
      rateLimitTier: opt(Schema.String),
    }).pipe(Schema.encodeKeys({ organizationType: "organization_type", rateLimitTier: "rate_limit_tier" })),
    {},
  ),
})

export type Profile = typeof ProfileSchema.Type

export const Profile = {
  default: (): Profile => ({
    account: { hasClaudeMax: false, hasClaudePro: false },
    organization: {},
  }),

  /** A short plan label such as `max 20x`, `pro`, or `team`. */
  plan: (self: Profile): string | undefined => {
    const tier = self.organization.rateLimitTier ?? ""
    const last = tier.split("_").at(-1) ?? ""
    const multiplier = last.endsWith("x") ? last : undefined
    let base: string
    const kind = self.organization.organizationType
    if (kind !== undefined) {
      base = kind
      while (base.startsWith("claude_")) base = base.slice("claude_".length)
    } else if (self.account.hasClaudeMax) base = "max"
    else if (self.account.hasClaudePro) base = "pro"
    else return undefined
    return multiplier !== undefined && base === "max" ? `max ${multiplier}` : base
  },
} as const

/** Signs in through claude.ai. */
export const login = Effect.fn("claude.oauth.login")(function* (http: Client, options: LoginOptions, prompt: Prompt) {
  const pkce = Pkce.generate()
  const state = ids.token()
  const url = authorizeUrl(pkce, state)
  const callback = yield* browserLogin("Claude", url, [CALLBACK_PORT, CALLBACK_PATH], state, options, prompt)
  return yield* exchange(http, callback.code, callback.state ?? state, pkce)
})

/** Exchanges an authorization code for tokens and builds the account. */
export const exchange = Effect.fn("claude.oauth.exchange")(function* (
  http: Client,
  code: string,
  state: string,
  pkce: Pkce,
) {
  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
    state,
  }
  const now = yield* Timestamp.now
  const response = yield* http.post(TOKEN_URL).json(body).send().pipe(Effect.mapError(lift))
  const status = response.status
  const text = yield* response.text().pipe(Effect.mapError(lift))
  if (!client.isSuccess(status)) {
    return yield* Effect.fail(new Failure({ message: `token exchange failed (${client.statusText(status)}): ${text}` }))
  }
  const token = yield* fsx
    .parseJson(text, TokenResponseSchema)
    .pipe(Effect.mapError((cause) => new Failure({ message: "unexpected token response", cause })))

  let account = Account.make("claude", Grant.intoTokens(grantOf(token, now), now), now)
  const fromToken = token.account
  if (fromToken !== undefined) {
    account = withId(withId(account, "accountId", fromToken.uuid), "email", fromToken.emailAddress)
  }
  const org = token.organization
  if (org !== undefined) account = withId(withId(account, "orgId", org.uuid), "orgName", org.name)
  const looked = yield* Effect.result(profile(http, account.tokens.accessToken))
  if (looked._tag === "Success") account = applyProfile(account, looked.success)
  else log.warn(`profile lookup failed: ${chain(looked.failure)}`)
  return Account.assignId(account)
})

// `account.field = value.clone()`: set, or cleared when absent.
const withId = (
  account: Account,
  key: "accountId" | "email" | "orgId" | "orgName",
  value: string | undefined,
): Account => (value === undefined ? without(account, key) : { ...account, [key]: value })

/** Fetches the account profile with an access token. */
export const profile = Effect.fn("claude.oauth.profile")(function* (http: Client, accessToken: string) {
  const response = yield* http
    .get(PROFILE_URL)
    .bearerAuth(accessToken)
    .header("anthropic-beta", OAUTH_BETA)
    .send()
    .pipe(
      Effect.flatMap((r) => r.errorForStatus()),
      Effect.mapError(lift),
    )
  return yield* response.json(ProfileSchema).pipe(Effect.mapError(lift))
})

const keep = (value: string | undefined): value is string => value !== undefined && value !== ""

/** Fills identity and plan from a profile without erasing known values. */
export const applyProfile = (account: Account, found: Profile): Account => {
  const fields: Record<string, string> = {}
  if (keep(found.account.uuid)) fields.accountId = found.account.uuid
  if (keep(found.account.email)) fields.email = found.account.email
  if (keep(found.organization.uuid)) fields.orgId = found.organization.uuid
  if (keep(found.organization.name)) fields.orgName = found.organization.name
  const plan = Profile.plan(found)
  if (keep(plan)) fields.plan = plan
  return { ...account, ...fields }
}

/**
 * Redeems a refresh token. Anthropic rotates refresh tokens, so the old one
 * is dead once this succeeds.
 */
export const refresh = Effect.fn("claude.oauth.refresh")(function* (
  http: Client,
  refreshToken: string,
): Effect.fn.Return<Grant, RefreshError> {
  const body = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, scope: SCOPES }
  const now = yield* Timestamp.now
  const response = yield* http.post(TOKEN_URL).json(body).send().pipe(Effect.mapError(transient))
  const status = response.status
  const text = yield* response.text().pipe(Effect.mapError(transient))
  if (client.isSuccess(status)) {
    const token = yield* fsx.parseJson(text, TokenResponseSchema).pipe(Effect.mapError(transient))
    return grantOf(token, now)
  }
  return yield* Effect.fail(RefreshError.classify(status, text))
})
