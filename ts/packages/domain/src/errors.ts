// Errors that cross a boundary: slopmax's own API answers them with their
// status, and the CLI prints their message. Every message is written for
// people, in slopmax's words, and travels with the error, so a front end shows
// it as it is. Errors made from a few facts word their message themselves;
// one decoded from the wire keeps the message it came with.
import { Effect, Schema, SchemaIssue } from "effect"
// For the `httpApiStatus` annotation.
// oxlint-disable-next-line import/no-empty-named-blocks, unicorn/require-module-specifiers
import type {} from "effect/http-api"
import { AccountId } from "./ids.ts"

/** The owner key was missing or wrong. Client keys reach the proxy, never slopmax's own API. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("missing or invalid slopmax key; see `slopmax env`")),
    ),
  },
  { httpApiStatus: 401 },
) {}

/** Nothing by that name: `no such account`, `no such key`, `no such slopmax endpoint`. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { what: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {
  constructor(props: { readonly what: string; readonly message?: string }) {
    super({ what: props.what, message: props.message ?? `no such ${props.what}` })
  }
}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The request is fine but the account or setting is not in a state to do it. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A provider refused or failed what slopmax asked of it on the caller's behalf. */
export class UpstreamFailed extends Schema.TaggedError<UpstreamFailed>()(
  "UpstreamFailed",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class Internal extends Schema.TaggedError<Internal>()(
  "Internal",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

/** `config.json` does not decode. Nothing is written while it is so. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()(
  "SettingsInvalid",
  { path: Schema.String, issue: Schema.String, message: Schema.String },
  { httpApiStatus: 500 },
) {
  constructor(props: { readonly path: string; readonly issue: string; readonly message?: string }) {
    super({ ...props, message: props.message ?? `invalid settings in ${props.path}: ${props.issue}` })
  }
}

/** A value given for a setting was refused, before anything was written. */
export class SettingRejected extends Schema.TaggedError<SettingRejected>()(
  "SettingRejected",
  { name: Schema.String, reason: Schema.String, message: Schema.String },
  { httpApiStatus: 400 },
) {
  constructor(props: { readonly name: string; readonly reason: string; readonly message?: string }) {
    super({ ...props, message: props.message ?? props.reason })
  }
}

/** No account matches what was asked for (an id, a name, an email). */
export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { query: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {
  constructor(props: { readonly query: string; readonly message?: string }) {
    super({ ...props, message: props.message ?? `no account matches ${JSON.stringify(props.query)}` })
  }
}

/** More than one account matches; the ids tell them apart. */
export class AccountAmbiguous extends Schema.TaggedError<AccountAmbiguous>()(
  "AccountAmbiguous",
  { query: Schema.String, ids: Schema.Array(AccountId), message: Schema.String },
  { httpApiStatus: 409 },
) {
  constructor(props: { readonly query: string; readonly ids: ReadonlyArray<AccountId>; readonly message?: string }) {
    super({
      ...props,
      message:
        props.message ?? `${JSON.stringify(props.query)} matches ${props.ids.length} accounts: ${props.ids.join(", ")}`,
    })
  }
}

/** The account was removed while something was working on it. */
export class AccountGone extends Schema.TaggedError<AccountGone>()(
  "AccountGone",
  { id: AccountId, message: Schema.String },
  { httpApiStatus: 404 },
) {
  constructor(props: { readonly id: AccountId; readonly message?: string }) {
    super({ ...props, message: props.message ?? `the account ${props.id} is gone` })
  }
}

/** Every error slopmax's own API answers with. */
export const ApiErrors = [Unauthorized, NotFound, BadRequest, Conflict, UpstreamFailed, Internal] as const

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

/** Turns a Schema failure into one line for people: each problem's message, after where it is when nested. */
export const issueText = (issue: SchemaIssue.Issue): string =>
  formatter(issue)
    .issues.map(({ message, path }) => {
      const where = (path ?? []).map((key) => (typeof key === "object" ? String(key.key) : String(key))).join(".")
      return where === "" ? message : `${where}: ${message}`
    })
    .join("; ")

/** The first problem's message alone, for a value checked on its own where the path would only repeat its name. */
export const firstIssueText = (issue: SchemaIssue.Issue): string =>
  formatter(issue).issues[0]?.message ?? "invalid value"
