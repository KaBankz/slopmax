// Keeping sign-ins usable: refreshing OAuth tokens before they expire, and
// following the tokens of logins another tool owns.
//
// A refresh token is single-use: whoever redeems it first gets the next one,
// and every other copy is dead. So a refresh happens once at a time per
// account in this process (every caller joins the one in flight) and across
// processes (under the account's lock, re-reading the file first, so a token
// another process already rotated is reused, not refreshed again). From the
// token POST until the new tokens are saved nothing may interrupt it, or the
// account would be signed out by its own refresh.
//
// A login imported from CLIProxyAPI keeps being refreshed by CLIProxyAPI.
// slopmax follows that tool's file instead of refreshing, which would sign
// the tool out, until `slopmax own` hands the login to slopmax.
import { type AccountId, type Limits, parseInstant, providerFacts } from "@slopmax/domain"
import { DateTime, Effect, Equal, Fiber, FiberMap, Option, Redacted, Schema, type Scope } from "effect"
import { RateLimiter } from "effect/persistence"
import { Account, Credential, type Link, Tokens } from "./account.ts"
import { Home, type FileError } from "./home.ts"
import { Lock } from "./lock.ts"
import { jwtExpiry } from "./providers/oauth.ts"
import {
  type Grant,
  present,
  ProviderFailed,
  RefreshRevoked,
  RefreshTransient,
  tokensOf,
} from "./providers/provider.ts"
import { providerOf } from "./providers/registry.ts"
import { SettingsService } from "./settings.ts"
import { Upstream } from "./upstream.ts"

export { RefreshRevoked, RefreshTransient } from "./providers/provider.ts"

// ---------------------------------------------------------------------------
// Logins another tool owns

/** A CLIProxyAPI login file. Only the fields slopmax uses are read; the rest are left alone. */
export const CliProxyApiLogin = Schema.Struct({
  type: Schema.String,
  access_token: Schema.optional(Schema.NullOr(Schema.String)),
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  id_token: Schema.optional(Schema.NullOr(Schema.String)),
  /** When the access token expires, as RFC 3339. */
  expired: Schema.optional(Schema.NullOr(Schema.String)),
  last_refresh: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  account_uuid: Schema.optional(Schema.NullOr(Schema.String)),
  organization_uuid: Schema.optional(Schema.NullOr(Schema.String)),
  organization_name: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  disabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** A number, or a number written as text. */
  priority: Schema.optional(Schema.Unknown),
})
export type CliProxyApiLogin = typeof CliProxyApiLogin.Type

/** A CLIProxyAPI login file's text, read; none when it is not one. */
export const parseCliProxyApiLogin: (text: string) => Option.Option<CliProxyApiLogin> = Schema.decodeUnknownOption(
  Schema.fromJsonString(CliProxyApiLogin),
)

/**
 * Tokens as another tool's login file writes them. The access token's own
 * expiry wins over the file's `expired`; empty refresh and id tokens are absent.
 */
export const savedTokens = (saved: {
  readonly access: string
  readonly refresh?: string | null | undefined
  readonly idToken?: string | null | undefined
  readonly expired?: string | null | undefined
  readonly lastRefresh?: string | null | undefined
}): Tokens => {
  const expiresAt = Option.orElse(jwtExpiry(saved.access), () =>
    present(saved.expired) ? parseInstant(saved.expired) : Option.none(),
  )
  const refreshedAt = present(saved.lastRefresh) ? parseInstant(saved.lastRefresh) : Option.none()
  return new Tokens({
    access: Redacted.make(saved.access),
    ...(present(saved.refresh) ? { refresh: Redacted.make(saved.refresh) } : {}),
    ...(present(saved.idToken) ? { idToken: Redacted.make(saved.idToken) } : {}),
    ...(Option.isSome(expiresAt) ? { expiresAt: expiresAt.value } : {}),
    ...(Option.isSome(refreshedAt) ? { refreshedAt: refreshedAt.value } : {}),
  })
}

/** The tokens a CLIProxyAPI login holds; none without an access token. */
export const cliProxyApiTokens = (login: CliProxyApiLogin): Option.Option<Tokens> =>
  present(login.access_token)
    ? Option.some(
        savedTokens({
          access: login.access_token,
          refresh: login.refresh_token,
          idToken: login.id_token,
          expired: login.expired,
          lastRefresh: login.last_refresh,
        }),
      )
    : Option.none()

