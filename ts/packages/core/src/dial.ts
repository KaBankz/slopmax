// Codex's upstream WebSocket, dialed by the socket relay through the same
// proxy and CA roots as every other outbound call.
//
// The socket is Bun's implementation of the `ws` API: it is the client that
// shows the headers of the provider's 101 (the relay hands three of them to
// Codex), takes request headers of slopmax's choosing (the account's
// credential in place of slopmax's key), and goes through an HTTP CONNECT
// proxy. It frames, masks, answers pings and checks the accept key itself.
//
// A dial waits for the 101 and the socket opening; `Upstream.dial` bounds
// the wait. The socket belongs to the scope it was dialed in, and closing
// that scope cuts it. What the provider sends before the relay starts
// listening is kept and handed over first, so nothing is lost in between.
import { Data, Effect, type Scope } from "effect"
import { type ClientOptions, type RawData, WebSocket } from "ws"

/** The largest message either side of Codex's socket may send: a turn carries the whole conversation. */
export const maxMessage = 64 * 1024 * 1024

/** A socket's `readyState`, by name. */
export const ReadyState = { connecting: 0, open: 1, closing: 2, closed: 3 } as const

/** What the relay hears from an upstream socket. */
export interface SocketListener {
  /** A message, text or binary, whole. */
  readonly message: (bytes: Uint8Array, binary: boolean) => void
  /** The socket closed: with the code and reason the provider sent, or 1006 when it went away without one. */
  readonly close: (code: number, reason: string) => void
}

/** An open upstream WebSocket, and the headers of the 101 that opened it. */
export interface UpstreamSocket {
  readonly headers: Headers
  /** The socket itself, for sending, pausing and closing; the relay owns it. */
  readonly raw: WebSocket
  /** Hands every message and the close to `listener`, those that came before it first. Called once. */
  readonly listen: (listener: SocketListener) => void
}

/** How a dial reaches the provider. */
export interface DialRoute {
  /** The URL to dial: the one asked for, unless tests send its origin elsewhere. */
  readonly url: string
  /** The HTTP proxy to go through, and the headers it needs (its credentials), if any. */
  readonly proxy: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined
  /** The CA roots TLS trusts; none means the runtime's own. */
  readonly ca: ReadonlyArray<string>
}

/** The socket could not be opened: unreachable, refused, or answered something other than a 101. */
export class DialRefused extends Data.TaggedError("DialRefused")<{
  readonly reason: string
  /** The status the provider answered instead of 101, when it answered. */
  readonly status?: number
  readonly cause?: unknown
}> {
  override get message(): string {
    return this.reason
  }
}

/** What Bun's `ws` takes beyond the `ws` package's own options. */
interface BunClientOptions extends ClientOptions {
  readonly proxy?: { readonly url: string; readonly headers: Readonly<Record<string, string>> }
  readonly tls?: { readonly ca: Array<string> }
}

/** Response headers as `ws` reports them. */
type RawHeaders = { readonly [name: string]: string | ReadonlyArray<string> | undefined }

/** Request headers as `ws` takes them. */
const headerRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of headers) out[name] = value
  return out
}

/** The 101's headers as a `Headers`. */
export const responseHeaders = (raw: RawHeaders): Headers => {
  const out = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") out.append(name, value)
    else if (value !== undefined) for (const each of value) out.append(name, each)
  }
  return out
}

/** The options a dial opens its socket with. */
export const clientOptions = (headers: Headers, route: DialRoute): BunClientOptions => ({
  headers: headerRecord(headers),
  // Codex's socket carries JSON events slopmax reads; compression would only cost both sides.
  perMessageDeflate: false,
  maxPayload: maxMessage,
  ...(route.proxy === undefined ? {} : { proxy: { url: route.proxy.url, headers: route.proxy.headers } }),
  ...(route.ca.length === 0 ? {} : { tls: { ca: [...route.ca] } }),
})

