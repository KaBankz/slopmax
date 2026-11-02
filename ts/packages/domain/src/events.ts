// The event stream every front end watches (`GET /events`), so nothing polls.
import { Schema } from "effect"
import { LedgerRecord } from "./ledger.ts"
import { LoginEvent, LoginId } from "./login.ts"
import { Notice } from "./notice.ts"
import { Report } from "./report.ts"

export const Event = Schema.TaggedUnion({
  /**
   * The first event on every connection: the proxy is live, its version, and
   * the program serving it, so a client can tell a daemon it started from one
   * it did not.
   */
  Hello: { version: Schema.String, exe: Schema.optionalKey(Schema.String) },
  /** The report, at connect and whenever it changes. */
  Status: { report: Report },
  /** One per request slopmax answered. */
  Request: { record: LedgerRecord.cases.Request },
  /** Once per notice; the proxy remembers what it told. */
  Notice: { notice: Notice },
  /** Sign-in progress, for sign-ins started through the API. */
  Login: { id: LoginId, event: LoginEvent },
  /** Every 15 seconds, so proxies between keep the stream open. */
  Ping: {},
})
export type Event = typeof Event.Type
