// The accounts slopmax pools: one file each in `accounts/`, and a cache in
// memory that every request reads, so no request waits on the disk.
//
// The cache is read from disk again only when it may be stale: under an
// account's lock before a refresh, after a provider refuses a token, and
// when the directory changes (watched, with a rescan every 30 seconds in
// case a change was missed). Another process's sign-in or refresh is
// therefore seen within moments. Writes to one account take its lock and
// re-read the file first, so concurrent updates from the CLI, the API and a
// refresh never lose each other's changes.
import { type AccountAmbiguous, AccountGone, type AccountId, type AccountNotFound, issueText } from "@slopmax/domain"
import { Context, Duration, Effect, Layer, Option, PubSub, Ref, Schedule, Schema, type Scope, Stream } from "effect"
import { Digest } from "effect/crypto"
import { Account, accountText, compareAccounts, findAccount, parseAccount, withAssignedId } from "./account.ts"
import { type FileError, Home } from "./home.ts"
import { Lock, type LockTimeout } from "./lock.ts"
import { makeRefresher, type RefreshRevoked, type RefreshTransient } from "./refresh.ts"
import type { SettingsService } from "./settings.ts"
import type { Upstream } from "./upstream.ts"

export {
  Account,
  accountText,
  assignId,
  compareAccounts,
  Credential,
  findAccount,
  Identity,
  identityKey,
  Link,
  parseAccount,
  Tokens,
  withAssignedId,
} from "./account.ts"

export interface Shape {
  /** Every account, in list order. From memory. */
  readonly list: Effect.Effect<ReadonlyArray<Account>>
  /** One account, from memory. */
  readonly get: (id: AccountId) => Effect.Effect<Option.Option<Account>>
  /** One account read from disk again, into the cache. */
  readonly fresh: (id: AccountId) => Effect.Effect<Option.Option<Account>, FileError>
  /** Reads the directory again; true when anything changed. */
  readonly rescan: Effect.Effect<boolean, FileError>
  /** A signal after every change seen; a slow reader sees the latest only. */
  readonly changes: Stream.Stream<void>
  /** Finds an account by position, id, label, email, or id prefix. */
  readonly find: (query: string) => Effect.Effect<Account, AccountNotFound | AccountAmbiguous>
  /** Saves a sign-in, keeping what people set on an earlier sign-in of the same account. */
  readonly upsert: (
    account: Account,
  ) => Effect.Effect<{ readonly account: Account; readonly isNew: boolean }, FileError | LockTimeout>
  /** Changes one account under its lock, from what is on disk now. */
  readonly update: (
    id: AccountId,
    f: (account: Account) => Account,
  ) => Effect.Effect<Account, AccountGone | FileError | LockTimeout>
  /** Removes one account. */
  readonly remove: (id: AccountId) => Effect.Effect<void, AccountGone | FileError | LockTimeout>
  /** The account with a credential usable now: refreshed or followed when due or forced. */
  readonly ready: (
    account: Account,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<Account, RefreshRevoked | RefreshTransient>
  /** Refreshes every sign-in that is due, reporting each one tried. */
  readonly refreshDue: Effect.Effect<ReadonlyArray<{ readonly id: AccountId; readonly error?: string }>>
  /** Rescans whenever the directory changes, and every 30 seconds, until the scope closes. */
  readonly follow: Effect.Effect<void, never, Scope.Scope>
}

/** One cached account and the text it was read from, to tell when its file changed. */
interface Entry {
  readonly account: Account
  readonly text: string
}

interface State {
  readonly byId: ReadonlyMap<AccountId, Entry>
  readonly sorted: ReadonlyArray<Account>
}

const stateOf = (byId: ReadonlyMap<AccountId, Entry>): State => ({
  byId,
  sorted: [...byId.values()].map((entry) => entry.account).toSorted(compareAccounts),
})

const sameEntries = (a: ReadonlyMap<AccountId, Entry>, b: ReadonlyMap<AccountId, Entry>): boolean =>
  a.size === b.size && [...a].every(([id, entry]) => b.get(id)?.text === entry.text)

const rescanEvery = Duration.seconds(30)

/**
 * Whether an id can name a file in `accounts/`. Ids slopmax assigns always
 * can; one passed in from outside (an API path, a command line) that could
 * reach another file is no account.
 */
const isFileId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)