/** A message `ws` handed over, as bytes. */
export const bytesOf = (data: RawData): Uint8Array => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const size = data.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of data) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

const utf8 = new TextDecoder()

const ignore = (): void => undefined

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** Cuts a socket at once, whatever state it is in. */
const cut = (raw: WebSocket): void => {
  if (raw.readyState !== ReadyState.closed) raw.terminate()
}

/** Something the socket said before anyone listened. */
type Early = Data.TaggedEnum<{
  Message: { readonly bytes: Uint8Array; readonly binary: boolean }
  Close: { readonly code: number; readonly reason: string }
}>
const Early = Data.taggedEnum<Early>()

/** Keeps what the socket says until a listener takes it, then passes everything straight on. */
const relayed = (raw: WebSocket): UpstreamSocket["listen"] => {
  const early: Array<Early> = []
  let listener: SocketListener | undefined
  raw.on("message", (data: RawData, binary: boolean) => {
    const bytes = bytesOf(data)
    if (listener === undefined) early.push(Early.Message({ bytes, binary }))
    else listener.message(bytes, binary)
  })
  raw.on("close", (code: number, reason: Uint8Array) => {
    const text = utf8.decode(reason)
    if (listener === undefined) early.push(Early.Close({ code, reason: text }))
    else listener.close(code, text)
  })
  return (next) => {
    listener = next
    for (const each of early.splice(0)) {
      if (each._tag === "Message") next.message(each.bytes, each.binary)
      else next.close(each.code, each.reason)
    }
  }
}

/** Opens the socket and waits for its 101 and `open`. Interrupting the wait cuts it. */
const open = (headers: Headers, route: DialRoute): Effect.Effect<UpstreamSocket, DialRefused> =>
  Effect.callback<UpstreamSocket, DialRefused>((resume) => {
    let raw: WebSocket
    try {
      raw = new WebSocket(route.url, clientOptions(headers, route))
    } catch (cause) {
      resume(Effect.fail(new DialRefused({ reason: reasonOf(cause), cause })))
      return
    }
    const listen = relayed(raw)
    let upgraded = new Headers()
    const onUpgrade = (response: { readonly headers: RawHeaders }) => {
      upgraded = responseHeaders(response.headers)
    }
    const settle = (outcome: Effect.Effect<UpstreamSocket, DialRefused>) => {
      raw.off("upgrade", onUpgrade)
      raw.off("open", onOpen)
      raw.off("unexpected-response", onUnexpected)
      raw.off("error", onError)
      resume(outcome)
    }
    const onOpen = () => settle(Effect.succeed({ headers: upgraded, raw, listen }))
    const onUnexpected = (_request: unknown, response: { readonly statusCode?: number | undefined }) => {
      const status = response.statusCode
      settle(
        Effect.fail(
          new DialRefused({
            reason: `answered ${status ?? "without a status"}`,
            ...(status === undefined ? {} : { status }),
          }),
        ),
      )
      cut(raw)
    }
    const onError = (cause: Error) => {
      settle(Effect.fail(new DialRefused({ reason: reasonOf(cause), cause })))
      cut(raw)
    }
    // Cutting a socket reports an error too; past the dial, failures show as the
    // close that follows, so an error is never left unheard.
    raw.on("error", ignore)
    raw.on("upgrade", onUpgrade)
    raw.once("open", onOpen)
    raw.once("unexpected-response", onUnexpected)
    raw.once("error", onError)
    return Effect.sync(() => cut(raw))
  })

/**
 * Opens Codex's upstream socket, waiting for the 101 and `open`; the scope
 * it is dialed in owns it, and closing the scope cuts it.
 */
export const dial = (headers: Headers, route: DialRoute): Effect.Effect<UpstreamSocket, DialRefused, Scope.Scope> =>
  // The wait stays interruptible, so `Upstream.dial`'s deadline can end it; the socket is cut then.
  Effect.acquireRelease(Effect.interruptible(open(headers, route)), (socket) => Effect.sync(() => cut(socket.raw)))
