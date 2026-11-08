// slopmax's own API, under `/slopmax/api`. The daemon serves it, the CLI
// calls it while a proxy runs, and the dashboard and the desktop window are
// built on it, so all of them share this one typed definition. Every
// endpoint needs the owner key.
import { Effect, Layer, Redacted, Schema, SchemaTransformation } from "effect"
import { Mac } from "effect/crypto"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api"
import { AgentWiring } from "./agents.ts"
import { Section } from "./doctor.ts"
import { BadRequest, Conflict, Internal, issueText, NotFound, Unauthorized, UpstreamFailed } from "./errors.ts"
import { Event } from "./events.ts"
import { AccountId, AgentId, Dialect, KeyName, ProviderId, SubscriptionId, withDefault } from "./ids.ts"
import { History, HistoryRange, Summary, SummaryBy, SummaryRange } from "./ledger.ts"
import { LoginId } from "./login.ts"
import { providerFacts } from "./providers.ts"
import { AccountView, RedeemResult, Report } from "./report.ts"
import { KeyInfo, NewKey, SettingsPatch, SettingsView, strict } from "./settings.ts"

const encoder = new TextEncoder()

/** The owner key's bytes, encoded once per key rather than once per call. */
const keyBytes = (() => {
  let last: { readonly key: Redacted.Redacted<string>; readonly bytes: Uint8Array } | undefined
  return (key: Redacted.Redacted<string>): Uint8Array => {
    if (last?.key !== key) last = { key, bytes: encoder.encode(Redacted.value(key)) }
    return last.bytes
  }
})()

/**
 * Whether `given` is the owner key, compared in constant time, so timing the
 * answer says nothing about how much of a guess was right. No key matches an
 * empty one.
 */
export const ownerKeyMatches = (given: Redacted.Redacted<string>, key: Redacted.Redacted<string>): boolean => {
  const expected = keyBytes(key)
  return expected.length > 0 && Mac.timingSafeEqual(encoder.encode(Redacted.value(given)), expected)
}

/**
 * The owner key, as `Authorization: Bearer <key>` or `x-api-key: <key>`,
 * compared in constant time. Client keys reach the proxy but get 401 here.
 */
export class OwnerKey extends HttpApiMiddleware.Service<OwnerKey>()("@slopmax/client/OwnerKey", {
  security: {
    bearer: HttpApiSecurity.bearer,
    header: HttpApiSecurity.apiKey({ in: "header", key: "x-api-key" }),
  },
  error: Unauthorized,
}) {
  /** Checks each call against the owner key `current` reads, so a server always uses the key in force. */
  static readonly layer = (current: Effect.Effect<Redacted.Redacted<string>>): Layer.Layer<OwnerKey> => {
    const verify = (credential: Redacted.Redacted<string>): Effect.Effect<void, Unauthorized> =>
      Effect.flatMap(current, (key) =>
        ownerKeyMatches(credential, key) ? Effect.void : Effect.fail(new Unauthorized()),
      )
    return Layer.succeed(OwnerKey, {
      bearer: (effect, { credential }) => Effect.andThen(verify(credential), effect),
      header: (effect, { credential }) => Effect.andThen(verify(credential), effect),
    })
  }
}

/** Answers a body, path or query that does not decode with a 400 saying what is wrong. */
export class InputErrors extends HttpApiMiddleware.Service<InputErrors>()("@slopmax/client/InputErrors", {
  error: BadRequest,
}) {
  static readonly layer: Layer.Layer<InputErrors> = HttpApiMiddleware.layerSchemaErrorTransform(InputErrors, (error) =>
    Effect.fail(new BadRequest({ message: issueText(error.cause.issue) })),
  )
}

// --- Bodies -----------------------------------------------------------------

const KeyProvider = Schema.Literals(ProviderId.literals)
  .annotate({ message: "provider is anthropic, openai, xai, or compat" })
  .check(
    Schema.makeFilter((provider: ProviderId) => {
      const facts = providerFacts[provider]
      if (facts.signIn === "key") return true
      if (facts.signIn === "endpoint") return "a compatible endpoint is added with its url, as an Endpoint"
      return `${facts.title} accounts sign in with a browser: \`slopmax login ${provider}\`, or the app`
    }),
  )

/** An endpoint's base URL, trimmed and without a trailing `/`. */
const BaseUrl = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((url: string) => /^https?:\/\//.test(url) || "url is an http:// or https:// base URL"),
    ),
    SchemaTransformation.transform({ decode: (url) => url.trim().replace(/\/+$/, ""), encode: (url) => url }),
  ),
)

/** Model names or patterns, trimmed, with empty ones dropped. */
const ModelList = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, ReadonlyArray<string>>({
      decode: (models) => models.map((model) => model.trim()).filter((model) => model !== ""),
      encode: (models) => models,
    }),
  ),
)

/** A label given when adding or renaming an account, trimmed. */
const Label = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({ decode: (label) => label.trim(), encode: (label) => label }),
  ),
)

