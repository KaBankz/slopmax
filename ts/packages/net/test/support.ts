// Local stand-ins for an upstream, an HTTP proxy, and a SOCKS5 proxy. Each
// listens on a loopback port and closes with the test's scope.
import { connect, createServer, type Server, type Socket } from "node:net"

import { Effect, type Scope } from "effect"

/** A Bun server answering with `fetch`, on a free loopback port. */
export const upstream = (
  fetch: (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>,
): Effect.Effect<
  { readonly url: string; readonly port: number; readonly server: Bun.Server<undefined> },
  never,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch, idleTimeout: 0 })
      return { url: `http://127.0.0.1:${server.port}`, port: server.port ?? 0, server }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  )

const listen = (server: Server): Effect.Effect<number, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            resolve(typeof address === "object" && address !== null ? address.port : 0)
          })
        }),
    ),
    () => Effect.sync(() => server.close()),
  )

const readHead = (socket: Socket): Promise<{ head: string; rest: Buffer }> =>
  new Promise((resolve) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n\r\n")
      if (end < 0) return
      socket.off("data", onData)
      resolve({ head: buffered.subarray(0, end + 4).toString("latin1"), rest: buffered.subarray(end + 4) })
    }
    socket.on("data", onData)
  })

const join = (a: Socket, b: Socket): void => {
  a.pipe(b)
  b.pipe(a)
  a.on("error", () => b.destroy())
  b.on("error", () => a.destroy())
}

/**
 * An HTTP proxy that records each request head. A CONNECT is tunnelled to
 * `127.0.0.1:{target}` whatever it names; a plain request is answered
 * `proxied` without going anywhere.
 */
export const httpProxy = (
  target: () => number,
): Effect.Effect<{ readonly url: string; readonly heads: Array<string> }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const heads: Array<string> = []
    const sockets = new Set<Socket>()
    const server = createServer((client) => {
      sockets.add(client)
      client.on("error", () => undefined)
      void readHead(client).then(({ head, rest }) => {
        heads.push(head)
        if (head.startsWith("CONNECT ")) {
          const up = connect(target(), "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection established\r\n\r\n")
            if (rest.length > 0) up.write(rest)
            join(client, up)
          })
          sockets.add(up)
        } else {
          client.end("HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied")
        }
      })
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => sockets.forEach((s) => s.destroy())))
    const port = yield* listen(server)
    return { url: `http://127.0.0.1:${port}`, heads }
  })

/** What a SOCKS5 client asked for. */
export interface SocksRequest {
  readonly methods: Array<number>
  readonly auth: readonly [string, string] | undefined
  readonly kind: number
  readonly host: string
  readonly port: number
}

/**
 * A SOCKS5 proxy that records each request and connects every one to
 * `127.0.0.1:{target}`. With `auth`, it wants exactly those credentials.
 */
export const socksProxy = (
  target: () => number,
  auth?: readonly [string, string],
): Effect.Effect<{ readonly port: number; readonly requests: Array<SocksRequest> }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const requests: Array<SocksRequest> = []
    const sockets = new Set<Socket>()
    const server = createServer((client) => {
      sockets.add(client)
      client.on("error", () => undefined)
      let buffered = Buffer.alloc(0)
      let waiting: { n: number; resolve: (b: Buffer) => void } | undefined
      const pump = (): void => {
        if (waiting !== undefined && buffered.length >= waiting.n) {
          const { n, resolve } = waiting
          waiting = undefined
          const out = buffered.subarray(0, n)
          buffered = buffered.subarray(n)
          resolve(out)
        }
      }
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk])
        pump()
      }
      client.on("data", onData)
      const need = (n: number): Promise<Buffer> =>
        new Promise((resolve) => {
          waiting = { n, resolve }
          pump()
        })
      void (async () => {
        const [, count = 0] = await need(2)
        const methods = [...(await need(count))]
        const wanted = auth === undefined ? 0 : 2
        if (!methods.includes(wanted)) return client.end(Uint8Array.of(5, 0xff))
        client.write(Uint8Array.of(5, wanted))
        let given: readonly [string, string] | undefined
        if (wanted === 2) {
          const [, userLength = 0] = await need(2)
          const user = (await need(userLength)).toString()
          const [passLength = 0] = await need(1)
          const pass = (await need(passLength)).toString()
          given = [user, pass]
          const ok = user === auth?.[0] && pass === auth[1]
          client.write(Uint8Array.of(1, ok ? 0 : 1))
          if (!ok) return client.end()
        }
        const [, , , kind = 0] = await need(4)
        let host: string
        if (kind === 1) host = [...(await need(4))].join(".")
        else if (kind === 4) host = (await need(16)).toString("hex")
        else host = (await need((await need(1))[0] ?? 0)).toString()
        const portBytes = await need(2)
        requests.push({ methods, auth: given, kind, host, port: portBytes.readUInt16BE(0) })
        const up = connect(target(), "127.0.0.1", () => {
          client.off("data", onData)
          client.write(Uint8Array.of(5, 0, 0, 1, 127, 0, 0, 1, 0, 0))
          if (buffered.length > 0) up.write(buffered)
          join(client, up)
        })
        sockets.add(up)
        up.on("error", () => client.end(Uint8Array.of(5, 5, 0, 1, 0, 0, 0, 0, 0, 0)))
      })()
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => sockets.forEach((s) => s.destroy())))
    const port = yield* listen(server)
    return { port, requests }
  })
