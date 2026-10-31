// Connected accounts and their on-disk store.
//
// Each account lives in its own JSON file under `~/.slopmax/accounts/`,
// written atomically with owner-only permissions. Files are keyed by a hash
// of the provider-side identity (Claude organization, ChatGPT workspace), so
// one email in two organizations stays two accounts with separate limits.

import { Effect, Result, Schema, SchemaGetter, SchemaIssue, type Scope } from "effect"

import { ids, log, SignedDuration, text as texts, Timestamp, TimestampFromString } from "@slopmax/common"
import { DialectSchema } from "@slopmax/wire"

import { context, Failure, lift } from "./error.ts"
import * as fsx from "./fsx.ts"
import * as paths from "./paths.ts"
import { type Home, join } from "./paths.ts"
import { ProviderId, ProviderIdSchema, Spec } from "./provider/mod.ts"
import { list, opt, withDefault } from "./serde.ts"

// `added_at` orders accounts, and Rust's clock counts nanoseconds: accounts
// it adds one after another (an import of several logins) are microseconds
// apart. Timestamps here are milliseconds, so this one keeps the microseconds
// as a fraction (a double holds them exactly at today's dates) and writes them
// back, or those accounts would tie and list in directory order.
const AddedAtSchema: Schema.decodeTo<Schema.Finite, Schema.String> = Schema.String.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transformEffect((text: string, options) =>
      Result.match(Timestamp.parse(text), {
        onSuccess: (t) => Effect.succeed(t + micros(text) / 1_000),
        onFailure: (e) => Effect.fail(new SchemaIssue.InvalidValue({ message: e.message }, text, options)),
      }),
    ),
    encode: SchemaGetter.transform((t: number) => {
      if (Number.isInteger(t)) return Timestamp.display(t)
      const total = Math.round(t * 1_000)
      const us = ((total % 1_000) + 1_000) % 1_000
      const ms = (total - us) / 1_000
      if (us === 0) return Timestamp.display(ms)
      const text = Timestamp.displayMillis(ms).slice(0, -1) + String(us).padStart(3, "0")
      return `${text.replace(/0+$/, "")}Z`
    }),
  }),
)

// The microseconds past the millisecond in RFC 3339 text (0 when it has none).
const micros = (text: string): number => {
  const dot = text.indexOf(".")
  if (dot < 0) return 0
  let n = 0
  let digits = true
  for (let i = 1; i <= 6; i++) {
    const c = text.charCodeAt(dot + i)
    digits &&= c >= 48 && c <= 57
    if (i > 3) n = n * 10 + (digits ? c - 48 : 0)
  }
  return n
}

/** OAuth tokens for one account, or its API key as a token that never expires. */
export const TokensSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: opt(Schema.String),
  /** Codex only: carries the email, plan, and workspace claims. */
  idToken: opt(Schema.String),
  expiresAt: opt(TimestampFromString),
  refreshedAt: opt(TimestampFromString),
}).pipe(
  Schema.encodeKeys({
    accessToken: "access_token",
    refreshToken: "refresh_token",
    idToken: "id_token",
    expiresAt: "expires_at",
    refreshedAt: "refreshed_at",
  }),
)

export type Tokens = typeof TokensSchema.Type

export const Tokens = {
  empty: (): Tokens => ({ accessToken: "" }),

  /** True once the access token is within `lead` of expiring. */
  expiresWithin: (self: Tokens, lead: SignedDuration, now: Timestamp): boolean =>
    self.expiresAt !== undefined && self.expiresAt - now <= lead,

  isExpired: (self: Tokens, now: Timestamp): boolean => Tokens.expiresWithin(self, SignedDuration.ZERO, now),
} as const

/** An OpenAI- or Anthropic-compatible API. */
export const EndpointSchema = Schema.Struct({
  /**
   * Base URL; the request path is appended: `/chat/completions` and
   * `/responses` for OpenAI-style APIs (so it usually ends in `/v1`),
   * `/v1/messages` for Anthropic-style ones.
   */
  baseUrl: Schema.String,
  dialect: DialectSchema,
  /** The models it serves, as patterns where `*` matches anything. */
  models: list(Schema.String),
}).pipe(Schema.encodeKeys({ baseUrl: "base_url" }))

