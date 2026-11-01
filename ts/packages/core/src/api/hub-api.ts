// The hub: the part of CLIProxyAPI's management API that tools showing a
// hub's quotas use, T3 Code among them. Given slopmax's address and owner
// key, they list its subscription accounts, read each one's usage and limit
// resets, redeem resets, and clear an account's cooldown.
//
// Its paths, bodies, key headers and error shape are those tools', not
// slopmax's, so it is an API of its own beside `SlopmaxApi`: errors are
// `{ "error": message }`, and the key may come as `x-management-key` too.
import { ownerKeyMatches } from "@slopmax/domain/api"
import { Effect, Layer, Redacted, Schema, SchemaTransformation } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"

/** Where the hub lives on the proxy's address. */
export const hubPrefix = "/v0/management"

// --- Errors, in the hub's shape -----------------------------------------------

export class HubBadRequest extends Schema.Error<HubBadRequest>("HubBadRequest")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export class HubUnauthorized extends Schema.Error<HubUnauthorized>("HubUnauthorized")(
  { error: Schema.String },
  { httpApiStatus: 401 },
) {
  static readonly message = "missing or invalid management key; use slopmax's api_key"
}

export class HubForbidden extends Schema.Error<HubForbidden>("HubForbidden")(
  { error: Schema.String },
  { httpApiStatus: 403 },
) {}

export class HubNotFound extends Schema.Error<HubNotFound>("HubNotFound")(
  { error: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Every error the hub answers with, each `{ "error": message }` under its own status. */
export type HubError = HubBadRequest | HubUnauthorized | HubForbidden | HubNotFound

/** What an unknown path under the hub hears. */
export const hubUnknownPath = "slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API"

// --- The key ------------------------------------------------------------------

const verify = (given: string, key: Redacted.Redacted<string>) =>
  ownerKeyMatches(Redacted.make(given), key)
    ? Effect.void
    : Effect.fail(new HubUnauthorized({ error: HubUnauthorized.message }))

/**
 * The owner key, as a bearer token, as `x-api-key`, or as CLIProxyAPI's own
 * `x-management-key` (trimmed). Client keys are not accepted.
 */
export class ManagementKey extends HttpApiMiddleware.Service<ManagementKey>()("@slopmax/core/ManagementKey", {
  security: {
    bearer: HttpApiSecurity.bearer,
    header: HttpApiSecurity.apiKey({ in: "header", key: "x-api-key" }),
    management: HttpApiSecurity.apiKey({ in: "header", key: "x-management-key" }),
  },
  error: HubUnauthorized,
}) {
  /** Checks each call against the owner key `current` reads, so the key in force is always the one used. */
  static readonly layer = (current: Effect.Effect<Redacted.Redacted<string>>): Layer.Layer<ManagementKey> => {
    const check =
      (read: (given: string) => string = (given) => given) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>, { credential }: { readonly credential: Redacted.Redacted<string> }) =>
        Effect.andThen(
          Effect.flatMap(current, (key) => verify(read(Redacted.value(credential)), key)),
          effect,
        )
    return Layer.succeed(ManagementKey, {
      bearer: check(),
      header: check(),
      management: check((given) => given.trim()),
    })
  }
}

/**
 * A body that does not decode is refused in the hub's words: `invalid body`
 * for a call, and `auth_index is required` for a cooldown reset.
 */
export class HubInput extends HttpApiMiddleware.Service<HubInput>()("@slopmax/core/HubInput", {
  error: HubBadRequest,
}) {
  static readonly layer: Layer.Layer<HubInput> = HttpApiMiddleware.layerSchemaErrorTransform(
    HubInput,
    (_error, { endpoint }) =>
      Effect.fail(
        new HubBadRequest({ error: endpoint.identifier === "resetQuota" ? "auth_index is required" : "invalid body" }),
      ),
  )
}

// --- Bodies -------------------------------------------------------------------

/** Tools name the account as `auth_index`, `authIndex` or `AuthIndex`. */
const indexKeys = {
  auth_index: Schema.optionalKey(Schema.String),
  authIndex: Schema.optionalKey(Schema.String),
  AuthIndex: Schema.optionalKey(Schema.String),
}

const Indexed = Schema.Struct(indexKeys)

const indexOf = (body: typeof Indexed.Type): string | undefined => body.auth_index ?? body.authIndex ?? body.AuthIndex

/** A call a hub client asks slopmax to make with an account. Headers it asks for are ignored. */
export class ApiCall extends Schema.Class<ApiCall>("ApiCall")({
  authIndex: Schema.String,
  method: Schema.String,
  url: Schema.String,
  /** The call's body, as JSON text. */
  data: Schema.String,
}) {}

const ApiCallBody = Schema.Struct({
  ...indexKeys,
  method: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    ApiCall,
    SchemaTransformation.transform({
      decode: (body) => ({
        authIndex: indexOf(body) ?? "",
        method: body.method ?? "",
        url: body.url ?? "",
        data: body.data ?? "",
      }),
      encode: (call) => ({ auth_index: call.authIndex, method: call.method, url: call.url, data: call.data }),
    }),
  ),
)

/** The account whose cooldown is to be cleared. */
export class ResetQuota extends Schema.Class<ResetQuota>("ResetQuota")({ authIndex: Schema.String }) {}

// HubInput gives the refusal its words.
const ResetQuotaBody = Indexed.check(
  Schema.makeFilter((body: typeof Indexed.Type) => indexOf(body) !== undefined),
).pipe(
  Schema.decodeTo(
    ResetQuota,
    SchemaTransformation.transform({
      decode: (body) => ({ authIndex: indexOf(body) ?? "" }),
      encode: (reset) => ({ auth_index: reset.authIndex }),
    }),
  ),
)

// --- Answers ------------------------------------------------------------------

/** One subscription account, as CLIProxyAPI lists its auth files. Absent values are left out: clients reject nulls. */
export const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["error", "disabled", "active"]),
  disabled: Schema.Boolean,
  /** Signed out, or sitting out a refused quota. */
  unavailable: Schema.Boolean,
  priority: Schema.Number,
  email: Schema.optionalKey(Schema.String),
  status_message: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
      chatgpt_plan_type: Schema.optionalKey(Schema.String),
    }),
  ),
})
export type AuthFile = typeof AuthFile.Type

export const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) })

/** A call's answer: always HTTP 200, with the call's own status, headers and body inside. */
export const CallAnswer = Schema.Struct({
  status_code: Schema.Int,
  header: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  body: Schema.String,
})
export type CallAnswer = typeof CallAnswer.Type

export const QuotaReset = Schema.Struct({
  status: Schema.Literal("ok"),
  auth_index: Schema.String,
  /** The models whose caps were lifted. */
  models: Schema.Array(Schema.String),
})

// --- The API ------------------------------------------------------------------

export class ManagementGroup extends HttpApiGroup.make("management")
  .add(HttpApiEndpoint.get("authFiles", "/auth-files", { success: AuthFiles }))
  .add(
    HttpApiEndpoint.post("apiCall", "/api-call", {
      payload: ApiCallBody,
      success: CallAnswer,
      error: [HubBadRequest, HubForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("resetQuota", "/reset-quota", {
      payload: ResetQuotaBody,
      success: QuotaReset,
      error: HubNotFound,
    }),
  ) {}

export class HubApi extends HttpApi.make("hub")
  .add(ManagementGroup)
  .middleware(HubInput)
  .middleware(ManagementKey)
  .prefix(hubPrefix) {}
