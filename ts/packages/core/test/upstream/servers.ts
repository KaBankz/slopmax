// Small real servers for the outbound tests: a provider stand-in on
// Bun.serve, an HTTP proxy, and a SOCKS5 proxy. Each lives on 127.0.0.1 at a
// port the system picks, records what it saw, and stops when its scope
// closes. Every host a proxy is asked for is answered by the provider
// stand-in, so tests can use names like `provider.test` that resolve nowhere.
import { connect, createServer, type Server, type Socket } from "node:net"
import { Effect, type Scope } from "effect"

/** A provider stand-in answering every request with `handler`. */
export const provider = (
  handler: (request: Request) => Response | Promise<Response>,
): Effect.Effect<{ readonly port: number; readonly url: string }, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })),
      (server) => Effect.promise(() => server.stop(true)),
    ),
    (server) => ({ port: server.port ?? 0, url: `http://127.0.0.1:${server.port}` }),
  )

/** A TCP server on 127.0.0.1, closed with its scope along with every connection to it. */
export const tcpServer = (onConnection: (socket: Socket) => void): Effect.Effect<number, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.callback<{ readonly server: Server; readonly sockets: Set<Socket> }>((resume) => {
        const sockets = new Set<Socket>()
        const server = createServer((socket) => {
          sockets.add(socket)
          socket.once("close", () => sockets.delete(socket))
          socket.on("error", () => undefined)
          onConnection(socket)
        })
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })))
      }),
      ({ server, sockets }) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resume(Effect.void))
        }),
    ),
    ({ server }) => {
      const address = server.address()
      return typeof address === "object" && address !== null ? address.port : 0
    },
  )

