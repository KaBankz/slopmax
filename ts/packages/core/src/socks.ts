// A loopback bridge from HTTP proxying to a SOCKS5 proxy.
//
// Bun's `fetch` and WebSocket client speak HTTP proxies only. When slopmax is
// told to reach providers through `socks5://` or `socks5h://`, it starts this
// bridge on 127.0.0.1 and points them at it: each CONNECT (and each plain
// HTTP request in absolute form) is dialed out through the SOCKS5 proxy
// (RFC 1928, with RFC 1929 user/password auth) and the bytes are piped both
// ways. `socks5://` resolves names here; `socks5h://` lets the proxy resolve
// them. The bridge answers only requests carrying its own random
// credentials, so other programs on the machine cannot use it, and it closes
// with the scope that started it.
import { connect, createServer, type Server, type Socket } from "node:net"
import { Data, Duration, Effect, FiberSet, Option, Result, type Scope } from "effect"
import { Dns, Host, NetAddress } from "effect/net"

/** A SOCKS5 proxy, and whether names are resolved by it (`socks5h://`) or here. */
export interface SocksTarget {
  readonly host: string
  readonly port: number
  readonly user?: string | undefined
  readonly password?: string | undefined
  readonly remoteDns: boolean
}

/** The SOCKS5 proxy refused, failed, or could not be reached. */
export class SocksFailed extends Data.TaggedError("SocksFailed")<{ readonly reason: string }> {
  override get message(): string {
    return `SOCKS proxy: ${this.reason}`
  }
}

/** A running bridge: the HTTP proxy URL and the credentials it answers to. */
export interface Bridge {
  /** `http://127.0.0.1:<port>`, with no credentials in it. */
  readonly url: string
  /** The `Proxy-Authorization` value requests must carry. */
  readonly authorization: string
}

/** What SOCKS5 reply codes mean (RFC 1928 §6). */
export const replyText = (code: number): string =>
  [
    "succeeded",
    "general SOCKS server failure",
    "connection not allowed by ruleset",
    "network unreachable",
    "host unreachable",
    "connection refused",
    "TTL expired",
    "command not supported",
    "address type not supported",
  ][code] ?? `unknown reply ${code}`

const utf8 = new TextEncoder()
const latin1 = new TextDecoder("latin1")

/** The address part of a SOCKS5 request: an IPv4 or IPv6 address, or a name for the proxy to resolve. */
export const addressBytes = (address: NetAddress.IpAddress | string): Uint8Array => {
  if (typeof address === "string") {
    const name = utf8.encode(address)
    return Uint8Array.of(3, name.length, ...name)
  }
  return address._tag === "Ipv4Address"
    ? Uint8Array.of(1, ...NetAddress.ipv4ToOctets(address))
    : Uint8Array.of(4, ...NetAddress.ipv6ToOctets(address))
}

/**
 * Where to ask the proxy to connect: an IP address as given; with
 * `socks5h://` a name as given, for the proxy to resolve; with `socks5://`
 * a name resolved here.
 */
export const destinationAddress = (
  host: string,
  remoteDns: boolean,
): Effect.Effect<NetAddress.IpAddress | string, SocksFailed, Dns.Dns> =>
  Effect.gen(function* () {
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
    const ip = NetAddress.ipFromString(bare)
    if (Result.isSuccess(ip)) return ip.success
    if (remoteDns) {
      if (utf8.encode(bare).length > 255)
        return yield* new SocksFailed({ reason: "the host name is longer than 255 bytes" })
      return bare
    }
    const name = Host.domainNameFromString(bare)
    if (Result.isFailure(name)) return yield* new SocksFailed({ reason: `${JSON.stringify(bare)} is not a host name` })
    const dns = yield* Dns.Dns
    const found = yield* dns
      .lookup(name.success, undefined)
      .pipe(Effect.mapError(() => new SocksFailed({ reason: `could not resolve ${bare}` })))
    const [first] = found
    return first ?? (yield* new SocksFailed({ reason: `could not resolve ${bare}` }))
  })

