// The status report: every account, how it stands, and each subscription's
// accounts read as one pool. The engine builds it; `slopmax status`, the
// dashboard, the desktop window and its menu bar all read the same one, so
// they never disagree about an account.
import { DateTime, Option, Schema } from "effect"
import { AccountId, Instant, NonNegativeInt, ProviderId, Strategy } from "./ids.ts"
import { Usage } from "./ledger.ts"
import { LimitReset, PoolWindow, Window } from "./limits.ts"
import { Notice } from "./notice.ts"

/** Where an account stands, most pressing first. */
export const Condition = Schema.TaggedUnion({
  /** Its sign-in stopped working; only signing in again fixes it. */
  SignInNeeded: { error: Schema.String },
  Disabled: {},
  /** Out of quota until then. */
  Limited: { until: Instant },
  /** Briefly held back by the provider. */
  Throttled: { until: Schema.optionalKey(Instant) },
  /** Serving this many sessions. */
  Active: { sessions: Schema.Int },
  Ready: {},
})
export type Condition = typeof Condition.Type

/** A note beside an account's condition. */
export const Note = Schema.TaggedUnion({
  /** Chosen with `slopmax use` for new sessions. */
  Pinned: {},
  Priority: { value: Schema.Int },
  /** The tool whose copy of the tokens slopmax follows. */
  Follows: { tool: Schema.String },
  /** Limit resets the account holds. */
  Resets: { count: Schema.Int },
  /** Requests served since slopmax started, and their tokens. */
  Served: { requests: Schema.Int, tokens: Schema.Int },
  LastError: { text: Schema.String },
})
export type Note = typeof Note.Type

/** How a front end colors a condition, a note, or a window's use, so every one colors them alike. */
export const Tone = Schema.Literals(["good", "muted", "accent", "warn", "bad"])
export type Tone = typeof Tone.Type

export class AccountView extends Schema.Class<AccountView>("AccountView")({
  id: AccountId,
  provider: ProviderId,
  /** Its label, else its email, else its id. */
  name: Schema.String,
  email: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean,
  priority: Schema.Int,
  pinned: Schema.Boolean,
  /** The tool whose copy of the tokens slopmax follows. */
  follows: Schema.optionalKey(Schema.String),
  tokenExpiresAt: Schema.optionalKey(Instant),
  /** For keys and endpoints: where requests go. */
  endpoint: Schema.optionalKey(Schema.String),
  /** For keys and endpoints: the models served, as patterns. */
  models: Schema.Array(Schema.String),
  sessions: NonNegativeInt,
  condition: Condition,
  notes: Schema.Array(Note),
  windows: Schema.Array(Window),
  /** Limit resets it holds, soonest to expire first. */
  resets: Schema.Array(LimitReset),
  lastUsed: Schema.optionalKey(Instant),
  served: Usage,
}) {}

/** Why a new session would get an account. */
export const NextReason = Schema.Literals([
  /** Chosen with `slopmax use`. */
  "pinned",
  /** No other account of the provider can serve. */
  "only-one",
  /** Its week resets within the day with quota to spare (reset-first). */
  "week-ending",
  /** Its used quota resets soonest (reset-first). */
  "resets-first",
  /** First in priority order (fill-first). */
  "fills-first",
  /** The most room left (least-used, or reset-first among idle accounts). */
  "most-room",
  /** Handed a request longest ago (round-robin). */
  "turn",
])
export type NextReason = typeof NextReason.Type

/** The account a new session would get now, and why, worded for people. */
export class NextView extends Schema.Class<NextView>("NextView")({
  account: AccountId,
  reason: NextReason,
  why: Schema.String,
}) {}

/** A subscription's working accounts (enabled and signed in) read as one. */
export class PoolView extends Schema.Class<PoolView>("PoolView")({
  provider: ProviderId,
  accounts: NonNegativeInt,
  /** The windows over every request. */
  windows: Schema.Array(PoolWindow),
  /** Windows for one model (a weekly cap on one Claude model), which stop only that model's requests. */
  scoped: Schema.Array(Window),
  /** Each account's share of the pool's capacity, when every plan's size is known. */
  shares: Schema.Record(AccountId, Schema.Number),
  next: Schema.optionalKey(NextView),
}) {}