/** The tokens a linked login's source holds right now. */
export const linkedTokens = (link: Link): Effect.Effect<Tokens, RefreshTransient, Home> =>
  Effect.gen(function* () {
    const home = yield* Home
    const text = yield* home
      .readText(link.path)
      .pipe(Effect.mapError((error) => new RefreshTransient({ message: error.message })))
    if (Option.isNone(text)) return yield* new RefreshTransient({ message: `${link.path} is gone` })
    const login = parseCliProxyApiLogin(text.value)
    if (Option.isNone(login)) return yield* new RefreshTransient({ message: `${link.path} is not a login` })
    return yield* Option.match(cliProxyApiTokens(login.value), {
      onNone: () => Effect.fail(new RefreshTransient({ message: `${link.path} has no access token` })),
      onSome: Effect.succeed,
    })
  })

// ---------------------------------------------------------------------------
// The refresher

/** What a refresher needs from the account store. */
export interface RefreshStore {
  /** The account as stored now, read from disk into the cache. */
  readonly fresh: (id: AccountId) => Effect.Effect<Option.Option<Account>, FileError>
  /** Saves an account without taking its lock (the refresher already holds it). */
  readonly save: (account: Account) => Effect.Effect<void, FileError>
  /** Every account, from the cache. */
  readonly list: Effect.Effect<ReadonlyArray<Account>>
}

