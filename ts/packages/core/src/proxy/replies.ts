// The answers slopmax gives itself, rather than passing on a provider's.
//
// Every error a client hears from the proxy is in its own format (Claude
// Code's, Codex's or an OpenAI-style tool's), with the kind its status
// means, so each client shows the message and backs off the way it would
// for its own provider. These are plain functions that build a `Response`.
import { type Dialect, slopmaxVersion } from "@slopmax/domain"
import { errorBody, type ErrorReply, type FailureKind, failureKind } from "@slopmax/wire"
import { Cause } from "effect"

const jsonType = "application/json"

/** A JSON answer with `status`, plus any extra headers. */
export const json = (status: number, body: unknown, headers?: Readonly<Record<string, string>>): Response => {
  const out = new Headers(headers)
  out.set("content-type", jsonType)
  return new Response(JSON.stringify(body), { status, headers: out })
}

/**
 * The kind of error slopmax's own answer with `status` is. A client error
 * with no kind of its own (a WebSocket refused with 426, say) is a request
 * the client can change, never the server's fault. slopmax's own 503 (no
 * account could take the request) is not a provider being overloaded, so
 * only a 529 says so.
 */
export const kindOf = (status: number): FailureKind => {
  if (status >= 500) return status === 529 ? "overloaded_error" : "api_error"
  const kind = failureKind(status)
  return kind === "api_error" ? "invalid_request_error" : kind
}

/** An error in `dialect`'s shape (Messages' when the route has none), of the kind `status` means. */
export const error = (dialect: Dialect | undefined, status: number, message: string): Response =>
  json(status, errorBody(dialect ?? "messages", kindOf(status), message))

/** One of the replies `@slopmax/wire` shapes (a limit reached, an error retold), as a response. */
export const fromReply = (reply: ErrorReply): Response => json(reply.status, reply.body, reply.headers)

/** `GET /healthz`: who answers, so a client can tell slopmax from another program on its port. */
export const healthBody = JSON.stringify({ status: "ok", service: "slopmax", version: slopmaxVersion })

/** The health answer; built once and served by `Bun.serve` without running any code per request. */
export const health = (): Response => new Response(healthBody, { status: 200, headers: { "content-type": jsonType } })

/** Claude Code's connectivity probe and every `HEAD`: an empty 200, no key needed. */
export const hello = (): Response => new Response(null, { status: 200 })

/** A path slopmax does not serve. */
export const unknownPathMessage = "unknown path; slopmax serves /claude/*, /codex/*, and /v1/*"
export const unknownPath = (): Response => error(undefined, 404, unknownPathMessage)

/** A request without the owner key or a client key. */
export const noKeyMessage = "missing or invalid slopmax key; see `slopmax env`"
export const noKey = (dialect: Dialect | undefined): Response => error(dialect, 401, noKeyMessage)

/** The dashboard and slopmax's own API, while nothing serves them. */
export const noWebApp = (): Response => error(undefined, 404, "slopmax's own API and dashboard are not served here")

/**
 * A WebSocket that is not relayed. 426 tells Codex to stream over HTTP at
 * once instead of retrying the socket.
 */
export const noSocket = (message = "slopmax does not relay WebSockets here; use HTTP streaming"): Response =>
  error("responses", 426, message)

/**
 * The answer when handling a request failed in a way slopmax did not plan
 * for. Every planned outcome is a reply of its own; this one still reaches
 * the client in its format, never as a dropped connection.
 */
export const defect = (dialect: Dialect | undefined, cause: Cause.Cause<unknown>): Response => {
  const squashed = Cause.squash(cause)
  const why = squashed instanceof Error ? squashed.message : String(squashed)
  return error(dialect, 500, `slopmax failed to answer: ${why}`)
}
