// Notices: what slopmax tells people, through the webhook, the notify
// command, the desktop's notifications and the report's nudges.
import { Schema } from "effect"
import { Instant, ProviderId } from "./ids.ts"

export const NoticeKind = Schema.Literals([
  /** One account hit a usage limit. */
  "limited",
  /** A limited account can serve again. */
  "available",
  /** Every account of a provider is limited or signed out, so its requests fail. */
  "exhausted",
  /** A provider's requests are served again. */
  "recovered",
  /** An account's sign-in stopped working. */
  "signed-out",
  /** A banked limit reset is about to expire unredeemed. */
  "reset-expiring",
  /** A week or month is about to reset with much of its quota unused. */
  "quota-unused",
  /** `slopmax notify`'s check that notifications arrive. */
  "test",
])
export type NoticeKind = typeof NoticeKind.Type

/** The kinds sent when the settings name none: the ones that need someone to act. */
export const defaultNoticeKinds: ReadonlyArray<NoticeKind> = [
  "exhausted",
  "recovered",
  "signed-out",
  "reset-expiring",
  "quota-unused",
]

export class Notice extends Schema.Class<Notice>("Notice")({
  kind: NoticeKind,
  /** Names what the notice is about, so it is told once and a newer one replaces it. */
  key: Schema.String,
  provider: Schema.optionalKey(ProviderId),
  /** The account's name, as people know it. */
  account: Schema.optionalKey(Schema.String),
  /** When it stops mattering: the reset, the expiry, or when the account is back. */
  until: Schema.optionalKey(Instant),
  /** What happened, for people; commands to run are in backticks. */
  message: Schema.String,
  at: Instant,
  /** For unused quota: what that part of the plan cost, in dollars. */
  worth: Schema.optionalKey(Schema.Number),
}) {}
