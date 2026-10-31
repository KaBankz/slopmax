// What an account is: who it is at its provider, how its requests are
// signed, and what people set on it. One file each in `accounts/`; the
// `Accounts` service holds them. Kept apart from the service so providers,
// which build accounts when someone signs in, need not load the store.
import {
  AccountAmbiguous,
  AccountId,
  AccountNotFound,
  compareProviders,
  Dialect,
  Instant,
  isSubscription,
  providerFacts,
  ProviderId,
  Secret,
  withDefault,
} from "@slopmax/domain"
import { DateTime, Duration, Effect, Option, Redacted, Schema } from "effect"
import { Digest } from "effect/crypto"
import { FileError, prettyJson } from "./home.ts"

/** The other tool whose copy of a login slopmax follows instead of refreshing it. */
export class Link extends Schema.Class<Link>("Link")({
  tool: Schema.Literal("cliproxyapi"),
  /** That tool's file for the login. */
  path: Schema.String,
}) {}

/** An OAuth sign-in's tokens. */
export class Tokens extends Schema.Class<Tokens>("Tokens")({
  access: Secret,
  refresh: Schema.optionalKey(Secret),
  idToken: Schema.optionalKey(Secret),
  expiresAt: Schema.optionalKey(Instant),
  refreshedAt: Schema.optionalKey(Instant),
}) {
  /** Whether the access token expires within `lead` of `now`. A token with no known expiry never does. */
  expiresWithin(lead: Duration.Duration, now: DateTime.Utc): boolean {
    if (this.expiresAt === undefined) return false
    return DateTime.toEpochMillis(this.expiresAt) - DateTime.toEpochMillis(now) <= Duration.toMillis(lead)
  }

  /** Whether the access token has expired; one expiring this very moment has. */
  isExpired(now: DateTime.Utc): boolean {
    return this.expiresWithin(Duration.zero, now)
  }
}

/** How an account signs its requests: an OAuth sign-in, an API key, or a compatible endpoint. */
export const Credential = Schema.TaggedUnion({
  OAuth: { tokens: Tokens, follows: Schema.optionalKey(Link) },
  Key: { key: Secret },
  Endpoint: {
    /** Request paths are appended to this: `/chat/completions`, `/responses`, `/v1/messages`. */
    baseUrl: Schema.String,
    dialect: Dialect,
    models: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([])), withDefault([])),
    key: Schema.optionalKey(Secret),
  },
})
export type Credential = typeof Credential.Type

/** Who an account is at its provider. */
export class Identity extends Schema.Class<Identity>("Identity")({
  email: Schema.optionalKey(Schema.String),
  /** The ChatGPT workspace, or the Claude account's id. */
  accountId: Schema.optionalKey(Schema.String),
  orgId: Schema.optionalKey(Schema.String),
  orgName: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
}) {}

/**
 * The provider-side identity that tells accounts with separate limits
 * apart: a Claude organization (else account), a ChatGPT workspace, an API
 * key, or an endpoint and its key; else the email; else the refresh token.
 */
export const identityKey = (account: {
  readonly provider: ProviderId
  readonly credential: Credential
  readonly identity: Identity
}): string => {
  const { identity, credential } = account
  const fromProvider = ((): string | undefined => {
    switch (account.provider) {
      case "claude":
        return identity.orgId ?? identity.accountId
      case "codex":
        return identity.accountId
      case "anthropic":
      case "openai":
      case "xai":
        return credential._tag === "Key"
          ? Redacted.value(credential.key)
          : credential._tag === "OAuth"
            ? Redacted.value(credential.tokens.access)
            : undefined
      case "compat":
        return credential._tag === "Endpoint"
          ? `${credential.baseUrl} ${credential.key === undefined ? "" : Redacted.value(credential.key)}`
          : undefined
    }
  })()
  const refresh =
    credential._tag === "OAuth" && credential.tokens.refresh !== undefined
      ? Redacted.value(credential.tokens.refresh)
      : ""
  return fromProvider ?? identity.email ?? refresh
}

const utf8 = new TextEncoder()

/**
 * An account's id: its provider and the first 8 hex digits of the SHA-256 of
 * its identity. Ids name the account files, so they never change.
 */
export const assignId = (provider: ProviderId, identity: string): Effect.Effect<AccountId, never, Digest.Digest> =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest
    const hex = yield* digest.digestHex(Digest.sha256, utf8.encode(identity))
    return AccountId.make(`${provider}-${hex.slice(0, 8)}`)
  })