export class Report extends Schema.Class<Report>("Report")({
  /** The version of the slopmax that built it. */
  version: Schema.String,
  /** From a running proxy, with its live sessions, rather than read from disk. */
  live: Schema.Boolean,
  generatedAt: Instant,
  strategy: Strategy,
  accounts: Schema.Array(AccountView),
  pools: Schema.Array(PoolView),
  /** What is worth doing before it is lost: resets about to lapse, weeks about to reset with quota to spare. */
  nudges: Schema.Array(Notice),
}) {}

export const RedeemOutcome = Schema.Literals(["reset", "nothing-to-reset", "no-credit", "already-redeemed", "declined"])
export type RedeemOutcome = typeof RedeemOutcome.Type

export class RedeemResult extends Schema.Class<RedeemResult>("RedeemResult")({
  outcome: RedeemOutcome,
  report: Report,
}) {}

/** What decides an account's condition. */
export interface ConditionInput {
  readonly authError?: string | undefined
  readonly disabled: boolean
  /** When a block or a full window lets it serve again, if it is limited now. */
  readonly limitedUntil: Option.Option<DateTime.Utc>
  readonly throttledUntil?: DateTime.Utc | undefined
  readonly sessions: number
}

/** The most pressing thing about an account: sign-in, then disabled, limited, throttled, busy, ready. */
export const conditionOf = (input: ConditionInput, now: DateTime.Utc): Condition => {
  if (input.authError !== undefined) return Condition.cases.SignInNeeded.make({ error: input.authError })
  if (input.disabled) return Condition.cases.Disabled.make({})
  if (Option.isSome(input.limitedUntil)) return Condition.cases.Limited.make({ until: input.limitedUntil.value })
  const throttled = input.throttledUntil
  if (throttled !== undefined && DateTime.isGreaterThan(throttled, now)) {
    return Condition.cases.Throttled.make({ until: throttled })
  }
  if (input.sessions > 0) return Condition.cases.Active.make({ sessions: input.sessions })
  return Condition.cases.Ready.make({})
}

const conditionTones: { readonly [K in Condition["_tag"]]: Tone } = {
  SignInNeeded: "bad",
  Disabled: "muted",
  Limited: "warn",
  Throttled: "warn",
  Active: "good",
  Ready: "good",
}

export const conditionTone = (condition: Condition): Tone => conditionTones[condition._tag]

/** What the notes beside an account are made from. */
export interface NotesInput {
  readonly pinned: boolean
  readonly priority: number
  readonly follows?: string | undefined
  /** Unexpired limit resets it holds. */
  readonly resets: number
  readonly served: Usage
  readonly lastError?: string | undefined
  readonly condition: Condition
}

/**
 * The notes beside an account's condition, in the order front ends show
 * them. The last error is left out when the condition already explains it
 * (signed out, or limited).
 */
export const notesOf = (input: NotesInput): ReadonlyArray<Note> => {
  const notes: Array<Note> = []
  if (input.pinned) notes.push(Note.cases.Pinned.make({}))
  if (input.priority !== 0) notes.push(Note.cases.Priority.make({ value: input.priority }))
  if (input.follows !== undefined) notes.push(Note.cases.Follows.make({ tool: input.follows }))
  if (input.resets > 0) notes.push(Note.cases.Resets.make({ count: input.resets }))
  if (input.served.requests > 0) {
    notes.push(Note.cases.Served.make({ requests: input.served.requests, tokens: input.served.tokens }))
  }
  const explained = input.condition._tag === "SignInNeeded" || input.condition._tag === "Limited"
  if (input.lastError !== undefined && !explained) notes.push(Note.cases.LastError.make({ text: input.lastError }))
  return notes
}

export const noteTone = (note: Note): Tone => (note._tag === "Pinned" || note._tag === "Resets" ? "accent" : "muted")

/** A window's use: a warning from 70%, bad from 90%. */
export const toneOfUse = (used: number): Tone => (used >= 90 ? "bad" : used >= 70 ? "warn" : "good")
