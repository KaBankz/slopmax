// OpenAI OAuth for ChatGPT accounts (the Codex CLI client).
import { Clock, Duration, Effect, Schema } from "effect"

import { ids, Timestamp } from "@slopmax/common"
import { type Client, client, form, HttpError } from "@slopmax/net"
import { json } from "@slopmax/wire"

import { Account } from "../../account.ts"
import { browserLogin } from "../../auth/callback.ts"
import { claims, expiry } from "../../auth/jwt.ts"
import { Grant, LoginEvent, type LoginOptions, type Prompt, RefreshError, transient } from "../../auth/mod.ts"
import { Pkce } from "../../auth/pkce.ts"
import { Failure, lift } from "../../error.ts"
import * as fsx from "../../fsx.ts"
import { JsonValue, opt } from "../../serde.ts"
import { jsonBody } from "../mod.ts"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
const SCOPES = "openid profile email offline_access"

/** OpenAI only accepts this exact loopback redirect for the Codex client. */
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = "/auth/callback"

export const DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device"
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback"
const DEVICE_TIMEOUT = Duration.minutes(15)

/** Namespaced claim object carrying ChatGPT account details. */
export const AUTH_CLAIM = "https://api.openai.com/auth"
export const PROFILE_CLAIM = "https://api.openai.com/profile"

export const redirectUri = (): string => `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`

export const authorizeUrl = (pkce: Pkce, state: string): string => {
  const params: ReadonlyArray<readonly [string, string]> = [
    ["response_type", "code"],
    ["client_id", CLIENT_ID],
    ["redirect_uri", redirectUri()],
    ["scope", SCOPES],
    ["code_challenge", pkce.challenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    // Always show the account picker so a second account can be added.
    ["prompt", "login"],
    ["state", state],
    ["originator", "codex_cli_rs"],
  ]
  return `${ISSUER}/oauth/authorize?${form.encode(params)}`
}

/** Signs in through auth.openai.com, in a browser or with a device code. */
export const login = Effect.fn("codex.oauth.login")(function* (http: Client, options: LoginOptions, prompt: Prompt) {
  if (options.device) return yield* deviceLogin(http, prompt)
  const pkce = Pkce.generate()
  const state = ids.token()
  const url = authorizeUrl(pkce, state)
  const callback = yield* browserLogin("ChatGPT", url, [CALLBACK_PORT, CALLBACK_PATH], state, options, prompt)
  return yield* exchange(http, callback.code, pkce.verifier, redirectUri())
})

const TokenResponseSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: opt(Schema.String),
  idToken: opt(Schema.String),
}).pipe(Schema.encodeKeys({ accessToken: "access_token", refreshToken: "refresh_token", idToken: "id_token" }))

const grantOf = (token: typeof TokenResponseSchema.Type): Grant => ({
  accessToken: token.accessToken,
  refreshToken: token.refreshToken,
  idToken: token.idToken,
  expiresAt: expiry(token.accessToken),
})

/** Exchanges an authorization code for tokens and builds the account. */
export const exchange = Effect.fn("codex.oauth.exchange")(function* (
  http: Client,
  code: string,
  verifier: string,
  redirect: string,
) {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["grant_type", "authorization_code"],
    ["code", code],
    ["redirect_uri", redirect],
    ["client_id", CLIENT_ID],
    ["code_verifier", verifier],
  ]
  const response = yield* http.post(`${ISSUER}/oauth/token`).form(pairs).send().pipe(Effect.mapError(lift))
  const status = response.status
  const text = yield* response.text().pipe(Effect.mapError(lift))
  if (!client.isSuccess(status)) {
    return yield* Effect.fail(new Failure({ message: `token exchange failed (${client.statusText(status)}): ${text}` }))
  }
  const token = yield* fsx
    .parseJson(text, TokenResponseSchema)
    .pipe(Effect.mapError((e) => new Failure({ message: "unexpected token response", cause: lift(e) })))
  const now = yield* Timestamp.now
  return applyClaims(Account.make("codex", Grant.intoTokens(grantOf(token), now), now))
})