export type Endpoint = typeof EndpointSchema.Type

/** Where a linked account's tokens come from. */
export const LinkSchema = Schema.Struct({
  /** The tool that owns them: `cliproxyapi`. */
  tool: Schema.String,
  /** The file it keeps them in. */
  path: Schema.String,
})

export type Link = typeof LinkSchema.Type

export const AccountSchema = Schema.Struct({
  /** Stable handle, e.g. `claude-1a2b3c4d`. */
  id: Schema.String,
  provider: ProviderIdSchema,
  label: opt(Schema.String),
  email: opt(Schema.String),
  /** Subscription tier as reported by the provider (`max`, `pro`, `plus`...). */
  plan: opt(Schema.String),
  /** Claude account UUID, or the ChatGPT workspace id sent as `chatgpt-account-id`. */
  accountId: opt(Schema.String),
  /** Claude organization UUID; limits are tracked per organization. */
  orgId: opt(Schema.String),
  orgName: opt(Schema.String),
  /** Excluded from routing, but its tokens are still kept fresh. */
  disabled: withDefault(Schema.Boolean, false),
  /** Higher priorities are preferred; ties fall back to the strategy. */
  priority: withDefault(Schema.Int.check(Schema.isBetween({ minimum: -(2 ** 31), maximum: 2 ** 31 - 1 })), 0),
  /** Set when the refresh token is rejected; cleared by a new login. */
  authError: opt(Schema.String),
  tokens: TokensSchema,
  /**
   * Another tool still refreshes these tokens; slopmax follows its file
   * instead of refreshing (see `slopmax own`).
   */
  link: opt(LinkSchema),
  /** A compatible endpoint's address and models. */
  endpoint: opt(EndpointSchema),
  addedAt: AddedAtSchema,
}).pipe(
  Schema.encodeKeys({
    accountId: "account_id",
    orgId: "org_id",
    orgName: "org_name",
    authError: "auth_error",
    addedAt: "added_at",
  }),
)

export type Account = typeof AccountSchema.Type