export interface Refresher {
  /**
   * The account with a credential usable now: refreshed or followed when due,
   * or when forced. A refresh that fails in passing while the token still
   * works hands back the current token, with a warning.
   */
  readonly ready: (
    account: Account,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<Account, RefreshRevoked | RefreshTransient>
  /** Refreshes every sign-in that is due, one at a time, reporting each one tried. */
  readonly refreshDue: Effect.Effect<ReadonlyArray<{ readonly id: AccountId; readonly error?: string }>>
}

const accessOf = (account: Account): string => account.secret

const withoutAuthError = (account: Account): Account => {
  const { authError: _cleared, ...rest } = account
  return new Account(rest)
}

/** The account with a grant's tokens. Tokens the provider did not rotate are kept; the expiry is the grant's. */
export const applyGrant = (account: Account, grant: Grant, now: DateTime.Utc): Account => {
  const old = Option.getOrUndefined(account.tokens)
  const fresh = tokensOf(grant, now)
  const refresh = fresh.refresh ?? old?.refresh
  const idToken = fresh.idToken ?? old?.idToken
  const tokens = new Tokens({
    ...fresh,
    ...(refresh === undefined ? {} : { refresh }),
    ...(idToken === undefined ? {} : { idToken }),
  })
  return withoutAuthError(new Account({ ...account, credential: Credential.cases.OAuth.make({ tokens }) }))
}

const passing = (error: { readonly message: string }) => new RefreshTransient({ message: error.message })

/** Whether the account's token is due: forced, or within its provider's lead of expiring. */
const due = (account: Account, force: boolean, now: DateTime.Utc) =>
  force || account.expiresWithin(providerFacts[account.provider].refreshLead, now)

const expired = (account: Account, now: DateTime.Utc) =>
  Option.exists(account.tokens, (tokens) => tokens.isExpired(now))

/** Saves a refreshed account; a failed save is logged, and the fresh tokens are still handed out. */
const savingQuietly = (store: RefreshStore) => (account: Account) =>
  store
    .save(account)
    .pipe(Effect.catch((error) => Effect.logError(`refreshed ${account.id} but could not save it: ${error.message}`)))

/** The cache's copy of an account, which may be newer than the caller's. */
const cachedIn = (store: RefreshStore) => (account: Account) =>
  Effect.map(store.list, (accounts) => accounts.find((found) => found.id === account.id) ?? account)

/** How often a token may be forced to refresh, per account: a provider refusing each new token cannot spin. */
const forcedLimit = { limit: 3, window: "1 minute" } as const

/** Builds the refresher over the store, in the `Accounts` layer's scope. */
export const makeRefresher = (
  store: RefreshStore,
): Effect.Effect<Refresher, never, Home | Lock | Upstream | SettingsService | Scope.Scope> =>
  Effect.gen(function* () {
    const home = yield* Home
    const lock = yield* Lock
    const upstream = yield* Upstream
    const settings = yield* SettingsService
    const rotations = yield* FiberMap.make<AccountId, Account, RefreshRevoked | RefreshTransient>()
    // Starts rotations as fibers of the map's own, so a caller hanging up does not stop one.
    const startRotation = yield* FiberMap.runtime(rotations)()
    const limiter = yield* Effect.provide(RateLimiter.make, RateLimiter.layerStoreMemory)

    const saveQuietly = savingQuietly(store)
    const cached = cachedIn(store)

    /** One rotation of an account's tokens, under its lock. */
    const rotate = (given: Account, force: boolean): Effect.Effect<Account, RefreshRevoked | RefreshTransient> =>
      lock
        .with(`account-${given.id}`)(
          Effect.gen(function* () {
            // Another process may have rotated the token, or extended it, while this one waited.
            const stored = Option.getOrElse(yield* store.fresh(given.id), () => given)
            if (accessOf(stored) !== accessOf(given) || !due(stored, force, yield* DateTime.now)) return stored
            const refreshToken = Option.flatMap(stored.tokens, (tokens) => Option.fromUndefinedOr(tokens.refresh))
            if (Option.isNone(refreshToken)) return yield* new RefreshRevoked({ reason: "no refresh token stored" })
            const provider = providerOf(stored)
            // From the token POST to the save, nothing may interrupt: the old refresh token is spent.
            const rotated = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const grant = yield* provider
                  .refresh(stored)
                  .pipe(
                    Effect.tapError((error) =>
                      error._tag === "RefreshRevoked"
                        ? store.save(new Account({ ...stored, authError: error.reason })).pipe(Effect.ignore)
                        : Effect.void,
                    ),
                  )
                const next = applyGrant(stored, grant, yield* DateTime.now)
                yield* saveQuietly(next)
                return next
              }),
            )
            const identified = yield* provider.identify(rotated)
            if (!Equal.equals(identified.identity, rotated.identity)) yield* saveQuietly(identified)
            return identified
          }),
        )
        .pipe(
          Effect.provideService(Upstream, upstream),
          Effect.catchTags({
            FileError: (error) => Effect.fail(passing(error)),
            LockTimeout: (error) => Effect.fail(passing(error)),
          }),
          Effect.withSpan("refresh.rotate", { attributes: { account: given.id } }),
        )

    /** Adopts the tokens a linked login's source rotated, since refreshing here would sign that tool out. */
    const follow = (current: Account, link: Link, force: boolean) =>
      Effect.gen(function* () {
        const tokens = yield* linkedTokens(link).pipe(Effect.provideService(Home, home))
        const followed = yield* lock
          .with(`account-${current.id}`)(
            Effect.gen(function* () {
              const stored = yield* store.fresh(current.id)
              if (Option.isNone(stored)) return Option.none<Account>()
              if (accessOf(stored.value) === Redacted.value(tokens.access)) return stored
              const next = withoutAuthError(
                new Account({ ...stored.value, credential: Credential.cases.OAuth.make({ tokens, follows: link }) }),
              )
              yield* store.save(next)
              return Option.some(next)
            }),
          )
          .pipe(
            Effect.catchTags({
              FileError: (error) => Effect.fail(passing(error)),
              LockTimeout: (error) => Effect.fail(passing(error)),
            }),
          )
        const result = Option.getOrElse(followed, () => current)
        const rotated = accessOf(result) !== accessOf(current)
        if (!rotated && (force || expired(result, yield* DateTime.now))) {
          return yield* new RefreshTransient({
            message: `${link.tool} has not refreshed this login yet (\`slopmax own\` lets slopmax refresh it)`,
          })
        }
        return result
      })

    /** The account made usable, failing on anything that went wrong. */
    const strict = (given: Account, force: boolean): Effect.Effect<Account, RefreshRevoked | RefreshTransient> =>
      Effect.gen(function* () {
        const current = yield* cached(given)
        if (current.authError !== undefined) return yield* new RefreshRevoked({ reason: current.authError })
        if (current.credential._tag !== "OAuth") {
          if (!force) return current
          return yield* new RefreshRevoked({
            reason: `${providerFacts[current.provider].title} keys cannot be refreshed`,
          })
        }
        if (!due(current, force, yield* DateTime.now)) return current
        const link = current.credential.follows
        // Following is read-only, so it happens even with refreshing turned off.
        if (link !== undefined) return yield* follow(current, link, force)
        if (!(yield* settings.get).refreshTokens) {
          if (!force) return current
          return yield* new RefreshTransient({
            message: "the token was rejected and refreshing is turned off (refreshTokens)",
          })
        }
        if (force) {
          yield* limiter
            .consume({ key: `refresh:${current.id}`, onExceeded: "fail", ...forcedLimit })
            .pipe(
              Effect.mapError(
                () => new RefreshTransient({ message: "refreshed too often; waiting before the next try" }),
              ),
            )
        }
        // Every caller joins the one rotation in flight. Finding it and starting one happen in one
        // synchronous step, so two callers can never both start one.
        const fiber = yield* Effect.sync(() =>
          Option.getOrElse(FiberMap.getUnsafe(rotations, current.id), () =>
            startRotation(current.id, rotate(current, force)),
          ),
        )
        return yield* Fiber.join(fiber)
      })

    const ready = Effect.fn("Accounts.ready")(function* (given: Account, options?: { readonly force?: boolean }) {
      const force = options?.force === true
      return yield* strict(given, force).pipe(
        Effect.catchTag("RefreshTransient", (error) =>
          Effect.gen(function* () {
            const current = yield* cached(given)
            if (force || current.credential._tag !== "OAuth" || expired(current, yield* DateTime.now)) {
              return yield* error
            }
            yield* Effect.logWarning(`${current.id}: refresh failed, using current token: ${error.message}`)
            return current
          }),
        ),
      )
    })

    const refreshDue = Effect.gen(function* () {
      if (!(yield* settings.get).refreshTokens) return []
      const now = yield* DateTime.now
      const tried: Array<{ readonly id: AccountId; readonly error?: string }> = []
      for (const account of yield* store.list) {
        if (account.authError !== undefined || account.credential._tag !== "OAuth" || !due(account, false, now))
          continue
        const result = yield* Effect.result(strict(account, false))
        if (result._tag === "Success") {
          tried.push({ id: account.id })
          continue
        }
        yield* Effect.logWarning(`${account.id}: ${result.failure.message}`)
        tried.push({ id: account.id, error: result.failure.message })
      }
      return tried
    }).pipe(Effect.withSpan("Accounts.refreshDue"))

    return { ready, refreshDue }
  })

