// Raw TCP and TLS connections, for what fetch cannot do: a connection a
// `101 Switching Protocols` hands over (WebSocket), the SOCKS5 bridge, and
// the CONNECT and SOCKS5 handshakes under them. node:net and node:tls stay
// in this module.
import { connect as tcpConnect, type Socket } from "node:net"
import { constants } from "node:os"
import { connect as tlsConnect, getCACertificates } from "node:tls"

import { Data, Duration, Effect } from "effect"

/** A connection failed or ended early. */
export class IoError extends Data.TaggedError("IoError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason
  }
}

/** What std's `read_exact` says when the stream ends first. */
export const UNEXPECTED_EOF = "failed to fill whole buffer"

/** What a connect that outlives its timeout says (tokio's `Elapsed`). */
export const CONNECT_ELAPSED = "deadline has elapsed"

// Chunks held before the socket is paused: the reader pulls at its pace.
const HIGH_WATER = 16

/** The system's code of an error (`ECONNREFUSED`), when it has one. */
export const errorCode = (cause: Error): string | undefined => {
  const code: unknown = Reflect.get(cause, "code")
  return typeof code === "string" ? code : undefined
}

const errno: Readonly<Record<string, number | undefined>> = constants.errno

// std's text for an OS error: `Connection refused (os error 111)`.
const osError = (text: string, code: string): string => {
  const number = errno[code]
  return number === undefined ? text : `${text} (os error ${number})`
}

// Bun's advice at the end of a fetch error, which is not part of the cause.
const VERBOSE_HINT = / For more information, pass `verbose: true` in the second argument to fetch\(\)$/

/** An error as a short phrase, as std's `io::Error` prints the common ones. */
export const errorText = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause)
  const code = errorCode(cause)
  switch (code) {
    case "ECONNREFUSED":
      return osError("Connection refused", code)
    case "ECONNRESET":
      return osError("Connection reset by peer", code)
    case "EPIPE":
      return osError("Broken pipe", code)
    case "ETIMEDOUT":
      return osError("Connection timed out", code)
    case "ENETUNREACH":
      return osError("Network is unreachable", code)
    case "EHOSTUNREACH":
      return osError("No route to host", code)
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "failed to lookup address information: Name or service not known"
    default: {
      const text = cause.message.replace(VERBOSE_HINT, "")
      const prefix = code === undefined ? "" : `${code}: `
      return prefix !== "" && text.startsWith(prefix) ? text.slice(prefix.length) : text
    }
  }
}

const ioError = (cause: unknown): IoError =>
  cause instanceof IoError ? cause : new IoError({ reason: errorText(cause) })

/** A byte buffer that grows by doubling, so appending chunks stays linear. */
export class Grow {
  private bytes = new Uint8Array(256)
  length = 0

  append(chunk: Uint8Array): void {
    const need = this.length + chunk.length
    if (need > this.bytes.length) {
      const next = new Uint8Array(Math.max(need, this.bytes.length * 2))
      next.set(this.bytes.subarray(0, this.length))
      this.bytes = next
    }
    this.bytes.set(chunk, this.length)
    this.length = need
  }

  /** The bytes so far (a view: later appends may replace it). */
  view(): Uint8Array {
    return this.bytes.subarray(0, this.length)
  }
}

// Where `\r\n\r\n` ends in `bytes`, searching from `from`; -1 if absent.
const blankLine = (bytes: Uint8Array, from: number): number => {
  for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4
  }
  return -1
}

/**
 * A byte stream over a socket, read by pulling chunks. Bytes read too far
 * (past a handshake) can be put back with {@link unread}. Reads are
 * interrupt-safe: a read that is interrupted takes nothing.
 */
export class Conn {
  private readonly queue: Array<Uint8Array> = []
  private ended = false
  private failure: string | undefined
  private readonly waiters: Array<() => void> = []
  private paused = false

  constructor(readonly socket: Socket) {
    socket.on("data", this.onData)
    socket.on("end", this.onEnd)
    socket.on("close", this.onEnd)
    socket.on("error", this.onError)
  }

  private readonly onData = (chunk: Uint8Array): void => {
    this.queue.push(chunk)
    if (this.queue.length >= HIGH_WATER && !this.paused) {
      this.paused = true
      this.socket.pause()
    }
    this.wake()
  }

