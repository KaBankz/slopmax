// The daemon's reads of each account (`daemon.rs`'s `poll_all`, `poll_one`,
// and `list_credits`): usage polls and reset-credit listings, which the
// daemon runs on its timers and slopmax's own API on request. Apart from
// `daemon.ts`, which imports the proxy to serve it, so the proxy's admin
// API can import these without an import cycle; `daemon.ts` re-exports
// them.
import { Effect } from "effect"

import { log, SignedDuration, Timestamp } from "@slopmax/common"

import type { Account } from "./account.ts"
import { chain } from "./error.ts"
import { AccountState } from "./pool.ts"
import { ProviderId, Spec } from "./provider/mod.ts"
import type { App } from "./proxy/app.ts"
import { poll } from "./usage.ts"

/** How often blocked accounts are re-checked, in case quota frees up early. */
const RECHECK_BLOCKED: SignedDuration = SignedDuration.fromMins(10)
/**
 * How often an account's reset credits are listed again. They change only
 * when one is granted, spent, or expires, which the usage count and the
 * expiry dates already tell.
 */
const LIST_CREDITS_EVERY: SignedDuration = SignedDuration.fromHours(6)
/**
 * How often the credits of a provider whose usage does not count them, as
 * Claude's, are listed: a new one shows within the hour. A failed listing
 * waits as long, since it asks the usage endpoint, which rate-limits.
 */
const LIST_UNCOUNTED_EVERY: SignedDuration = SignedDuration.fromHours(1)
/** How soon a new count from the usage has the credits listed again, at the earliest. */
const LIST_CREDITS_GAP: SignedDuration = SignedDuration.fromMins(10)

/** Polls usage for accounts whose reading is due (or all, with `force`). */
export const pollAll = Effect.fn("daemon.pollAll")(function* (app: App, force: boolean) {
  const now = yield* Timestamp.now
  const interval = SignedDuration.fromMins(Math.max(Number((yield* app.config).pollMins), 1))
  const inner = yield* app.pool.get
  const due = inner.accounts.filter(
    (a) =>
      a.authError === undefined &&
      Spec.isSubscription(ProviderId.spec(a.provider)) &&
      (force || isDue(inner.states.get(a.id) ?? AccountState.empty(), now, interval)),
  )
  yield* Effect.forEach(due, (account) => pollOne(app, account), { concurrency: "unbounded", discard: true })
})

/** Polls one account's usage and records the reading, or the failure. */
export const pollOne = Effect.fn("daemon.pollOne")(function* (app: App, account: Account) {
  const result = yield* Effect.result(poll(app.authHttp, app.store, account, (yield* app.config).refreshTokens))
  if (result._tag === "Failure") {
    log.warn(`${account.id}: usage poll failed: ${chain(result.failure)}`)
    yield* app.pool.recordError(account.id, `usage poll: ${chain(result.failure)}`)
    return
  }
  const [fresh, reading] = result.success
  yield* app.pool.observe(account.id, reading.limits, yield* Timestamp.now)
  const plan = reading.plan
  if (plan !== undefined && plan !== fresh.plan) {
    const saved = yield* Effect.result(app.store.update(fresh.id, (a) => ({ ...a, plan })))
    if (saved._tag === "Failure") log.warn(`${fresh.id}: saving plan: ${chain(saved.failure)}`)
  }
})

/**
 * Lists the reset credits of each account that may have some, when its
 * list is due: never listed, listed `LIST_CREDITS_EVERY` ago, or no longer
 * matching the count its usage reports; or, for a provider whose usage
 * keeps no count, listed `LIST_UNCOUNTED_EVERY` ago. `force` lists them
 * all now.
 */
export const listCredits = Effect.fn("daemon.listCredits")(function* (app: App, force: boolean) {
  const now = yield* Timestamp.now
  for (const account of yield* app.pool.accounts) {
    const credits = ProviderId.get(account.provider).credits()
    if (credits === undefined) continue
    const agent = yield* app.pool.agent(account.provider)
    const state = yield* app.pool.state(account.id)
    const counted = state.limits.resetCredits
    const none = credits.counted && (counted ?? 0) === 0 && AccountState.creditsLeft(state, now) === 0
    if (account.disabled || account.authError !== undefined || none || (credits.needsAgent && agent === undefined)) {
      continue
    }
    const period = credits.counted ? LIST_CREDITS_EVERY : LIST_UNCOUNTED_EVERY
    const list = state.credits
    let due = true
    if (list !== undefined) {
      const age = Timestamp.durationSince(now, list.listedAt)
      due = age >= period || (age >= LIST_CREDITS_GAP && list.counted !== counted)
    }
    if (!force && !due) continue
    const ready = yield* app.ready(account)
    if (ready === undefined) continue
    const listed = yield* Effect.result(credits.list(app.authHttp, ready, agent))
    if (listed._tag === "Success") {
      yield* app.pool.recordCredits(ready.id, listed.success, now)
    } else {
      log.warn(`${ready.id}: listing limit resets: ${chain(listed.failure)}`)
      if (!credits.counted) yield* app.pool.recordCredits(ready.id, AccountState.unexpiredCredits(state, now), now)
    }
  }
})

/**
 * A reading is due when it is stale, when a window has reset since it was
 * taken (so the fresh window is picked up promptly), or periodically while
 * the account is blocked (quota often frees up before the stated reset).
 */
const isDue = (state: AccountState, now: Timestamp, interval: SignedDuration): boolean => {
  const observed = state.limits.observedAt
  if (observed === undefined) return true
  const age = Timestamp.durationSince(now, observed)
  const windowReset = state.limits.windows.some(
    (w) => w.resetsAt !== undefined && w.resetsAt > observed && w.resetsAt <= now,
  )
  return age >= interval || windowReset || (AccountState.isBlocked(state, now) && age >= RECHECK_BLOCKED)
}