/** A new label: a blank one, like `null`, clears it, so the email shows again. */
const NewLabel = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.String),
    SchemaTransformation.transform({
      decode: (label) => (label === null || label.trim() === "" ? null : label.trim()),
      encode: (label) => label,
    }),
  ),
)

/** An account added through the API: an API key, or a compatible endpoint. Subscriptions sign in instead. */
export const AddAccount = Schema.TaggedUnion({
  Key: { provider: KeyProvider, key: Schema.String, label: Schema.optionalKey(Label) },
  Endpoint: {
    url: BaseUrl.pipe(Schema.annotateKey({ messageMissingKey: "a compatible endpoint needs its url" })),
    dialect: Dialect.annotate({ message: "dialect is chat, responses, or messages" }).pipe(withDefault("chat")),
    models: ModelList.pipe(withDefault([])),
    /** Some endpoints need no key. */
    key: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Label),
  },
})
export type AddAccount = typeof AddAccount.Type

export class AccountAdded extends Schema.Class<AccountAdded>("AccountAdded")({
  account: AccountView,
  report: Report,
}) {}

/** Changes to an account. A `null` or blank label clears it, so the email shows again. */
export class AccountPatch extends Schema.Class<AccountPatch>("AccountPatch")({
  label: Schema.optionalKey(NewLabel),
  /** Higher goes first; 0 is the default. */
  priority: Schema.optionalKey(
    Schema.Number.annotate({ message: "priority is a whole number" }).check(
      Schema.isInt({ message: "priority is a whole number" }),
    ),
  ),
  disabled: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * Stands in for a body whose every field may be left out, when the body itself
 * is: a bare POST from curl or a dashboard button reads as `empty`. The
 * server reads an empty body as `null` when a payload's encoded side is
 * `null`, so this is listed beside the full body schema.
 */
const leftOut = <S extends Schema.Top>(body: S, empty: S["Type"]) =>
  Schema.Null.pipe(
    Schema.decodeTo(
      Schema.toType(body),
      SchemaTransformation.transform<S["Type"], null>({ decode: () => empty, encode: () => null }),
    ),
  )

export class RedeemRequest extends Schema.Class<RedeemRequest>("RedeemRequest")({
  /** The limit reset to spend; the soonest to expire when absent. */
  reset: Schema.optionalKey(Schema.String),
}) {}

/** Where logins are imported from. */
export const ImportSource = Schema.Literals(["claude-code", "codex", "cliproxyapi"])
export type ImportSource = typeof ImportSource.Type

export class ImportRequest extends Schema.Class<ImportRequest>("ImportRequest")({
  /** Every source when absent. */
  sources: Schema.optionalKey(Schema.Array(ImportSource)),
  /** Take the logins over, so slopmax refreshes them itself, instead of following the tool's copy. */
  own: Schema.Boolean.pipe(withDefault(false)),
}) {}

/** One login found while importing: saved, or why it could not be. */
export const ImportOutcome = Schema.TaggedUnion({
  Saved: { source: ImportSource, origin: Schema.String, account: AccountView, isNew: Schema.Boolean },
  Failed: { source: ImportSource, origin: Schema.String, message: Schema.String },
})
export type ImportOutcome = typeof ImportOutcome.Type

export class ImportResult extends Schema.Class<ImportResult>("ImportResult")({
  outcomes: Schema.Array(ImportOutcome),
  report: Report,
}) {}

/** A subscription sign-in. `device` asks for a code to enter on any device instead of a browser redirect. */
export class StartLogin extends Schema.Class<StartLogin>("StartLogin")({
  provider: SubscriptionId.annotate({ message: `only ${SubscriptionId.literals.join(" and ")} accounts sign in` }),
  device: Schema.Boolean.pipe(withDefault(false)),
  /** What to call the account; else its email. */
  label: Schema.optionalKey(Label),
  /** Leave the browser closed: the client opens the address, or shows it for a browser elsewhere. */
  noBrowser: Schema.Boolean.pipe(withDefault(false)),
}) {}

export class LoginStarted extends Schema.Class<LoginStarted>("LoginStarted")({ id: LoginId }) {}

/** The address the browser landed on after signing in, pasted from another machine. */
export class PasteAddress extends Schema.Class<PasteAddress>("PasteAddress")({ address: Schema.String }) {}

export class MakeKey extends Schema.Class<MakeKey>("MakeKey")({
  name: Schema.String.pipe(
    Schema.decodeTo(
      KeyName.annotate({ message: "a key needs a name" }),
      SchemaTransformation.transform({ decode: (name) => name.trim(), encode: (name) => name }),
    ),
    Schema.annotateKey({ messageMissingKey: "a key needs a name" }),
  ),
  models: ModelList.pipe(withDefault([])),
}) {}

export class AgentConnected extends Schema.Class<AgentConnected>("AgentConnected")({
  /** The settings file that was edited. */
  path: Schema.String,
  /** What to know next, such as restarting the agent. */
  note: Schema.String,
}) {}

export class AgentDisconnected extends Schema.Class<AgentDisconnected>("AgentDisconnected")({
  path: Schema.String,
}) {}

export class Stopping extends Schema.Class<Stopping>("Stopping")({ status: Schema.Literal("stopping") }) {}

const accountParams = { id: AccountId }
const notFound = [NotFound] as const

// --- Groups -------------------------------------------------------------------

export class SystemGroup extends HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("status", "/status", { success: Report }))
  .add(HttpApiEndpoint.post("refresh", "/refresh", { success: Report, error: Internal }))
  .add(HttpApiEndpoint.post("sync", "/sync", { success: Report, error: Internal }))
  .add(HttpApiEndpoint.post("shutdown", "/shutdown", { success: Stopping }))
  .add(HttpApiEndpoint.get("doctor", "/doctor", { success: Schema.Array(Section), error: Internal })) {}

export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.post("add", "/accounts", {
      payload: AddAccount,
      success: AccountAdded,
      error: [UpstreamFailed, Internal],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/accounts/:id", {
      params: accountParams,
      payload: AccountPatch,
      success: Report,
      error: [NotFound, Internal],
    }),
  )
  .add(HttpApiEndpoint.post("pin", "/accounts/:id/pin", { params: accountParams, success: Report, error: notFound }))
  .add(HttpApiEndpoint.delete("unpinAll", "/pins", { success: Report }))
  .add(
    HttpApiEndpoint.post("own", "/accounts/:id/own", {
      params: accountParams,
      success: Report,
      error: [NotFound, Internal],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/accounts/:id", {
      params: accountParams,
      success: Report,
      error: [NotFound, Internal],
    }),
  )
  .add(
    HttpApiEndpoint.post("redeem", "/accounts/:id/redeem", {
      params: accountParams,
      payload: [RedeemRequest, leftOut(RedeemRequest, Schema.decodeUnknownSync(RedeemRequest)({}))],
      success: RedeemResult,
      // BadRequest: the account's provider has no limit resets.
      error: [BadRequest, NotFound, Conflict, UpstreamFailed],
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/imports", {
      payload: [ImportRequest, leftOut(ImportRequest, Schema.decodeUnknownSync(ImportRequest)({}))],
      success: ImportResult,
      error: Internal,
    }),
  ) {}