export class Account extends Schema.Class<Account>("Account")({
  id: AccountId,
  provider: ProviderId,
  credential: Credential,
  identity: Identity.pipe(Schema.withConstructorDefault(Effect.sync(() => new Identity({}))), withDefault({})),
  label: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)), withDefault(false)),
  priority: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0)), withDefault(0)),
  /** Why the sign-in stopped working, until it is signed in again. */
  authError: Schema.optionalKey(Schema.String),
  addedAt: Instant,
}) {
  /**
   * What people call it: the label; else an endpoint's host; else, for API
   * keys, `<provider> key …<last 4>`; else the email (or id) and the
   * organization, unless the organization's name already shows the email.
   */
  get name(): string {
    if (this.label !== undefined) return this.label
    const credential = this.credential
    if (credential._tag === "Endpoint") {
      const afterScheme = credential.baseUrl.split("://").at(-1) ?? ""
      return afterScheme.split("/")[0] ?? afterScheme
    }
    if (!isSubscription(this.provider)) {
      const key = this.secret
      return `${providerFacts[this.provider].title} key …${key.slice(-4)}`
    }
    const email = this.identity.email ?? this.id
    const org = this.identity.orgName
    return org !== undefined && !org.includes(email) ? `${email} (${org})` : email
  }

  /** The secret its requests carry: the access token, the key, or the endpoint's key (empty when it has none). */
  get secret(): string {
    const credential = this.credential
    switch (credential._tag) {
      case "OAuth":
        return Redacted.value(credential.tokens.access)
      case "Key":
        return Redacted.value(credential.key)
      case "Endpoint":
        return credential.key === undefined ? "" : Redacted.value(credential.key)
    }
  }

  /** The OAuth tokens, for accounts that sign in. */
  get tokens(): Option.Option<Tokens> {
    return this.credential._tag === "OAuth" ? Option.some(this.credential.tokens) : Option.none()
  }

  /** Whether its credential expires within `lead` of `now`; keys and endpoints never do. */
  expiresWithin(lead: Duration.Duration, now: DateTime.Utc): boolean {
    return this.credential._tag === "OAuth" && this.credential.tokens.expiresWithin(lead, now)
  }

  /** This sign-in again, keeping what people set on the stored copy: label (unless given anew), disabled, priority, and when it was added. */
  inheriting(old: Account): Account {
    const label = this.label ?? old.label
    return new Account({
      ...this,
      ...(label === undefined ? {} : { label }),
      disabled: old.disabled,
      priority: old.priority,
      addedAt: old.addedAt,
    })
  }
}

/** The same account with its id computed from its identity. */
export const withAssignedId = (account: Account): Effect.Effect<Account, never, Digest.Digest> =>
  Effect.map(assignId(account.provider, identityKey(account)), (id) => new Account({ ...account, id }))

/** The order lists show accounts in: provider, then priority (highest first), then oldest first. */
export const compareAccounts = (a: Account, b: Account): number =>
  compareProviders(a.provider, b.provider) ||
  b.priority - a.priority ||
  DateTime.toEpochMillis(a.addedAt) - DateTime.toEpochMillis(b.addedAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Finds an account the way people name one: a position in the list
 * (`1` is the first), else an exact id, label or email, else the start of
 * one id. A number past the end of the list is matched as any other text,
 * so an account labelled `7` is found among fewer than seven.
 */
export const findAccount = (
  accounts: ReadonlyArray<Account>,
  query: string,
): Effect.Effect<Account, AccountNotFound | AccountAmbiguous> => {
  const text = query.trim()
  const at = /^\d+$/.test(text) && Number(text) > 0 ? accounts[Number(text) - 1] : undefined
  if (at !== undefined) return Effect.succeed(at)
  const exact = accounts.filter(
    (account) => account.id === text || account.label === text || account.identity.email === text,
  )
  const matches = exact.length > 0 ? exact : accounts.filter((account) => account.id.startsWith(text))
  const [only, ...others] = matches
  if (only === undefined || text === "") return Effect.fail(new AccountNotFound({ query }))
  if (others.length > 0) return Effect.fail(new AccountAmbiguous({ query, ids: matches.map((account) => account.id) }))
  return Effect.succeed(only)
}

const encodeAccount = Schema.encodeSync(Account)
const decodeAccount = Schema.decodeUnknownEffect(Schema.fromJsonString(Account))

/** An account file's text. */
export const accountText = (account: Account): string => prettyJson(encodeAccount(account))

/** Reads an account file's text. Fields slopmax does not know are ignored, so newer files still load. */
export const parseAccount = (path: string, text: string): Effect.Effect<Account, FileError> =>
  decodeAccount(text).pipe(Effect.mapError((cause) => new FileError({ path, action: "parse", cause })))
