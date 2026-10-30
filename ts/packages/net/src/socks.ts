// SOCKS5 (RFC 1928, with RFC 1929 user/password auth): the handshake, and
// a loopback HTTP proxy that dials out through it. Bun's fetch speaks HTTP
// proxies only, so a client with a SOCKS5 proxy points fetch at the bridge.
import { Buffer } from "node:buffer"
import { lookup } from "node:dns/promises"
import { createServer, isIP } from "node:net"

import { ids } from "@slopmax/common"
import { Duration, Effect, Result } from "effect"

import { Conn, IoError, openTcpWithin } from "./conn.ts"

/** Where a SOCKS5 proxy is and how to talk to it. */
export interface SocksProxy {
  readonly host: string
  readonly port: number
  readonly auth: readonly [user: string, pass: string] | undefined
  /** Resolve names here (`socks5://`) rather than at the proxy (`socks5h://`). */
  readonly localDns: boolean
}

const fail = (what: string): IoError => new IoError({ reason: `SOCKS error: ${what}` })

const PARSING = "failed parsing server response"
const IO = "io error during SOCKS handshake"

const STATUS = [
  "success",
  "general server failure",
  "connection not allowed",
  "network unreachable",
  "host unreachable",
  "connection refused",
  "ttl expired",
  "command not supported",
  "address type not supported",
] as const

const utf8 = new TextEncoder()

const words = (part: string): Array<number> => (part === "" ? [] : part.split(":").map((w) => Number.parseInt(w, 16)))

const ipBytes = (text: string, family: number): Uint8Array =>
  family === 4 ? Uint8Array.of(1, ...text.split(".").map(Number)) : Uint8Array.of(4, ...ipv6Bytes(text))

/** The 16 bytes of an IPv6 address (without brackets). */
export const ipv6Bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(16)
  let tail = text
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4)
    tail = `${text.slice(0, v4.index)}${((Number(v4[1]) << 8) | Number(v4[2])).toString(16)}:${((Number(v4[3]) << 8) | Number(v4[4])).toString(16)}`
  const [head = "", rest] = tail.split("::")
  const front = words(head)
  const back = rest === undefined ? [] : words(rest)
  const all = [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back]
  all.forEach((word, i) => {
    out[i * 2] = word >> 8
    out[i * 2 + 1] = word & 0xff
  })
  return out
}

// The address part of a CONNECT request.
const address = (host: string, local: boolean): Effect.Effect<Uint8Array, IoError> => {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  const family = isIP(bare)
  if (family !== 0) return Effect.succeed(ipBytes(bare, family))
  const name = utf8.encode(bare)
  if (name.length > 255) return Effect.fail(fail("host address is more than 255 characters"))
  if (!local) return Effect.succeed(Uint8Array.of(3, name.length, ...name))
  return Effect.tryPromise({ try: () => lookup(bare), catch: () => fail(IO) }).pipe(
    Effect.map((found) => ipBytes(found.address, found.family)),
  )
}

/** Asks the SOCKS5 proxy on `conn` to connect to `host:port`. */
const handshake = Effect.fn("socks.handshake")(function* (conn: Conn, host: string, port: number, proxy: SocksProxy) {
  const target = yield* address(host, proxy.localDns)
  const read = (n: number) => Effect.mapError(conn.readExact(n), () => fail(IO))
  const write = (bytes: Uint8Array) => Effect.mapError(conn.write(bytes), () => fail(IO))
  const method = proxy.auth === undefined ? 0x00 : 0x02
  yield* write(Uint8Array.of(5, 1, method))
  const [version, chosen] = yield* read(2)
  if (version !== 5) return yield* fail(PARSING)
  if (chosen === 0xff) return yield* fail("server does not support user/pass authentication")
  if (chosen !== method) return yield* fail("server implements authentication incorrectly")
  if (proxy.auth !== undefined) {
    const user = utf8.encode(proxy.auth[0])
    const pass = utf8.encode(proxy.auth[1])
    yield* write(Uint8Array.of(1, user.length, ...user, pass.length, ...pass))
    const [, status] = yield* read(2)
    if (status !== 0) return yield* fail("credentials not accepted")
  }
  yield* write(Uint8Array.of(5, 1, 0, ...target, port >> 8, port & 0xff))
  const [answer, status, , kind] = yield* read(4)
  if (answer !== 5) return yield* fail(PARSING)
  const bound = kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? ((yield* read(1))[0] ?? 0) : -1
  if (bound < 0) return yield* fail(PARSING)
  yield* read(bound + 2)
  if (status !== 0) return yield* fail(STATUS[status ?? 1] ?? PARSING)
})

/**
 * A connection to `host:port` through the SOCKS5 proxy, the connect to the
 * proxy bounded by `connectTimeout`. Interrupted or failed, the connection
 * is closed.
 */
export const dial = (
  proxy: SocksProxy,
  host: string,
  port: number,
  connectTimeout: Duration.Duration,
): Effect.Effect<Conn, IoError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      restore(openTcpWithin(proxy.host, proxy.port, connectTimeout)).pipe(
        Effect.mapError(() => fail("failed to create underlying connection")),
      ),
      (socket) => {
        const conn = new Conn(socket)
        return restore(handshake(conn, host, port, proxy)).pipe(
          Effect.onError(() => Effect.sync(() => conn.destroy())),
          Effect.as(conn),
        )
      },
    ),
  )

