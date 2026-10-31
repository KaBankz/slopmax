// Banked rate-limit resets.
//
// Some providers grant accounts credits that reset their usage windows on
// the spot. slopmax redeems them on request (`slopmax redeem`), just before
// one would expire unused (`redeem_expiring_credits`), and, with
// `redeem_when_exhausted`, once every account of the provider is spent, so
// the pool keeps serving instead of waiting.
import type { Effect } from "effect"
import { Schema } from "effect"

import { TimestampFromString } from "@slopmax/common"
import type { Client } from "@slopmax/net"

import type { Account } from "../account.ts"
import type { Failure } from "../error.ts"
import { opt } from "../serde.ts"

/** One unspent credit. */
export const CreditSchema = Schema.Struct({
  id: Schema.String,
  title: opt(Schema.String),
  /** When the provider granted it. */
  grantedAt: opt(TimestampFromString),
  expiresAt: opt(TimestampFromString),
}).pipe(Schema.encodeKeys({ grantedAt: "granted_at", expiresAt: "expires_at" }))

export type Credit = typeof CreditSchema.Type

/** What a redemption did, in snake_case on the wire. */
export const OutcomeSchema = Schema.Literals([
  /** The account's windows were reset. */
  "reset",
  /** Nothing was used, so the credit was kept. */
  "nothing_to_reset",
  "no_credit",
  "already_redeemed",
  /**
   * The provider would not spend one now, as while it is paused or cooling
   * down, so the credit was kept.
   */
  "declined",
])

export type Outcome = typeof OutcomeSchema.Type

/**
 * A provider's reset credits.
 *
 * `agent` is the user agent of the provider's own client, as slopmax last
 * saw it in a request, for a provider that answers that client alone.
 */
export interface ResetCredits {
  /**
   * Whether the provider's usage reports how many credits an account holds,
   * so they are listed as that count changes. Those of a provider whose
   * usage does not are listed every hour instead. (Default true.)
   */
  readonly counted: boolean

  /**
   * Whether it answers its own client alone, so nothing can be listed or
   * redeemed until slopmax has seen that client's user agent. (Default false.)
   */
  readonly needsAgent: boolean

  /**
   * Unspent credits, in the order to spend them: soonest-expiring first, or
   * the one the provider names next.
   */
  list(http: Client, account: Account, agent: string | undefined): Effect.Effect<ReadonlyArray<Credit>, Failure>

  /** Redeems `credit`, or the one the provider would spend next. */
  redeem(
    http: Client,
    account: Account,
    agent: string | undefined,
    credit: string | undefined,
  ): Effect.Effect<Outcome, Failure>
}

/** What a provider's credits must say for themselves; `counted` and `needsAgent` default to true and false. */
export type ResetCreditsParts = Pick<ResetCredits, "list" | "redeem"> &
  Partial<Pick<ResetCredits, "counted" | "needsAgent">>

/** Reset credits from their parts, with the trait's defaults. */
export const defineResetCredits = (parts: ResetCreditsParts): ResetCredits => ({
  counted: true,
  needsAgent: false,
  ...parts,
})