const make = Effect.gen(function* () {
  const home = yield* Home
  const lock = yield* Lock
  const digest = yield* Digest.Digest
  const dir = home.paths.accounts
  const fileOf = (id: AccountId) => `${dir}/${id}.json`
  const state = yield* Ref.make(stateOf(new Map()))
  const signal = yield* PubSub.sliding<void>(1)
  // Bad files are warned about once per content, not on every rescan.
  const warned = new Map<string, string>()

  const publish = PubSub.publish(signal, undefined)

  /** Applies a change to the cache, signalling when it changed anything. */
  const change = (f: (byId: Map<AccountId, Entry>) => void) =>
    Effect.flatMap(
      Ref.modify(state, (current): [boolean, State] => {
        const next = new Map(current.byId)
        f(next)
        return sameEntries(current.byId, next) ? [false, current] : [true, stateOf(next)]
      }),
      (changed) => (changed ? Effect.as(publish, true) : Effect.succeed(false)),
    )

  const list = Effect.map(Ref.get(state), (current) => current.sorted)

  const get = (id: AccountId) =>
    Effect.map(Ref.get(state), (current) => Option.fromUndefinedOr(current.byId.get(id)?.account))

  const fresh = Effect.fn("Accounts.fresh")(function* (id: AccountId) {
    if (!isFileId(id)) return Option.none<Account>()
    const file = fileOf(id)
    const text = yield* home.readText(file)
    if (Option.isNone(text)) {
      yield* change((byId) => byId.delete(id))
      return Option.none<Account>()
    }
    const account = yield* parseAccount(file, text.value)
    yield* change((byId) => byId.set(account.id, { account, text: text.value }))
    return Option.some(account)
  })

  const rescan = Effect.gen(function* () {
    const names = yield* home.list(dir)
    const current = (yield* Ref.get(state)).byId
    const next = new Map<AccountId, Entry>()
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue
      const file = `${dir}/${name}`
      // A file removed between listing and reading is simply gone.
      const text = yield* home.readText(file)
      if (Option.isNone(text)) continue
      const known = [...current.values()].find((entry) => entry.text === text.value)
      if (known !== undefined) {
        next.set(known.account.id, known)
        continue
      }
      const parsed = yield* Effect.result(parseAccount(file, text.value))
      // A file is read, written and removed by the id inside it, so one
      // renamed by hand would be a second copy no change ever reaches.
      const misnamed = parsed._tag === "Success" && `${parsed.success.id}.json` !== name
      if (parsed._tag === "Failure" || misnamed) {
        if (warned.get(file) !== text.value) {
          warned.set(file, text.value)
          const issue =
            parsed._tag === "Success"
              ? `it holds ${parsed.success.id}, whose file is ${parsed.success.id}.json`
              : Schema.isSchemaError(parsed.failure.cause)
                ? issueText(parsed.failure.cause.issue)
                : parsed.failure.message
          yield* Effect.logWarning(`skipping ${file}: ${issue}`)
        }
        continue
      }
      warned.delete(file)
      next.set(parsed.success.id, { account: parsed.success, text: text.value })
    }
    return yield* change((byId) => {
      byId.clear()
      for (const [id, entry] of next) byId.set(id, entry)
    })
  }).pipe(Effect.withSpan("Accounts.rescan"))

  /** Writes an account and caches it. The caller holds its lock. */
  const save = Effect.fn("Accounts.save")(function* (account: Account) {
    const text = accountText(account)
    yield* home.writeText(fileOf(account.id), text)
    yield* change((byId) => byId.set(account.id, { account, text }))
  })

  const withAccountLock = (id: AccountId) => lock.with(`account-${id}`)

  const upsert = Effect.fn("Accounts.upsert")(function* (given: Account) {
    const account = yield* Effect.provideService(withAssignedId(given), Digest.Digest, digest)
    return yield* withAccountLock(account.id)(
      Effect.gen(function* () {
        const stored = yield* fresh(account.id)
        const merged = Option.match(stored, { onNone: () => account, onSome: (old) => account.inheriting(old) })
        yield* save(merged)
        return { account: merged, isNew: Option.isNone(stored) }
      }),
    )
  })

  const update = Effect.fn("Accounts.update")(function* (id: AccountId, f: (account: Account) => Account) {
    if (!isFileId(id)) return yield* new AccountGone({ id })
    return yield* withAccountLock(id)(
      Effect.gen(function* () {
        const stored = yield* fresh(id)
        if (Option.isNone(stored)) return yield* new AccountGone({ id })
        const next = new Account({ ...f(stored.value), id })
        yield* save(next)
        return next
      }),
    )
  })

  const remove = Effect.fn("Accounts.remove")(function* (id: AccountId) {
    if (!isFileId(id)) return yield* new AccountGone({ id })
    yield* withAccountLock(id)(
      Effect.gen(function* () {
        const removed = yield* home.remove(fileOf(id))
        yield* change((byId) => byId.delete(id))
        if (!removed) return yield* new AccountGone({ id })
      }),
    )
  })

  const find = (query: string) => Effect.flatMap(list, (accounts) => findAccount(accounts, query))

  const refresher = yield* makeRefresher({ fresh, save, list })

  const follow: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    const quietly = Effect.catch(rescan, (error) => Effect.logWarning(error.message))
    yield* home.watchDir(dir).pipe(
      Stream.runForEach(() => quietly),
      Effect.catch((error) => Effect.logWarning(`stopped watching ${dir}: ${error.message}`)),
      Effect.forkScoped,
    )
    yield* quietly.pipe(Effect.repeat(Schedule.spaced(rescanEvery)), Effect.forkScoped)
  })

  yield* rescan

  const shape: Shape = {
    list,
    get,
    fresh,
    rescan,
    changes: Stream.fromPubSub(signal),
    find,
    upsert,
    update,
    remove,
    ready: refresher.ready,
    refreshDue: refresher.refreshDue,
    follow,
  }
  return shape
})

/** The account store. */
export class Accounts extends Context.Service<Accounts, Shape>()("@slopmax/core/Accounts", { make }) {
  static readonly layer: Layer.Layer<Accounts, FileError, Home | Lock | Upstream | SettingsService> = Layer.effect(
    Accounts,
    Accounts.make,
  ).pipe(Layer.provide(Digest.layerWebCrypto))
}