const latin1 = new TextDecoder("latin1")

/** The header a request names itself with, so a failed dial can be told to its client. */
export const REQUEST_HEADER = "x-slopmax-socks"

// Why a request's dial failed, by the request's id, until its client asks.
const failures = new Map<string, string>()
const KEEP_FAILURES = 1024

/** Why the bridge could not dial for request `id`, once; undefined if it did. */
export const takeFailure = (id: string): string | undefined => {
  const reason = failures.get(id)
  failures.delete(id)
  return reason
}

const recordFailure = (id: string | undefined, reason: string): void => {
  if (id === undefined) return
  if (failures.size >= KEEP_FAILURES) {
    const oldest = failures.keys().next()
    if (oldest.done !== true) failures.delete(oldest.value)
  }
  failures.set(id, reason)
}

// A header's value in a request head, by its lowercase name.
const headerValue = (lines: ReadonlyArray<string>, name: string): string | undefined => {
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim()
  }
  return undefined
}

// Joins two sockets until either side ends.
const pipe = (a: Conn, b: Conn): void => {
  const early = a.detach()
  const held = b.detach()
  if (held.length > 0) a.socket.write(held)
  if (early.length > 0) b.socket.write(early)
  a.socket.pipe(b.socket)
  b.socket.pipe(a.socket)
  a.socket.on("error", () => b.socket.destroy())
  b.socket.on("error", () => a.socket.destroy())
  a.socket.on("close", () => b.socket.end())
  b.socket.on("close", () => a.socket.end())
}

const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
const NOT_YOURS =
  "HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"

// Headers that are the bridge's, not the upstream's.
const HOP = /^(connection|proxy-connection|proxy-authorization|keep-alive|x-slopmax-socks):/i

// One client of the bridge: a CONNECT (HTTPS) or an absolute-form request
// (plain HTTP), sent on through SOCKS5. Only fetches of this process know
// the bridge's credentials.
const relay = (client: Conn, proxy: SocksProxy, credentials: string, connectTimeout: Duration.Duration) =>
  Effect.gen(function* () {
    client.socket.setNoDelay(true)
    const head = latin1.decode(yield* client.readHead(64 * 1024, "unexpected end of file", "request head too long"))
    const lines = head.slice(0, -4).split("\r\n")
    const [method = "", target = ""] = (lines[0] ?? "").split(" ")
    const headers = lines.slice(1)
    if (headerValue(headers, "proxy-authorization") !== credentials) {
      client.socket.end(NOT_YOURS)
      return
    }
    const id = headerValue(headers, REQUEST_HEADER)
    let host: string
    let port: number
    let url: URL | undefined
    if (method === "CONNECT") {
      const colon = target.lastIndexOf(":")
      host = target.slice(0, colon)
      port = Number(target.slice(colon + 1))
    } else {
      // Plain HTTP: the request line names the whole URL.
      url = URL.parse(target) ?? undefined
      if (url === undefined) {
        client.socket.end(BAD_GATEWAY)
        return
      }
      host = url.hostname
      port = Number(url.port || 80)
    }
    const up = yield* Effect.result(dial(proxy, host, port, connectTimeout))
    if (Result.isFailure(up)) {
      recordFailure(id, up.failure.reason)
      client.socket.end(BAD_GATEWAY)
      return
    }
    if (url === undefined) {
      client.socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
    } else {
      // Sent on in origin form, one request per connection.
      const kept = headers.filter((header) => !HOP.test(header))
      up.success.socket.write(
        `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${kept.map((h) => `${h}\r\n`).join("")}connection: close\r\n\r\n`,
      )
    }
    pipe(client, up.success)
  }).pipe(Effect.catch(() => Effect.sync(() => client.destroy())))

/** A running bridge: its proxy URL (with this process's credentials). */
export interface Bridge {
  readonly url: string
}

const bridges = new Map<string, Promise<Bridge>>()

/**
 * A loopback HTTP proxy that dials out through `proxy`, started on first
 * use and shared for the life of the process. It does not keep the process
 * alive, and it serves only requests carrying its random credentials.
 */
export const bridge = (proxy: SocksProxy, connectTimeout: Duration.Duration): Promise<Bridge> => {
  const key = JSON.stringify([
    proxy.host,
    proxy.port,
    proxy.auth ?? null,
    proxy.localDns,
    Duration.toMillis(connectTimeout),
  ])
  let started = bridges.get(key)
  if (started === undefined) {
    const secret = Buffer.from(ids.random(18)).toString("hex")
    const credentials = `Basic ${Buffer.from(`slopmax:${secret}`).toString("base64")}`
    started = new Promise<Bridge>((resolve, reject) => {
      const server = createServer((socket) => {
        socket.on("error", () => undefined)
        Effect.runFork(relay(new Conn(socket), proxy, credentials, connectTimeout))
      })
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.unref()
        const bound = server.address()
        const port = typeof bound === "object" && bound !== null ? bound.port : 0
        resolve({ url: `http://slopmax:${secret}@127.0.0.1:${port}` })
      })
    })
    bridges.set(key, started)
    started.catch(() => bridges.delete(key))
  }
  return started
}
