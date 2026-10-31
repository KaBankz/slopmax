// Errors in each client's own format.
//
// When slopmax itself answers with an error (no key, no account free, every
// account spent) or passes on a provider's error in another format, the client
// must see it the way its own provider would say it: Claude Code, Codex and
// OpenAI-style tools each show their own messages and back off their own way.
import type { Dialect } from "@slopmax/domain"
import { DateTime, Duration, Schema } from "effect"
import { dataJson, Lines, parseJson } from "./lines.ts"
import { jsonPath } from "./observe.ts"

/** The kinds of error every format names the same way. */
export const FailureKind = Schema.Literals([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "overloaded_error",
  "api_error",
])
export type FailureKind = typeof FailureKind.Type

/** The kind of error an HTTP status means. */
export const failureKind = (status: number): FailureKind => {
  switch (status) {
    case 400:
      return "invalid_request_error"
    case 401:
      return "authentication_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_error"
    case 503:
    case 529:
      return "overloaded_error"
    default:
      return "api_error"
  }
}

/** A Messages error: `{"type":"error","error":{"type","message"}}`. */
export const MessagesError = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.Struct({ type: Schema.String, message: Schema.String }),
})
export type MessagesError = typeof MessagesError.Type

/**
 * A Responses or Chat error: `{"error":{"type","message"}}`, with a `code`
 * on Chat's rate limit and the reset time on Codex's usage limit.
 */
export const OpenAiError = Schema.Struct({
  error: Schema.Struct({
    type: Schema.String,
    code: Schema.optionalKey(Schema.String),
    message: Schema.String,
    resets_at: Schema.optionalKey(Schema.Int),
    resets_in_seconds: Schema.optionalKey(Schema.Int),
  }),
})
export type OpenAiError = typeof OpenAiError.Type

/** An error body in some client's format. */
export type ErrorBody = MessagesError | OpenAiError

/** An error body of `kind` in `dialect`'s format. */
export const errorBody = (dialect: Dialect, kind: FailureKind, message: string): ErrorBody =>
  dialect === "messages" ? { type: "error", error: { type: kind, message } } : { error: { type: kind, message } }

/** An answer slopmax gives itself: its status, body and the headers it needs. */
export interface ErrorReply {
  readonly status: number
  readonly body: ErrorBody
  readonly headers: Readonly<Record<string, string>>
}

/** Whole seconds from `now` until `until`, at least 1: clients wait at least that long. */
const secondsUntil = (until: DateTime.DateTime, now: DateTime.DateTime): number =>
  Math.max(1, Math.floor(Duration.toSeconds(DateTime.distance(now, until))))

/**
 * The answer when every account is spent until `until`: a 429 with
 * `retry-after`, in the shape each client shows as its own usage limit, so it
 * tells its user and waits as it would for its provider.
 * - Claude Code reads a rejected unified limit and its reset from headers.
 * - Codex reads `usage_limit_reached` with `resets_at` and `resets_in_seconds`.
 * - OpenAI-style clients read `rate_limit_exceeded` and `retry-after`.
 */
export const limitReached = (
  dialect: Dialect,
  message: string,
  until: DateTime.DateTime,
  now: DateTime.DateTime,
): ErrorReply => {
  const wait = secondsUntil(until, now)
  const retryAfter = { "retry-after": String(wait) }
  switch (dialect) {
    case "messages":
      return {
        status: 429,
        body: errorBody("messages", "rate_limit_error", message),
        headers: {
          ...retryAfter,
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(DateTime.toEpochSeconds(until)),
        },
      }
    case "responses":
      return {
        status: 429,
        body: {
          error: {
            type: "usage_limit_reached",
            message,
            resets_at: DateTime.toEpochSeconds(until),
            resets_in_seconds: wait,
          },
        },
        headers: retryAfter,
      }
    case "chat":
      return {
        status: 429,
        body: { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message } },
        headers: retryAfter,
      }
  }
}

/** Where a provider's error keeps its message, most specific first. */
const messagePaths: ReadonlyArray<ReadonlyArray<string>> = [
  ["error", "message"],
  ["response", "error", "message"],
  ["error"],
  ["detail"],
  ["message"],
]

const messageIn = (document: unknown): string | undefined => {
  if (document === undefined) return undefined
  for (const path of messagePaths) {
    const found = jsonPath(document, path)
    if (typeof found === "string") return found
  }
  return undefined
}

const lossy = new TextDecoder()

/**
 * The message of a provider's error body: the first one found in the body as
 * JSON, or else in any `data:` line of it (a stream that opened with a
 * failure); failing both, its first 500 bytes as text.
 */
export const errorMessage = (body: Uint8Array): string => {
  const whole = messageIn(parseJson(body, 0, body.length))
  if (whole !== undefined) return whole
  let found: string | undefined
  const lines = new Lines(body.length)
  const visit = (bytes: Uint8Array, start: number, end: number): boolean => {
    found = messageIn(dataJson(bytes, start, end))
    return found !== undefined
  }
  if (!lines.push(body, visit)) lines.end(visit)
  return found ?? lossy.decode(body.subarray(0, 500))
}

/**
 * A provider's error retold in the client's format, when the request was
 * translated and the client cannot read the provider's own. The status is
 * kept, except that Claude Code hears every server error as 529, overloaded,
 * which it knows to retry.
 */
export const retell = (client: Dialect, status: number, body: Uint8Array): ErrorReply => {
  const told = client === "messages" && status >= 500 && status <= 599 ? 529 : status
  return { status: told, body: errorBody(client, failureKind(told), errorMessage(body)), headers: {} }
}
