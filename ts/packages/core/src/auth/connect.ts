// Connecting an account, and keeping its token fresh: the parts of signing
// in that go through the provider registry (`auth/mod.rs` in the Rust).
import { Effect, Fiber } from "effect"

import { log, Timestamp } from "@slopmax/common"
import { type Client, Origins } from "@slopmax/net"

import { type Account, type Store, Tokens, without } from "../account.ts"
import { chain, Failure } from "../error.ts"
import { linkedTokens } from "../import.ts"
import { ProviderId } from "../provider/mod.ts"
import { Grant, httpClient, type LoginOptions, type Prompt, type RefreshError, Revoked, transient } from "./mod.ts"

/**
 * Signs in to `provider` and saves the account, merging it into an earlier
 * record of the same identity. Returns the account and whether it is new.
 */
export const connect = Effect.fn("auth.connect")(function* (
  store: Store,
  provider: ProviderId,
  label: string | undefined,
  options: LoginOptions,
  prompt: Prompt,
): Effect.fn.Return<readonly [Account, boolean], Failure> {
  const http = yield* httpClient(new Origins())
  const account = yield* ProviderId.get(provider).login(http, options, prompt)
  return yield* store.upsert(label === undefined ? account : { ...account, label })
})

/**
 * Returns `account` with a usable access token, refreshing it when it is
 * within the provider's refresh lead (or always, with `force`).
 *
 * Refreshes are serialized across slopmax processes with the account's lock
 * file. The stored copy is re-read under the lock so a token another process
 * already rotated is reused rather than refreshed twice. The refresh runs in
 * a detached fiber: once a single-use refresh token is sent, the new tokens
 * must be persisted even if the caller goes away.
 */
export const ensureFresh = Effect.fn("auth.ensureFresh")(function* (
  http: Client,
  store: Store,
  account: Account,
  force: boolean,
): Effect.fn.Return<Account, RefreshError> {
  const now = yield* Timestamp.now
  const due = (a: Account): boolean =>
    force || Tokens.expiresWithin(a.tokens, ProviderId.spec(a.provider).refreshLead, now)
  if (!due(account)) return account
  if (account.link !== undefined) return yield* follow(store, account, force)
  const task: Effect.Effect<Account, RefreshError> = Effect.scoped(
    Effect.gen(function* () {
      yield* store.lock(account.id).pipe(Effect.mapError(transient))
      const current = (yield* store.get(account.id).pipe(Effect.mapError(transient))) ?? account
      const rotatedElsewhere = current.tokens.accessToken !== account.tokens.accessToken
      if (rotatedElsewhere || !due(current)) return current
      return yield* refreshAndSave(http, store, current)
    }),
  )
  const fiber = yield* Effect.forkDetach(task)
  return yield* Fiber.join(fiber)
})

/**
 * For a linked account: adopts the tokens its source tool rotated, since
 * refreshing here would sign that tool out.
 */
const follow = Effect.fn("auth.follow")(function* (
  store: Store,
  account: Account,
  force: boolean,
): Effect.fn.Return<Account, RefreshError> {
  const link = account.link
  if (link === undefined) return yield* Effect.die("only linked accounts are followed")
  const followed = yield* Effect.scoped(
    Effect.gen(function* () {
      const tokens = yield* linkedTokens(link)
      yield* store.lock(account.id)
      const current = yield* store.get(account.id)
      if (current === undefined) return undefined
      if (current.tokens.accessToken === tokens.accessToken) return current
      const adopted: Account = { ...without(current, "authError"), tokens }
      yield* store.save(adopted)
      return adopted
    }),
  ).pipe(Effect.mapError(transient))
  const current = followed ?? account
  const rotated = current.tokens.accessToken !== account.tokens.accessToken
  if (!rotated && (force || Tokens.isExpired(current.tokens, yield* Timestamp.now))) {
    return yield* Effect.fail(
      transient(
        new Failure({
          message: `${link.tool} has not refreshed this login yet (\`slopmax own\` lets slopmax refresh it)`,
        }),
      ),
    )
  }
  return current
})

const refreshAndSave = Effect.fn("auth.refreshAndSave")(function* (
  http: Client,
  store: Store,
  stale: Account,
): Effect.fn.Return<Account, RefreshError> {
  const refreshToken = stale.tokens.refreshToken
  if (refreshToken === undefined) return yield* Effect.fail(new Revoked({ reason: "no refresh token stored" }))
  const provider = ProviderId.get(stale.provider)
  const grant = yield* provider
    .refresh(http, refreshToken)
    .pipe(
      Effect.tapError((err) =>
        err._tag === "Revoked" ? Effect.ignore(store.save({ ...stale, authError: err.reason })) : Effect.void,
      ),
    )

  const tokens = Grant.intoTokens(grant, yield* Timestamp.now)
  // Providers may omit tokens that did not rotate.
  const idToken = tokens.idToken ?? stale.tokens.idToken
  let account: Account = {
    ...without(stale, "authError"),
    tokens: {
      ...tokens,
      refreshToken: tokens.refreshToken ?? refreshToken,
      ...(idToken === undefined ? {} : { idToken }),
    },
  }

  account = yield* provider.identify(http, account)
  // Persist before anyone uses the new token: the old refresh token is dead.
  yield* store
    .save(account)
    .pipe(
      Effect.catch((e) => Effect.sync(() => log.error(`refreshed ${account.id} but could not save it: ${chain(e)}`))),
    )
  return account
})