/** Bytes read from a socket as they arrive, taken by count or up to a blank line. */
class Incoming {
  private buffer = new Uint8Array(0)
  private waiting: (() => void) | undefined
  private ended: string | undefined

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData)
    socket.once("end", () => this.finish("the connection closed"))
    socket.once("error", (error) => this.finish(error.message))
  }

  private readonly onData = (chunk: Uint8Array) => {
    const joined = new Uint8Array(this.buffer.length + chunk.length)
    joined.set(this.buffer)
    joined.set(chunk, this.buffer.length)
    this.buffer = joined
    this.wake()
  }

  private finish(reason: string) {
    this.ended ??= reason
    this.wake()
  }

  private wake() {
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.()
  }

  /** Waits until `ready` finds what it needs in the buffer, then takes that many bytes. */
  private until(
    ready: (buffer: Uint8Array) => number | undefined,
    limit: number,
  ): Effect.Effect<Uint8Array, SocksFailed> {
    return Effect.callback<Uint8Array, SocksFailed>((resume) => {
      const check = () => {
        const size = ready(this.buffer)
        if (size !== undefined) {
          const taken = this.buffer.slice(0, size)
          this.buffer = this.buffer.slice(size)
          resume(Effect.succeed(taken))
        } else if (this.buffer.length > limit) {
          resume(Effect.fail(new SocksFailed({ reason: "too much data before the connection was set up" })))
        } else if (this.ended !== undefined) {
          resume(Effect.fail(new SocksFailed({ reason: this.ended })))
        } else {
          this.waiting = check
        }
      }
      check()
      return Effect.sync(() => {
        this.waiting = undefined
      })
    })
  }

  take(count: number): Effect.Effect<Uint8Array, SocksFailed> {
    return this.until((buffer) => (buffer.length >= count ? count : undefined), Number.POSITIVE_INFINITY)
  }

  /** An HTTP request head, through its blank line. */
  head(limit: number): Effect.Effect<Uint8Array, SocksFailed> {
    return this.until((buffer) => {
      for (let index = 3; index < buffer.length; index++) {
        if (buffer[index] === 10 && buffer[index - 1] === 13 && buffer[index - 2] === 10 && buffer[index - 3] === 13) {
          return index + 1
        }
      }
      return undefined
    }, limit)
  }

  /** Stops buffering and hands back what arrived early. */
  release(): Uint8Array {
    this.socket.off("data", this.onData)
    const rest = this.buffer
    this.buffer = new Uint8Array(0)
    return rest
  }
}

const connectTimeout = Duration.seconds(10)

/** A TCP connection, failing after 10 s. */
const open = (host: string, port: number): Effect.Effect<Socket, SocksFailed> =>
  Effect.callback<Socket, SocksFailed>((resume) => {
    const socket = connect({ host, port, noDelay: true })
    const onError = (error: Error) => resume(Effect.fail(new SocksFailed({ reason: error.message })))
    socket.once("error", onError)
    socket.once("connect", () => {
      socket.off("error", onError)
      resume(Effect.succeed(socket))
    })
    return Effect.sync(() => {
      if (socket.connecting) socket.destroy()
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: connectTimeout,
      orElse: () => Effect.fail(new SocksFailed({ reason: `could not connect to ${host}:${port} within 10 seconds` })),
    }),
  )

const write = (socket: Socket, bytes: Uint8Array | string) =>
  Effect.sync(() => {
    socket.write(bytes)
  })

/**
 * A connection to `host:port` through the SOCKS5 proxy, set up and ready to
 * carry bytes, with whatever arrived early. Failed or interrupted, the
 * connection is closed.
 */
export const dialThrough = (
  target: SocksTarget,
  host: string,
  port: number,
): Effect.Effect<{ readonly socket: Socket; readonly early: Uint8Array }, SocksFailed, Dns.Dns> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(open(target.host, target.port)), (socket) =>
      restore(
        Effect.gen(function* () {
          const incoming = new Incoming(socket)
          const address = yield* destinationAddress(host, target.remoteDns)
          const auth = target.user !== undefined
          yield* write(socket, Uint8Array.of(5, 1, auth ? 2 : 0))
          const [version, method] = yield* incoming.take(2)
          if (version !== 5) return yield* new SocksFailed({ reason: "the proxy does not speak SOCKS5" })
          if (method === 0xff)
            return yield* new SocksFailed({ reason: "the proxy accepts none of our ways to sign in" })
          if (method === 2) {
            const user = utf8.encode(target.user ?? "")
            const password = utf8.encode(target.password ?? "")
            yield* write(socket, Uint8Array.of(1, user.length, ...user, password.length, ...password))
            const [, status] = yield* incoming.take(2)
            if (status !== 0) return yield* new SocksFailed({ reason: "the proxy refused the user name and password" })
          } else if (method !== 0) {
            return yield* new SocksFailed({ reason: "the proxy asked for a way to sign in it did not offer" })
          }
          yield* write(socket, Uint8Array.of(5, 1, 0, ...addressBytes(address), port >> 8, port & 0xff))
          const [answer, reply, , type] = yield* incoming.take(4)
          if (answer !== 5) return yield* new SocksFailed({ reason: "the proxy sent a reply that is not SOCKS5" })
          const bound = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? ((yield* incoming.take(1))[0] ?? 0) : -1
          if (bound < 0) return yield* new SocksFailed({ reason: "the proxy sent a reply that is not SOCKS5" })
          yield* incoming.take(bound + 2)
          if (reply !== 0) return yield* new SocksFailed({ reason: replyText(reply ?? 1) })
          return { socket, early: incoming.release() }
        }).pipe(Effect.onError(() => Effect.sync(() => socket.destroy()))),
      ),
    ),
  )

