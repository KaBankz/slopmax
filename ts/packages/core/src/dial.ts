// Codex's upstream WebSocket: dialed by the relay, through the same proxy
// and CA roots as every other outbound call. `Upstream.dial` is the way in;
// it turns these failures into its own `Unreachable` and `TimedOut`.
//
// Until the relay lands, every dial is refused, so a Codex WebSocket falls
// back to HTTP streaming, which Codex does on its own.
import { Data, type Duration, Effect, type Scope } from "effect"

/** An open upstream WebSocket, and the headers of the 101 that opened it. */
export interface UpstreamSocket {
  readonly headers: Headers
  /** The socket itself, owned by the relay. */
  readonly raw: WebSocket
}

/** How a dial reaches the provider: the HTTP proxy to go through, if any, and the CA roots to trust. */
export interface DialRoute {
  readonly proxy: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined
  readonly ca: ReadonlyArray<string>
}

/** The socket could not be opened. */
export class DialRefused extends Data.TaggedError("DialRefused")<{ readonly cause: unknown }> {}

/** No 101 and `open` within the wait. */
export class DialTimedOut extends Data.TaggedError("DialTimedOut")<{ readonly after: Duration.Duration }> {}

/** Opens Codex's upstream socket, waiting for the 101 and `open`. */
export const dial = (
  _url: string,
  _headers: Headers,
  _route: DialRoute,
): Effect.Effect<UpstreamSocket, DialRefused | DialTimedOut, Scope.Scope> =>
  Effect.fail(new DialRefused({ cause: new Error("WebSocket relaying is not available yet") }))
