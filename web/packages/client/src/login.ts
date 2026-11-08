// Signing in through the API: progress arrives as events, so a window or a
// browser tab can show each step, including on another machine.
import { Schema } from "effect"
import { AccountView } from "./report.ts"

export const LoginId = Schema.String.pipe(Schema.brand("LoginId"))
export type LoginId = typeof LoginId.Type

export const LoginEvent = Schema.TaggedUnion({
  /** Open this address to sign in; `opened` when slopmax opened a browser itself. */
  Authorize: { title: Schema.String, url: Schema.String, port: Schema.Int, opened: Schema.Boolean },
  /** Enter this code at this address, on any device. */
  DeviceCode: { url: Schema.String, code: Schema.String },
  /** Something worth knowing along the way. */
  Note: { text: Schema.String },
  /** Signed in: the account, and whether it is new or an existing one updated. */
  Done: { account: AccountView, isNew: Schema.Boolean },
  Failed: { message: Schema.String },
})
export type LoginEvent = typeof LoginEvent.Type