  private readonly onEnd = (): void => {
    this.ended = true
    this.wake()
  }

  private readonly onError = (error: Error): void => {
    this.failure ??= errorText(error)
    this.wake()
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  // What a read gets now, or undefined when it must wait.
  private poll(): Effect.Effect<Uint8Array | undefined, IoError> | undefined {
    const chunk = this.queue.shift()
    if (chunk !== undefined) {
      if (this.paused && this.queue.length < HIGH_WATER / 2) {
        this.paused = false
        this.socket.resume()
      }
      return Effect.succeed(chunk)
    }
    if (this.failure !== undefined) return Effect.fail(new IoError({ reason: this.failure }))
    if (this.ended) return Effect.succeed(undefined)
    return undefined
  }

  /** The next chunk, or undefined once the peer has finished. */
  readonly read: Effect.Effect<Uint8Array | undefined, IoError> = Effect.callback((resume) => {
    const now = this.poll()
    if (now !== undefined) return resume(now)
    const waiter = (): void => {
      const next = this.poll()
      if (next === undefined) this.waiters.push(waiter)
      else resume(next)
    }
    this.waiters.push(waiter)
    // Interrupted: stop waiting, so no chunk is taken for nobody.
    return Effect.sync(() => {
      const at = this.waiters.indexOf(waiter)
      if (at >= 0) this.waiters.splice(at, 1)
    })
  })

  /** Puts `bytes` back in front of what is still to be read. */
  unread(bytes: Uint8Array): void {
    if (bytes.length > 0) this.queue.unshift(bytes)
  }

  /** Exactly `n` bytes; fails with `eof` if the stream ends first. */
  readExact(n: number, eof = UNEXPECTED_EOF): Effect.Effect<Uint8Array, IoError> {
    return Effect.gen({ self: this }, function* () {
      const out = new Uint8Array(n)
      let at = 0
      while (at < n) {
        const chunk = yield* this.read
        if (chunk === undefined) return yield* new IoError({ reason: eof })
        const take = Math.min(chunk.length, n - at)
        out.set(chunk.subarray(0, take), at)
        at += take
        if (take < chunk.length) this.unread(chunk.subarray(take))
      }
      return out
    })
  }

  /**
   * Everything up to and including the first blank line (`\r\n\r\n`), the
   * rest put back. Fails past `max` bytes or at the end of the stream.
   */
  readHead(max: number, eof: string, tooLong: string): Effect.Effect<Uint8Array, IoError> {
    return Effect.gen({ self: this }, function* () {
      const head = new Grow()
      for (;;) {
        const chunk = yield* this.read
        if (chunk === undefined) return yield* new IoError({ reason: eof })
        const from = head.length - 3
        head.append(chunk)
        const bytes = head.view()
        const end = blankLine(bytes, from)
        if (end >= 0) {
          this.unread(bytes.slice(end))
          return bytes.slice(0, end)
        }
        if (head.length > max) return yield* new IoError({ reason: tooLong })
      }
    })
  }

  /** One line without its `\r\n`, failing past `max` bytes. */
  readLine(max: number): Effect.Effect<Uint8Array, IoError> {
    return Effect.gen({ self: this }, function* () {
      const line = new Grow()
      for (;;) {
        const chunk = yield* this.read
        if (chunk === undefined) return yield* new IoError({ reason: "unexpected end of file" })
        const from = line.length
        line.append(chunk)
        const bytes = line.view()
        const end = bytes.indexOf(10, from)
        if (end >= 0) {
          this.unread(bytes.slice(end + 1))
          return bytes.slice(0, end > 0 && bytes[end - 1] === 13 ? end - 1 : end)
        }
        if (line.length > max) return yield* new IoError({ reason: "line too long" })
      }
    })
  }

  /** Writes `bytes`, done once the socket has taken them. */
  readonly write = (bytes: Uint8Array | string): Effect.Effect<void, IoError> =>
    Effect.callback((resume) => {
      if (this.failure !== undefined) return resume(Effect.fail(new IoError({ reason: this.failure })))
      this.socket.write(bytes, (error) => resume(error ? Effect.fail(ioError(error)) : Effect.void))
    })

  /**
   * Stops reading through this object and returns what it held, so the
   * socket can be piped as is.
   */
  detach(): Uint8Array {
    this.socket.off("data", this.onData)
    this.socket.off("end", this.onEnd)
    this.socket.off("close", this.onEnd)
    this.socket.off("error", this.onError)
    if (this.paused) this.socket.resume()
    const held = new Grow()
    for (const chunk of this.queue.splice(0)) held.append(chunk)
    return held.view()
  }

  destroy(): void {
    this.socket.destroy()
  }

  /** Sends what is buffered, then closes. */
  readonly close: Effect.Effect<void> = Effect.sync(() => {
    if (this.socket.destroyed) return
    this.socket.end(() => this.socket.destroy())
  })
}

/**
 * A TCP connection with `TCP_NODELAY` and keepalive (60 s). An interrupted
 * connect is abandoned and its socket destroyed.
 */
export const openTcp = (host: string, port: number): Effect.Effect<Socket, IoError> =>
  Effect.callback((resume) => {
    const socket = tcpConnect({ host, port, noDelay: true, keepAlive: true, keepAliveInitialDelay: 60_000 })
    const fail = (error: Error): void => {
      socket.destroy()
      resume(Effect.fail(ioError(error)))
    }
    socket.once("error", fail)
    socket.once("connect", () => {
      socket.off("error", fail)
      resume(Effect.succeed(socket))
    })
    return Effect.sync(() => socket.destroy())
  })

/** {@link openTcp}, failing {@link CONNECT_ELAPSED} after `timeout`, on the `Clock`. */
export const openTcpWithin = (host: string, port: number, timeout: Duration.Duration): Effect.Effect<Socket, IoError> =>
  Effect.timeoutOrElse(openTcp(host, port), {
    duration: timeout,
    orElse: () => Effect.fail(new IoError({ reason: CONNECT_ELAPSED })),
  })

/** Starts TLS over `socket` for `servername`, trusting `ca`. */
export const startTls = (
  socket: Socket,
  servername: string,
  ca: ReadonlyArray<string>,
): Effect.Effect<Socket, IoError> =>
  Effect.callback((resume) => {
    const secure = tlsConnect({ socket, servername, ALPNProtocols: ["http/1.1"], ca: [...ca] })
    const fail = (error: Error): void => {
      secure.destroy()
      resume(Effect.fail(ioError(error)))
    }
    secure.once("error", fail)
    secure.once("secureConnect", () => {
      secure.off("error", fail)
      resume(Effect.succeed(secure))
    })
    return Effect.sync(() => secure.destroy())
  })

let roots: ReadonlyArray<string> | undefined

/** The system's trusted roots as PEM, loaded once; empty when none are found. */
export const systemRoots = (): ReadonlyArray<string> => {
  if (roots === undefined) {
    try {
      roots = getCACertificates("system")
    } catch {
      roots = []
    }
  }
  return roots
}

const latin1 = new TextDecoder("latin1")
const EOF = "unexpected end of file"
const TOO_LONG = "proxy response headers too long"

const tunnelError = (what: string): IoError => new IoError({ reason: `tunnel error: ${what}` })

/**
 * Asks the HTTP proxy on `conn` for a tunnel to `host:port` (CONNECT),
 * with `auth` as its `Proxy-Authorization`. Errors read as hyper-util's
 * `TunnelError`, or as the I/O error under it.
 */
export const tunnel = Effect.fn("conn.tunnel")(function* (
  conn: Conn,
  host: string,
  port: number,
  auth: string | undefined,
) {
  let request = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
  if (auth !== undefined) request += `Proxy-Authorization: ${auth}\r\n`
  request += "\r\n"
  yield* conn.write(request)
  const head = yield* conn
    .readHead(8192, EOF, TOO_LONG)
    .pipe(
      Effect.mapError((error) =>
        error.reason === EOF || error.reason === TOO_LONG ? tunnelError(error.reason) : error,
      ),
    )
  // Bytes the proxy sent past its answer are dropped, as hyper-util does.
  conn.detach()
  const status = /^HTTP\/1\.[01] (\d{3})[ \r]/.exec(latin1.decode(head))?.[1]
  if (status === "200") return
  if (status === "407") return yield* tunnelError("proxy authorization required")
  return yield* tunnelError("unsuccessful")
})
