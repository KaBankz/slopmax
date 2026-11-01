// `GET /v1/models` for OpenAI-style clients: every model a connected
// account offers them, read from each provider and kept a while.
//
// Claude Code and Codex list models through their own provider's API, which
// the proxy forwards; this list is for everything else, so Claude
// subscription models, which serve Claude Code alone, are not on it. The
// configured aliases are listed too, and a client key sees only the models
// it may use.
import { type AccountId, type ClientKey, providerFacts } from "@slopmax/domain"
import { Cache, Context, Data, Duration, Effect, Exit, Layer, Option } from "effect"
import { Accounts } from "../accounts.ts"
import { isWorking, Pool } from "../pool.ts"
import { providers } from "../providers/registry.ts"
import { SettingsService } from "../settings.ts"
import { Upstream } from "../upstream.ts"
import { json } from "./replies.ts"

/** How long an account's list is reused. */
export const listFresh: Duration.Duration = Duration.minutes(10)

/** The Codex release ChatGPT's catalog is asked for until a Codex client says which one it runs. */
export const defaultCodexVersion = "0.159.3"

/** An account's models could not be listed this time; nothing is kept, so the next request asks again. */
class NotListed extends Data.TaggedError("NotListed")<{ readonly message: string }> {}

/** One model in the list. */
export interface ListedModel {
  readonly id: string
  readonly object: "model"
  readonly created: 0
  readonly owned_by: string
}

/**
 * The list body: each model once, sorted, owned by the provider whose
 * listing named it first; then each alias, owned by slopmax; then only what
 * `key` may use.
 */
export const modelList = (
  listings: ReadonlyArray<{ readonly owner: string; readonly models: ReadonlyArray<string> }>,
  aliases: ReadonlyArray<string>,
  key: ClientKey | undefined,
): { readonly object: "list"; readonly data: ReadonlyArray<ListedModel> } => {
  const owners = new Map<string, string>()
  for (const { owner, models } of listings) for (const id of models) if (!owners.has(id)) owners.set(id, owner)
  for (const alias of aliases) if (!owners.has(alias)) owners.set(alias, "slopmax")
  const data = [...owners]
    .filter(([id]) => key === undefined || key.allows(id))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, owner]): ListedModel => ({ id, object: "model", created: 0, owned_by: owner }))
  return { object: "list", data }
}

export interface Shape {
  /** The list, narrowed to what `key` may use when a client key asks. */
  readonly list: (key: ClientKey | undefined) => Effect.Effect<Response>
}

const make = Effect.gen(function* () {
  const accounts = yield* Accounts
  const pool = yield* Pool
  const settings = yield* SettingsService
  const upstream = yield* Upstream

  const lookup = (id: AccountId): Effect.Effect<ReadonlyArray<string>, NotListed> =>
    Effect.gen(function* () {
      const found = yield* accounts.get(id)
      if (Option.isNone(found)) return yield* new NotListed({ message: "it is gone" })
      const account = yield* accounts
        .ready(found.value)
        .pipe(Effect.mapError((error) => new NotListed({ message: error.message })))
      const codexVersion = (yield* pool.model).codex.version ?? defaultCodexVersion
      return yield* providers[account.provider].catalog(account, { codexVersion }).pipe(
        Effect.provideService(Upstream, upstream),
        Effect.mapError((error) => new NotListed({ message: error.message })),
      )
    })

  // A failed listing is let go at once: only lists that came back are kept.
  const catalogs = yield* Cache.makeWith(lookup, {
    capacity: 1024,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? listFresh : Duration.zero),
  })

  const listing = (id: AccountId, owner: string) =>
    Cache.get(catalogs, id).pipe(
      Effect.map((models) => ({ owner, models })),
      Effect.catch((error) =>
        Effect.as(Effect.logWarning(`${id}: listing its models: ${error.message}`), { owner, models: [] }),
      ),
    )

  const list = Effect.fn("Catalog.list")(function* (key: ClientKey | undefined) {
    const listed = (yield* accounts.list).filter(
      (account) => isWorking(account) && providerFacts[account.provider].agentOnly === undefined,
    )
    // Listings are kept in the order they come back, so the first to name a model owns it.
    const done: Array<{ readonly owner: string; readonly models: ReadonlyArray<string> }> = []
    yield* Effect.forEach(
      listed,
      (account) => Effect.map(listing(account.id, account.provider), (result) => void done.push(result)),
      { concurrency: "unbounded", discard: true },
    )
    const aliases = Object.keys((yield* settings.get).aliases)
    return json(200, modelList(done, aliases, key))
  })

  return { list } satisfies Shape
})

/** Model lists, kept per account for ten minutes. */
export class Catalog extends Context.Service<Catalog, Shape>()("@slopmax/core/proxy/Catalog", { make }) {
  static readonly layer: Layer.Layer<Catalog, never, Accounts | Pool | SettingsService | Upstream> = Layer.effect(
    Catalog,
    Catalog.make,
  )
}
