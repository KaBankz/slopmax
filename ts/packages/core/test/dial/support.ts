// What the socket tests dial: an echo server (plain or TLS, with a
// certificate made for these tests), a CONNECT proxy that counts its
// tunnels, and a client that collects what a socket receives.
import { connect, createServer, type Socket } from "node:net"
import { Data, Duration, Effect, Queue, type Scope } from "effect"
import type { WebSocket } from "ws"
import { dial, type UpstreamSocket } from "../../src/dial.ts"

/**
 * A self-signed certificate for `localhost` and 127.0.0.1, valid for a
 * hundred years, and its key. Made once with `openssl req -x509 -newkey ec
 * -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj
 * /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1`. It
 * secures nothing: it lets the tests dial `wss` on loopback.
 */
export const testTls = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUGnLlsUbBy/zcGhq6bqAkDKPGNE8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAzMTIxMzE1OVoYDzIxMjYxMDA3
MjEzMTU5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQONRiQivBJZNNClSrTUrGI8I4YE1KO9FZyCBEm2lcDyDpjWMsAx04T
oovtM24s0K7iTZDIladP7H3x4zQXNobqo28wbTAdBgNVHQ4EFgQUzDeVDS0LwHA3
B6eA3NzdmRy3jOMwHwYDVR0jBBgwFoAUzDeVDS0LwHA3B6eA3NzdmRy3jOMwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAP2CS6pZz4CYrR5Um2zoE5mzYW9a95L3DMW2NTxwTmKiAiBY
FTtYyzfnkLSl4SagcmkfY2Aa60pKeSkPi2D1I5WxUA==
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgeT9szpmhEin1waSH
wJ1fLD+6TG3TL56NVyma6skTnPOhRANCAAQONRiQivBJZNNClSrTUrGI8I4YE1KO
9FZyCBEm2lcDyDpjWMsAx04ToovtM24s0K7iTZDIladP7H3x4zQXNobq
-----END PRIVATE KEY-----`,
} as const

/** One message a socket received, or its close. */
export type Received = Data.TaggedEnum<{
  Text: { readonly text: string }
  Binary: { readonly bytes: Uint8Array }
  Closed: { readonly code: number; readonly reason: string }
}>
export const Received = Data.taggedEnum<Received>()

/** A handshake the client could not complete. */
export class Refused extends Data.TaggedError("Refused")<{
  readonly status: number | undefined
  readonly reason: string
}> {}

/** A client socket, and what it received in order. */
export interface Client {
  readonly raw: WebSocket
  /** The headers of the 101 that opened it. */
  readonly upgrade: Headers
  /** Waits for the next message (at most 5 s of real time). */
  readonly next: Effect.Effect<Received>
  /** Waits for the close, skipping any messages before it. */
  readonly closed: Effect.Effect<{ readonly code: number; readonly reason: string }>
  /** Waits for the text event of `type`, returning it and every text event before it. */
  readonly until: (type: string) => Effect.Effect<ReadonlyArray<unknown>>
  /** Sends JSON as one text message. */
  readonly sendJson: (value: unknown) => void
}

const decoder = new TextDecoder()

const typeOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "type" in value ? value.type : undefined

/** What a dialed socket receives, one message at a time (at most 5 s of real time apart). */
export const inbox = (socket: UpstreamSocket): Effect.Effect<Effect.Effect<Received>> =>
  Effect.map(Queue.unbounded<Received>(), (queue) => {
    socket.listen({
      message: (bytes, binary) =>
        void Queue.offerUnsafe(
          queue,
          binary ? Received.Binary({ bytes }) : Received.Text({ text: decoder.decode(bytes) }),
        ),
      close: (code, reason) => void Queue.offerUnsafe(queue, Received.Closed({ code, reason })),
    })
    return Queue.take(queue).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () => Effect.die(new Error("no message within 5 s")),
      }),
    )
  })

/**
 * Opens a client socket to `url` with `headers`, as Codex would, for the
 * life of the scope. A handshake that is not upgraded fails with its status.
 */
export const openClient = (
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<Client, Refused, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* dial(new Headers(headers), { url, proxy: undefined, ca: [] }).pipe(
      Effect.mapError((error) => new Refused({ status: error.status, reason: error.reason })),
    )
    const next = yield* inbox(socket)
    const closed = Effect.gen(function* () {
      for (;;) {
        const message = yield* next
        if (message._tag === "Closed") return { code: message.code, reason: message.reason }
      }
    })
    const until = (type: string) =>
      Effect.gen(function* () {
        const seen: Array<unknown> = []
        for (;;) {
          const message = yield* next
          if (message._tag === "Closed") return yield* Effect.die(new Error(`closed ${message.code} before ${type}`))
          if (message._tag !== "Text") continue
          const event: unknown = JSON.parse(message.text)
          seen.push(event)
          if (typeOf(event) === type) return seen
        }
      })
    const raw = socket.raw
    return {
      raw,
      upgrade: socket.headers,
      next,
      closed,
      until,
      sendJson: (value: unknown) => raw.send(JSON.stringify(value)),
    }
  })

/** What an echo server saw. */
export interface Echo {
  /** `ws://127.0.0.1:<port>` (`wss://localhost:<port>` with TLS). */
  readonly url: string
  readonly port: number
  /** The headers of every handshake. */
  readonly handshakes: Array<Headers>
}