/** Fills email, plan, and workspace from the id/access token claims. */
export const applyClaims = (account: Account): Account => {
  const tokens = account.tokens
  const found = [tokens.idToken, tokens.accessToken]
    .filter((t): t is string => t !== undefined)
    .map(claims)
    .filter((c): c is json.Json => c !== undefined)
  const find = (pick: (c: json.Json) => json.Json | undefined): string | undefined => {
    for (const c of found) {
      const value = json.str(pick(c))
      if (value !== undefined && value !== "") return value
    }
    return undefined
  }
  const accountId = find((c) => json.get(json.get(c, AUTH_CLAIM), "chatgpt_account_id"))
  const plan = find((c) => json.get(json.get(c, AUTH_CLAIM), "chatgpt_plan_type"))
  const email = find((c) => json.get(c, "email")) ?? find((c) => json.get(json.get(c, PROFILE_CLAIM), "email"))
  return Account.assignId({
    ...account,
    ...(accountId === undefined ? {} : { accountId }),
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
  })
}

/** Redeems a refresh token. OpenAI rotates refresh tokens on use. */
export const refresh = Effect.fn("codex.oauth.refresh")(function* (
  http: Client,
  refreshToken: string,
): Effect.fn.Return<Grant, RefreshError> {
  // Same shape as the Codex CLI: JSON, no scope.
  const body = { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }
  const response = yield* http.post(`${ISSUER}/oauth/token`).json(body).send().pipe(Effect.mapError(transient))
  const status = response.status
  const text = yield* response.text().pipe(Effect.mapError(transient))
  if (client.isSuccess(status)) {
    const token = yield* fsx.parseJson(text, TokenResponseSchema).pipe(Effect.mapError(transient))
    return grantOf(token)
  }
  return yield* Effect.fail(RefreshError.classify(status, text))
})

const DeviceCodeSchema = Schema.Struct({
  deviceAuthId: Schema.String,
  userCode: opt(Schema.String),
  /** Older servers name it `usercode`. */
  usercode: opt(Schema.String),
  interval: opt(JsonValue),
}).pipe(Schema.encodeKeys({ deviceAuthId: "device_auth_id", userCode: "user_code" }))

const DeviceGrantSchema = Schema.Struct({
  authorizationCode: Schema.String,
  codeVerifier: Schema.String,
}).pipe(Schema.encodeKeys({ authorizationCode: "authorization_code", codeVerifier: "code_verifier" }))

// `as_u64()`, else a string `str::parse::<u64>` reads.
const seconds = (value: json.Json): number | undefined => {
  const n = json.u64(value)
  if (n !== undefined) return n
  return typeof value === "string" && /^\+?[0-9]+$/.test(value) && Number(value) < 2 ** 64 ? Number(value) : undefined
}

/**
 * Logs in with a short code entered at auth.openai.com, for machines
 * without a browser.
 */
export const deviceLogin = Effect.fn("codex.oauth.deviceLogin")(function* (http: Client, prompt: Prompt) {
  const response = yield* http
    .post(`${ISSUER}/api/accounts/deviceauth/usercode`)
    .json({ client_id: CLIENT_ID })
    .send()
    .pipe(Effect.mapError(lift))
  const checked = yield* response
    .errorForStatus()
    .pipe(Effect.mapError((e) => new Failure({ message: "device login is unavailable", cause: lift(e) })))
  const code = yield* jsonBody(checked).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(DeviceCodeSchema)(value).pipe(
        Effect.mapError((e) => new HttpError({ kind: "Decode", reason: e.message })),
      ),
    ),
    Effect.mapError(lift),
  )
  const userCode = code.userCode ?? code.usercode
  if (userCode === undefined) {
    return yield* Effect.fail(new Failure({ message: "missing field `user_code`" }))
  }
  const interval = Math.max(1, (code.interval === undefined ? undefined : seconds(code.interval)) ?? 5)

  prompt.tell(LoginEvent.DeviceCode(DEVICE_VERIFY_URL, userCode))

  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(DEVICE_TIMEOUT)
  for (;;) {
    if ((yield* Clock.currentTimeMillis) > deadline) {
      return yield* Effect.fail(new Failure({ message: "device code expired; run login again" }))
    }
    yield* Effect.sleep(Duration.seconds(interval))
    const poll = yield* http
      .post(`${ISSUER}/api/accounts/deviceauth/token`)
      .json({ device_auth_id: code.deviceAuthId, user_code: userCode })
      .send()
      .pipe(Effect.mapError(lift))
    const status = poll.status
    if (status === 403 || status === 404) continue
    if (client.isSuccess(status)) {
      const grant = yield* poll.json(DeviceGrantSchema).pipe(Effect.mapError(lift))
      return yield* exchange(http, grant.authorizationCode, grant.codeVerifier, DEVICE_REDIRECT_URI)
    }
    const text = yield* poll.text().pipe(Effect.mapError(lift))
    return yield* Effect.fail(new Failure({ message: `device login failed (${client.statusText(status)}): ${text}` }))
  }
})