/** `self` without `key`: how an optional field is cleared. */
export const without = <A extends object, K extends keyof A>(self: A, key: K): Omit<A, K> => {
  const { [key]: _, ...rest } = self
  return rest
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder("utf-8", { fatal: true })

// The last `n` bytes of `s`, or "" when they do not start on a character.
const tailBytes = (s: string, n: number): string => {
  const bytes = utf8.encode(s)
  const tail = bytes.subarray(Math.max(0, bytes.length - n))
  const first = tail[0]
  if (first !== undefined && (first & 0xc0) === 0x80) return ""
  try {
    return fromUtf8.decode(tail)
  } catch {
    return ""
  }
}

export const Account = {
  /** Builds an account added at `now` and derives its id from the provider identity. */
  make: (provider: ProviderId, tokens: Tokens, now: Timestamp): Account =>
    Account.assignId({ id: "", provider, disabled: false, priority: 0, tokens, addedAt: now }),

  /** The provider-side key that distinguishes accounts with separate limits. */
  identityKey: (self: Account): string =>
    ProviderId.get(self.provider).identity(self) ?? self.email ?? self.tokens.refreshToken ?? "",

  /** Recomputes `id` from the identity; call after identity fields change. */
  assignId: (self: Account): Account => {
    const digest = ids.sha256(Account.identityKey(self))
    const hex = Buffer.from(digest.subarray(0, 4)).toString("hex")
    return { ...self, id: `${self.provider}-${hex}` }
  },

  /**
   * Human-friendly name: the label, else email plus organization (or for
   * keys, the endpoint's host or the key's last characters).
   */
  name: (self: Account): string => {
    if (self.label !== undefined) return self.label
    if (self.endpoint !== undefined) {
      const host = self.endpoint.baseUrl.split("://").at(-1) ?? ""
      return host.split("/")[0] ?? host
    }
    const spec = ProviderId.spec(self.provider)
    if (!Spec.isSubscription(spec)) return `${spec.title} key …${tailBytes(self.tokens.accessToken, 4)}`
    const email = self.email ?? self.id
    if (self.orgName !== undefined && !self.orgName.includes(email)) return `${email} (${self.orgName})`
    return email
  },

  /** Keeps user settings from an older record of the same account. */
  inheritSettings: (self: Account, old: Account): Account => {
    const label = self.label ?? old.label
    const base = { ...self, disabled: old.disabled, priority: old.priority, addedAt: old.addedAt }
    return label === undefined ? without(base, "label") : { ...base, label }
  },
} as const

/** Directory-backed account storage. */
export class Store {
  private constructor(readonly dir: string) {}

  /** The accounts of `$SLOPMAX_HOME` (else `~/.slopmax`). */
  static readonly open: Effect.Effect<Store> = Effect.map(paths.accountsDir, (dir) => new Store(dir))

  static at(dir: string): Store {
    return new Store(dir)
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private lockPath(id: string): string {
    return join(this.dir, `.${id}.lock`)
  }

  /** All accounts, ordered by provider, then priority, then age. */
  readonly list = Effect.fn("Store.list")(function* (this: Store): Effect.fn.Return<Array<Account>, Failure> {
    return (yield* this.read(true)).toSorted(
      (a, b) => ProviderId.compare(a.provider, b.provider) || b.priority - a.priority || a.addedAt - b.addedAt,
    )
  })

  private readonly read = Effect.fn("Store.read")(function* (
    this: Store,
    warn: boolean,
  ): Effect.fn.Return<Array<Account>, Failure> {
    const listing = yield* fsx.readDir(this.dir).pipe(
      Effect.map((names): ReadonlyArray<string> | undefined => names),
      Effect.catchIf(
        (e) => e.kind === "NotFound",
        () => Effect.succeed(undefined),
      ),
      context("reading accounts directory"),
    )
    if (listing === undefined) return []
    const accounts: Array<Account> = []
    for (const name of listing) {
      // `Path::extension`: a name such as `.json` alone has none.
      if (!name.endsWith(".json") || name === ".json") continue
      const path = join(this.dir, name)
      const read = yield* Effect.result(fsx.readJson(path, AccountSchema))
      if (read._tag === "Success") {
        if (read.success !== undefined) accounts.push(read.success)
      } else if (warn) {
        log.warn(`skipping ${path}: ${read.failure.message}`)
      }
    }
    return accounts
  })

  readonly get = Effect.fn("Store.get")(function* (
    this: Store,
    id: string,
  ): Effect.fn.Return<Account | undefined, Failure> {
    return yield* fsx.readJson(this.path(id), AccountSchema).pipe(context(`reading account ${id}`))
  })

  /**
   * Writes `account` without locking. Callers that are not refreshing a
   * token should use `update` instead, so they cannot overwrite a token
   * another process just rotated.
   */
  readonly save = Effect.fn("Store.save")(function* (this: Store, account: Account): Effect.fn.Return<void, Failure> {
    yield* fsx.writeJson(this.path(account.id), AccountSchema, account).pipe(context(`saving account ${account.id}`))
  })

  /** Read-modify-write under the account's lock. */
  readonly update = Effect.fn("Store.update")(function* (
    this: Store,
    id: string,
    change: (account: Account) => Account,
  ): Effect.fn.Return<Account, Failure, Scope.Scope> {
    yield* this.lock(id)
    const account = yield* this.get(id)
    if (account === undefined) return yield* Effect.fail(new Failure({ message: `account ${id} no longer exists` }))
    const changed = change(account)
    yield* this.save(changed)
    return changed
  }, Effect.scoped)

  /**
   * Saves a freshly connected account, merging into an existing record of
   * the same identity. Returns the account and whether it is new.
   */
  readonly upsert = Effect.fn("Store.upsert")(function* (
    this: Store,
    account: Account,
  ): Effect.fn.Return<readonly [Account, boolean], Failure, Scope.Scope> {
    let fresh = Account.assignId(account)
    yield* this.lock(fresh.id)
    const existing = yield* this.get(fresh.id)
    if (existing !== undefined) fresh = Account.inheritSettings(fresh, existing)
    else {
      // Accounts added within one millisecond would tie, where Rust's
      // nanoseconds keep them in the order they were added.
      const taken = new Set((yield* this.read(false)).map((a) => a.addedAt))
      let addedAt = fresh.addedAt
      while (taken.has(addedAt)) addedAt += 1
      if (addedAt !== fresh.addedAt) fresh = { ...fresh, addedAt }
    }
    yield* this.save(fresh)
    return [fresh, existing === undefined] as const
  }, Effect.scoped)

  readonly remove = Effect.fn("Store.remove")(function* (this: Store, id: string): Effect.fn.Return<void, Failure> {
    yield* Effect.scoped(
      Effect.andThen(this.lock(id), fsx.removeFile(this.path(id)).pipe(context(`removing account ${id}`))),
    )
    yield* Effect.ignore(fsx.removeFile(this.lockPath(id)))
  })

  /** Takes the cross-process lock that serializes token refreshes for `id`, until the scope ends. */
  readonly lock = Effect.fn("Store.lock")(function* (
    this: Store,
    id: string,
  ): Effect.fn.Return<void, Failure, Scope.Scope> {
    yield* fsx.lock(this.lockPath(id)).pipe(context(`locking account ${id}`))
  })

  /**
   * Resolves a user-supplied reference: an id, id prefix, label, email, or
   * 1-based position in `list`.
   */
  readonly find = Effect.fn("Store.find")(function* (this: Store, query: string): Effect.fn.Return<Account, Failure> {
    const accounts = yield* this.list()
    if (/^\+?\d+$/.test(query)) {
      const n = Number(query.replace("+", ""))
      const account = n >= 1 ? accounts[n - 1] : undefined
      if (account !== undefined) return account
    }
    const exact = accounts.filter((a) => a.id === query || a.label === query || a.email === query)
    const matches = exact.length > 0 ? exact : accounts.filter((a) => a.id.startsWith(query))
    const [only] = matches
    if (matches.length === 1 && only !== undefined) return only
    if (matches.length === 0) {
      return yield* Effect.fail(
        new Failure({ message: `no account matches ${texts.debug(query)} (see \`slopmax status\`)` }),
      )
    }
    return yield* Effect.fail(
      new Failure({ message: `${texts.debug(query)} is ambiguous: ${matches.map((a) => a.id).join(", ")}` }),
    )
  })
}

/** `pins.json`: each provider's pinned account, by id, in provider order. */
export type Pins = Partial<Record<ProviderId, string>>

const isPins = (value: { readonly [key: string]: string }): value is Pins =>
  Object.keys(value).every((key) => ProviderId.parse(key)._tag === "Success")

export const PinsSchema = Schema.Record(Schema.String, Schema.String).pipe(Schema.refine(isPins))

const readPins = (path: string): Effect.Effect<Pins, Failure> =>
  fsx.readJson(path, PinsSchema).pipe(
    Effect.map((pins): Pins => pins ?? {}),
    Effect.mapError(lift),
  )

// A BTreeMap: keys in provider order.
const writePins = (path: string, pins: Pins): Effect.Effect<void, Failure> => {
  const sorted: Pins = {}
  for (const id of ProviderId.ALL) {
    const value = pins[id]
    if (value !== undefined) sorted[id] = value
  }
  return fsx.writeJson(path, PinsSchema, sorted).pipe(Effect.mapError(lift))
}

/** Makes `account` the first choice for its provider's new sessions, for as long as it has quota. */
export const pin = Effect.fn("account.pin")(function* (home: Home, account: Account) {
  const pins = yield* readPins(home.pins())
  yield* writePins(home.pins(), { ...pins, [account.provider]: account.id })
})

/** Lets slopmax choose every provider's accounts again. */
export const unpinAll = (home: Home): Effect.Effect<void, Failure> => writePins(home.pins(), {})

/** Forgets `account`, and its pin with it. */
export const forget = Effect.fn("account.forget")(function* (store: Store, home: Home, account: Account) {
  yield* store.remove(account.id)
  const pins = yield* readPins(home.pins())
  if (pins[account.provider] === account.id) {
    const { [account.provider]: _, ...rest } = pins
    yield* writePins(home.pins(), rest)
  }
})