/** A WebSocket server that sends every message back as it came, plain or over TLS, for the life of the scope. */
export const echoServer = (tls?: {
  readonly cert: string
  readonly key: string
}): Effect.Effect<Echo, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const handshakes: Array<Headers> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        ...(tls === undefined ? {} : { tls }),
        fetch: (request, srv) => {
          handshakes.push(request.headers)
          return srv.upgrade(request, { headers: { "x-models-etag": "echo" } })
            ? undefined
            : new Response("not a socket", { status: 400 })
        },
        websocket: {
          maxPayloadLength: 64 * 1024 * 1024,
          message: (ws, message) => void ws.send(message),
        },
      })
      const port = server.port ?? 0
      return {
        server,
        echo: {
          url: tls === undefined ? `ws://127.0.0.1:${port}` : `wss://localhost:${port}`,
          port,
          handshakes,
        },
      }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map(({ echo }) => echo))

/** A CONNECT proxy on loopback: who asked to go where, and with what credentials. */
export interface ConnectProxy {
  readonly url: string
  /** Each tunnel's target (`host:port`) and its `proxy-authorization`, if any. */
  readonly tunnels: Array<{ readonly target: string; readonly authorization: string | undefined }>
}

const headerOf = (head: string, name: string): string | undefined => {
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":")
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim()
  }
  return undefined
}

/**
 * An HTTP CONNECT proxy for the life of the scope; it refuses tunnels without
 * `authorization` when one is required. With `to`, every tunnel goes there
 * whatever it names, so a name nobody can resolve reaches a server on loopback.
 */
export const connectProxy = (
  required: string | undefined = undefined,
  to: { readonly host: string; readonly port: number } | undefined = undefined,
): Effect.Effect<ConnectProxy, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ readonly proxy: ConnectProxy; readonly close: () => void }>((resume) => {
      const tunnels: Array<{ readonly target: string; readonly authorization: string | undefined }> = []
      const open = new Set<Socket>()
      const server = createServer((socket) => {
        open.add(socket)
        socket.on("close", () => open.delete(socket))
        socket.on("error", () => socket.destroy())
        let head = ""
        const onData = (chunk: Uint8Array) => {
          head += decoder.decode(chunk)
          const end = head.indexOf("\r\n\r\n")
          if (end < 0) return
          socket.off("data", onData)
          const [method = "", target = ""] = head.split(" ")
          const authorization = headerOf(head.slice(0, end), "proxy-authorization")
          tunnels.push({ target, authorization })
          if (method !== "CONNECT" || (required !== undefined && authorization !== required)) {
            socket.end("HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n")
            return
          }
          const colon = target.lastIndexOf(":")
          const port = to?.port ?? Number(target.slice(colon + 1))
          const out = connect(port, to?.host ?? target.slice(0, colon), () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            const rest = head.slice(end + 4)
            if (rest !== "") out.write(rest)
            out.pipe(socket)
            socket.pipe(out)
          })
          open.add(out)
          out.on("close", () => {
            open.delete(out)
            socket.destroy()
          })
          out.on("error", () => socket.destroy())
        }
        socket.on("data", onData)
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : 0
        resume(
          Effect.succeed({
            proxy: { url: `http://127.0.0.1:${port}`, tunnels },
            close: () => {
              for (const socket of open) socket.destroy()
              server.close()
            },
          }),
        )
      })
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ proxy }) => proxy))

/** A TCP listener that accepts connections and never answers, for the life of the scope. */
export const silentServer: Effect.Effect<{ readonly port: number }, never, Scope.Scope> = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
    const open = new Set<Socket>()
    const server = createServer((socket) => {
      open.add(socket)
      socket.on("error", () => socket.destroy())
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resume(
        Effect.succeed({
          port: typeof address === "object" && address !== null ? address.port : 0,
          close: () => {
            for (const socket of open) socket.destroy()
            server.close()
          },
        }),
      )
    })
  }),
  ({ close }) => Effect.sync(close),
)

/** The first `n` bytes of a repeating pattern, so a cut or reordered message shows. */
export const patterned = (n: number): Uint8Array => {
  const out = new Uint8Array(n)
  for (let index = 0; index < n; index++) out[index] = index % 251
  return out
}

/** Text of `n` bytes. */
export const patternedText = (n: number): string => {
  let text = ""
  for (let index = 0; index < n; index++) text += String.fromCharCode(97 + (index % 26))
  return text
}