export class LoginsGroup extends HttpApiGroup.make("logins")
  .add(HttpApiEndpoint.post("start", "/logins", { payload: StartLogin, success: LoginStarted }))
  .add(
    HttpApiEndpoint.post("paste", "/logins/:id/paste", {
      params: { id: LoginId },
      payload: PasteAddress,
      error: notFound,
    }),
  )
  .add(HttpApiEndpoint.delete("cancel", "/logins/:id", { params: { id: LoginId }, error: notFound })) {}

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("settings", "/settings", { success: SettingsView }))
  .add(HttpApiEndpoint.patch("change", "/settings", { payload: SettingsPatch, success: SettingsView, error: Internal }))
  .add(HttpApiEndpoint.get("keys", "/keys", { success: Schema.Array(KeyInfo) }))
  .add(HttpApiEndpoint.post("makeKey", "/keys", { payload: MakeKey, success: NewKey, error: [Conflict, Internal] }))
  .add(
    HttpApiEndpoint.delete("removeKey", "/keys/:name", {
      params: { name: KeyName },
      success: Schema.Array(KeyInfo),
      error: [NotFound, Internal],
    }),
  ) {}

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(HttpApiEndpoint.get("list", "/agents", { success: Schema.Array(AgentWiring) }))
  .add(
    HttpApiEndpoint.post("connect", "/agents/:id/connect", {
      params: { id: AgentId },
      success: AgentConnected,
      error: Internal,
    }),
  )
  .add(
    HttpApiEndpoint.post("disconnect", "/agents/:id/disconnect", {
      params: { id: AgentId },
      success: AgentDisconnected,
      error: [Conflict, Internal],
    }),
  ) {}

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.get("summary", "/usage", {
      query: { range: SummaryRange.pipe(withDefault("7d")), by: SummaryBy.pipe(withDefault("day")) },
      success: Summary,
      error: Internal,
    }),
  )
  .add(
    HttpApiEndpoint.get("history", "/history", {
      query: { range: HistoryRange.pipe(withDefault("7d")) },
      success: History,
      error: Internal,
    }),
  ) {}

export class EventsGroup extends HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("watch", "/events", { success: HttpApiSchema.StreamSse({ data: Event }) }),
) {}

export class NotifyGroup extends HttpApiGroup.make("notify").add(
  HttpApiEndpoint.post("test", "/notify/test", { error: [BadRequest, UpstreamFailed] }),
) {}

/** Where the API lives on the proxy's address. */
export const apiPrefix = "/slopmax/api"

export class SlopmaxApi extends HttpApi.make("slopmax")
  .add(SystemGroup)
  .add(AccountsGroup)
  .add(LoginsGroup)
  .add(ConfigGroup)
  .add(AgentsGroup)
  .add(UsageGroup)
  .add(EventsGroup)
  .add(NotifyGroup)
  .middleware(InputErrors)
  .middleware(OwnerKey)
  .prefix(apiPrefix)
  // A body with a key slopmax does not know is refused, as in `config.json`.
  .annotate(HttpApi.PayloadParseOptions, strict) {}