// ---------------------------------------------------------------------------
// Polling one account's usage

/** What a failed refresh means for a usage poll, in words that say how to fix it. */
const pollError = (account: Account) => (error: RefreshRevoked | RefreshTransient) =>
  new ProviderFailed({
    message:
      error._tag === "RefreshRevoked" ? `${error.reason}; run \`slopmax login ${account.provider}\`` : error.message,
  })

/**
 * Reads an account's usage windows. With `refresh`, a due token is refreshed
 * first, and a rejected one is refreshed once and the read tried again.
 * Gives the account as it ended up (refreshes are saved as they happen) with
 * the reading.
 */
export const pollUsage = (
  ready: Refresher["ready"],
  account: Account,
  options: { readonly refresh: boolean },
): Effect.Effect<{ readonly account: Account; readonly limits: Limits }, ProviderFailed, Upstream> =>
  Effect.gen(function* () {
    const provider = providerOf(account)
    if (Option.isNone(provider.usage)) {
      return yield* new ProviderFailed({ message: `${provider.title} has no usage windows` })
    }
    const read = provider.usage.value
    const current = options.refresh ? yield* ready(account).pipe(Effect.mapError(pollError(account))) : account
    const first = yield* Effect.result(read(current))
    if (first._tag === "Success") return { account: current, limits: first.success }
    if (first.failure._tag === "ProviderFailed") return yield* first.failure
    if (!options.refresh) return yield* new ProviderFailed({ message: "token rejected (refresh disabled)" })
    const refreshed = yield* ready(current, { force: true }).pipe(Effect.mapError(pollError(account)))
    const second = yield* read(refreshed).pipe(
      Effect.catchTag("ProviderUnauthorized", () =>
        Effect.fail(new ProviderFailed({ message: "token rejected after refresh" })),
      ),
    )
    return { account: refreshed, limits: second }
  }).pipe(Effect.withSpan("refresh.pollUsage", { attributes: { account: account.id } }))