const badGateway = "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
const notYours =
  'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="slopmax"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'

/** Headers meant for the bridge, never sent on. */
const bridgeHeader = /^(?:proxy-authorization|proxy-connection|connection|keep-alive):/i

/** A header's value in a request head, by lowercase name. */
const headerValue = (lines: ReadonlyArray<string>, name: string): Option.Option<string> => {
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name)
      return Option.some(line.slice(colon + 1).trim())
  }
  return Option.none()
}

/** Joins two sockets until either side ends. */
const pipeBoth = (client: Socket, early: Uint8Array, upstream: Socket, held: Uint8Array) => {
  if (held.length > 0) client.write(held)
  if (early.length > 0) upstream.write(early)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on("error", () => upstream.destroy())
  upstream.on("error", () => client.destroy())
  client.on("close", () => upstream.destroy())
  upstream.on("close", () => client.destroy())
}

/** Where a request through the bridge goes, read from its request line. */
const destination = (
  method: string,
  target: string,
): Option.Option<{ readonly host: string; readonly port: number; readonly path?: string }> => {
  if (method === "CONNECT") {
    const colon = target.lastIndexOf(":")
    const port = Number(target.slice(colon + 1))
    return colon > 0 && Number.isInteger(port) && port > 0 && port < 65_536
      ? Option.some({ host: target.slice(0, colon), port })
      : Option.none()
  }
  const url = URL.parse(target)
  if (url === null || url.protocol !== "http:") return Option.none()
  return Option.some({ host: url.hostname, port: Number(url.port || 80), path: `${url.pathname}${url.search}` })
}

/** Serves one connection to the bridge. */
const serveOne = (client: Socket, target: SocksTarget, authorization: string): Effect.Effect<void, never, Dns.Dns> =>
  Effect.gen(function* () {
    client.setNoDelay(true)
    const incoming = new Incoming(client)
    const head = latin1.decode(yield* incoming.head(64 * 1024))
    const [requestLine = "", ...headers] = head.slice(0, -4).split("\r\n")
    const [method = "", requestTarget = ""] = requestLine.split(" ")
    if (Option.getOrUndefined(headerValue(headers, "proxy-authorization")) !== authorization) {
      client.end(notYours)
      return
    }
    const where = destination(method, requestTarget)
    if (Option.isNone(where)) {
      client.end(badGateway)
      return
    }
    const { host, port, path } = where.value
    const dialed = yield* Effect.result(dialThrough(target, host, port))
    if (dialed._tag === "Failure") {
      yield* Effect.logWarning(`could not reach ${host}:${port} through the SOCKS proxy: ${dialed.failure.reason}`)
      client.end(badGateway)
      return
    }
    const { socket, early: held } = dialed.success
    if (path === undefined) {
      client.write("HTTP/1.1 200 Connection established\r\n\r\n")
    } else {
      // A plain HTTP request goes on in origin form, one per connection.
      const kept = headers.filter((line) => !bridgeHeader.test(line))
      socket.write(
        `${method} ${path} HTTP/1.1\r\n${kept.map((line) => `${line}\r\n`).join("")}connection: close\r\n\r\n`,
      )
    }
    pipeBoth(client, incoming.release(), socket, held)
  }).pipe(Effect.catch(() => Effect.sync(() => client.destroy())))

/**
 * Starts a bridge to `target` on 127.0.0.1, until the scope closes. Its
 * connections are served by fibers in the scope, so closing the scope ends
 * them too.
 */
export const bridge = (target: SocksTarget): Effect.Effect<Bridge, SocksFailed, Scope.Scope | Dns.Dns> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<Dns.Dns, void, never>()
    const secret = crypto.randomUUID()
    const authorization = `Basic ${btoa(`slopmax:${secret}`)}`
    const sockets = new Set<Socket>()
    const server = yield* Effect.acquireRelease(
      Effect.callback<Server, SocksFailed>((resume) => {
        const made = createServer((client) => {
          sockets.add(client)
          client.once("close", () => sockets.delete(client))
          client.on("error", () => undefined)
          run(serveOne(client, target, authorization))
        })
        made.once("error", (error) => resume(Effect.fail(new SocksFailed({ reason: error.message }))))
        made.listen(0, "127.0.0.1", () => {
          // The bridge never keeps the process alive by itself.
          made.unref()
          resume(Effect.succeed(made))
        })
      }),
      (made) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy()
          made.close(() => resume(Effect.void))
        }),
    )
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    return { url: `http://127.0.0.1:${port}`, authorization }
  })
