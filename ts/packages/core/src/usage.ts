// Reads each account's usage windows from its provider's usage endpoint.
import { Effect } from "effect"

import type { Client } from "@slopmax/net"

import type { Account, Store } from "./account.ts"
import { ensureFresh } from "./auth/connect.ts"
import { Failure, text } from "./error.ts"
import { ProviderId, type Reading } from "./provider/mod.ts"

/**
 * Polls one account, refreshing its token first when due (if `refresh` is
 * allowed) and retrying once after a forced refresh if the token is
 * rejected. Returns the possibly refreshed account alongside the reading.
 */
export const poll = Effect.fn("usage.poll")(function* (
  http: Client,
  store: Store,
  account: Account,
  refresh: boolean,
): Effect.fn.Return<readonly [Account, Reading], Failure> {
  let current = account
  if (refresh) current = yield* fresh(http, store, current, false)
  const provider = ProviderId.get(current.provider)
  const first = yield* Effect.result(provider.usage(http, current))
  if (first._tag === "Success") return [current, first.success] as const
  if (first.failure._tag === "Failure") return yield* Effect.fail(first.failure)
  if (!refresh) return yield* Effect.fail(new Failure({ message: "token rejected (refresh disabled)" }))
  current = yield* fresh(http, store, current, true)
  const second = yield* Effect.result(provider.usage(http, current))
  if (second._tag === "Success") return [current, second.success] as const
  if (second.failure._tag === "Failure") return yield* Effect.fail(second.failure)
  return yield* Effect.fail(new Failure({ message: "token rejected after refresh" }))
})

const fresh = (http: Client, store: Store, account: Account, force: boolean): Effect.Effect<Account, Failure> =>
  ensureFresh(http, store, account, force).pipe(
    Effect.mapError((e) => {
      if (e._tag === "Revoked") {
        return new Failure({ message: `${e.reason}; run \`slopmax login ${account.provider}\`` })
      }
      if (e.error instanceof Failure) return e.error
      // The same error as a Failure: its message, then its causes.
      return new Failure({ message: text(e.error), cause: e.error instanceof Error ? e.error.cause : undefined })
    }),
  )