/** Reads a socket's bytes as they come: a given count, or up to a blank line. */
export const reader = (socket: Socket) => {
  let buffer = new Uint8Array(0)
  let wake: (() => void) | undefined
  let ended = false
  socket.on("data", (chunk: Uint8Array) => {
    const joined = new Uint8Array(buffer.length + chunk.length)
    joined.set(buffer)
    joined.set(chunk, buffer.length)
    buffer = joined
    wake?.()
  })
  socket.on("close", () => {
    ended = true
    wake?.()
  })
  const until = async (size: (bytes: Uint8Array) => number | undefined): Promise<Uint8Array> => {
    for (;;) {
      const found = size(buffer)
      if (found !== undefined) {
        const taken = buffer.slice(0, found)
        buffer = buffer.slice(found)
        return taken
      }
      if (ended) throw new Error("the connection closed")
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }
  return {
    take: (count: number) => until((bytes) => (bytes.length >= count ? count : undefined)),
    head: async () => {
      const bytes = await until((held) => {
        for (let index = 3; index < held.length; index++) {
          if (held[index] === 10 && held[index - 1] === 13 && held[index - 2] === 10 && held[index - 3] === 13) {
            return index + 1
          }
        }
        return undefined
      })
      return new TextDecoder().decode(bytes)
    },
    rest: () => {
      const rest = buffer
      buffer = new Uint8Array(0)
      return rest
    },
  }
}

const pipeBoth = (a: Socket, b: Socket, early: Uint8Array) => {
  if (early.length > 0) b.write(early)
  a.pipe(b)
  b.pipe(a)
  a.on("close", () => b.destroy())
  b.on("close", () => a.destroy())
  b.on("error", () => a.destroy())
}

/** What an HTTP proxy was asked. */
export interface ProxyRequest {
  readonly line: string
  readonly authorization: string | undefined
}

/**
 * An HTTP proxy that sends every request, plain (absolute form) or CONNECT,
 * to the provider stand-in on `targetPort`.
 */
export const httpProxy = (targetPort: number) =>
  Effect.gen(function* () {
    const seen: Array<ProxyRequest> = []
    const port = yield* tcpServer((client) => {
      const read = reader(client)
      void read.head().then(
        (head) => {
          const [line = "", ...headers] = head.trimEnd().split("\r\n")
          const authorization = headers
            .find((header) => header.toLowerCase().startsWith("proxy-authorization:"))
            ?.slice("proxy-authorization:".length)
            .trim()
          seen.push({ line, authorization })
          const upstream = connect({ host: "127.0.0.1", port: targetPort })
          const [method = "", target = ""] = line.split(" ")
          if (method === "CONNECT") {
            upstream.once("connect", () => {
              client.write("HTTP/1.1 200 Connection established\r\n\r\n")
              pipeBoth(client, upstream, read.rest())
            })
            return
          }
          const url = new URL(target)
          // One request per connection, so every request through the proxy is seen.
          const kept = headers.filter((header) => !/^(?:proxy-|connection:)/i.test(header))
          upstream.once("connect", () => {
            upstream.write(
              `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${kept.join("\r\n")}\r\nconnection: close\r\n\r\n`,
            )
            pipeBoth(client, upstream, read.rest())
          })
        },
        () => client.destroy(),
      )
    })
    return { port, seen }
  })

/** What a SOCKS5 proxy was asked to connect to: the address type and the address. */
export interface SocksRequest {
  readonly type: "ipv4" | "ipv6" | "name"
  readonly host: string
  readonly port: number
}

export interface SocksOptions {
  /** The user name and password it requires, if any. */
  readonly credentials?: readonly [string, string]
  /** The reply it gives a connect request; 0 succeeds. */
  readonly reply?: number
}

/** A SOCKS5 proxy (RFC 1928 and 1929) that connects every request to the provider stand-in on `targetPort`. */
export const socksProxy = (targetPort: number, options: SocksOptions = {}) =>
  Effect.gen(function* () {
    const seen: Array<SocksRequest> = []
    const serve = async (client: Socket) => {
      const read = reader(client)
      const [, count = 0] = await read.take(2)
      const methods = [...(await read.take(count))]
      const wanted = options.credentials === undefined ? 0 : 2
      if (!methods.includes(wanted)) {
        client.end(Uint8Array.of(5, 0xff))
        return
      }
      client.write(Uint8Array.of(5, wanted))
      if (options.credentials !== undefined) {
        const [, userLength = 0] = await read.take(2)
        const user = new TextDecoder().decode(await read.take(userLength))
        const [passwordLength = 0] = await read.take(1)
        const password = new TextDecoder().decode(await read.take(passwordLength))
        const ok = user === options.credentials[0] && password === options.credentials[1]
        client.write(Uint8Array.of(1, ok ? 0 : 1))
        if (!ok) {
          client.end()
          return
        }
      }
      const [, , , type] = await read.take(4)
      let request: SocksRequest
      if (type === 1) {
        const bytes = await read.take(4)
        const port = await read.take(2)
        request = { type: "ipv4", host: [...bytes].join("."), port: ((port[0] ?? 0) << 8) | (port[1] ?? 0) }
      } else if (type === 4) {
        const bytes = await read.take(16)
        const port = await read.take(2)
        const words = Array.from({ length: 8 }, (_, i) =>
          (((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0)).toString(16),
        )
        request = { type: "ipv6", host: words.join(":"), port: ((port[0] ?? 0) << 8) | (port[1] ?? 0) }
      } else {
        const [length = 0] = await read.take(1)
        const name = new TextDecoder().decode(await read.take(length))
        const port = await read.take(2)
        request = { type: "name", host: name, port: ((port[0] ?? 0) << 8) | (port[1] ?? 0) }
      }
      seen.push(request)
      const reply = options.reply ?? 0
      if (reply !== 0) {
        client.end(Uint8Array.of(5, reply, 0, 1, 0, 0, 0, 0, 0, 0))
        return
      }
      const upstream = connect({ host: "127.0.0.1", port: targetPort })
      upstream.once("connect", () => {
        client.write(Uint8Array.of(5, 0, 0, 1, 127, 0, 0, 1, 0, 0))
        pipeBoth(client, upstream, read.rest())
      })
      upstream.once("error", () => client.destroy())
    }
    const port = yield* tcpServer((client) => {
      void serve(client).catch(() => client.destroy())
    })
    return { port, seen }
  })

/** Sends raw bytes to a local port and returns everything that comes back until it closes. */
export const exchange = (port: number, messages: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port })
    const chunks: Array<Uint8Array> = []
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")))
    socket.once("connect", () => {
      for (const message of messages) socket.write(message)
    })
  })
