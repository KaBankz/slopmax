// @slopmax/wire: the API formats slopmax speaks, as pure code over bytes and
// values. The byte level (reading request bodies, splitting answer streams,
// watching them for usage and refusals, error bodies) is below; translation
// between the formats builds on it: the common form, each format's reader
// and writer, the streaming transcoder, compaction and reasoning replay.
export {
  type ErrorBody,
  errorBody,
  errorMessage,
  type ErrorReply,
  FailureKind,
  failureKind,
  limitReached,
  retell,
} from "./errors.ts"
export * as lines from "./lines.ts"
export { type Observer, observe, observers, TapOutcome, textOf } from "./observe.ts"
export { holdsStart, judge, Opening, Verdict } from "./opening.ts"
export * as scan from "./scan.ts"
export {
  type HeaderLookup,
  maxDocument,
  ReportingTap,
  shapeOf,
  Tap,
  type TapEnd,
  type TapReport,
  type TapShape,
} from "./tap.ts"

export * as common from "./common.ts"
export { type ReplyContext, RequestInvalid, type UpstreamDialect } from "./common.ts"
export * as messages from "./messages.ts"
export * as responses from "./responses.ts"
export * as chat from "./chat.ts"
export * from "./format.ts"
export * from "./collect.ts"
export * from "./transcode.ts"
export * as Compaction from "./compaction.ts"
export * from "./replay.ts"
