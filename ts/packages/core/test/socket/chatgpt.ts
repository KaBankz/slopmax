// ChatGPT's WebSocket endpoint as the relay's tests need it: a loopback
// server that answers Codex's socket by the bearer token the account holds,
// and records every handshake, message, ping and close it sees.
import { createHash } from "node:crypto"
import { createServer, type Socket } from "node:net"
import { Effect, type Scope } from "effect"

/** One handshake the endpoint saw. */
export interface Handshake {
  readonly path: string
  readonly headers: Headers
  readonly token: string | undefined
}

/** One message the endpoint received, with the token of the socket it came on. */
export interface Got {
  readonly token: string
  readonly message: string | Uint8Array
}

/** What the endpoint saw. */
export interface Chatgpt {
  /** `http://127.0.0.1:<port>`: where tests send `https://chatgpt.com`. */
  readonly origin: string
  readonly handshakes: Array<Handshake>
  readonly got: Array<Got>
  readonly pings: Array<string>
  readonly closes: Array<{ readonly token: string; readonly code: number; readonly reason: string }>
  /** Waits until the endpoint has seen `count` sockets close. */
  readonly closed: (count: number) => Effect.Effect<void>
  /** The texts received on sockets with `token`, as JSON. */
  readonly sent: (token: string) => ReadonlyArray<unknown>
}

export interface Data {
  readonly token: string
}

const now = () => Math.floor(Date.now() / 1000)

/** A `codex.rate_limits` event: the 5-hour window `used` percent used. */
export const rateLimits = (used: number) => ({
  type: "codex.rate_limits",
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: { used_percent: used, window_minutes: 300, reset_at: now() + 3600 },
    secondary: null,
  },
})

/** A turn that runs to its end: created, the windows, a word, completed with usage. */
const answer = (send: (event: unknown) => void) => {
  send({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })
  send(rateLimits(33))
  send({ type: "response.output_text.delta", delta: "Hi" })
  send({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 4 },
    },
  })
}

export type Script = (
  send: (event: unknown) => void,
  ws: Bun.ServerWebSocket<Data>,
  message: string | Uint8Array,
) => void

const onTurn =
  (turn: (send: (event: unknown) => void) => void): Script =>
  (send, _ws, message) => {
    if (typeof message === "string" && message.includes('"response.create"')) turn(send)
  }

/**
 * The scripts, by token:
 * - `tok-ok`, `tok-also`: each turn runs to its end, the 5-hour window 33% used;
 * - `tok-limited`: each turn hears `usage_limit_reached`, for 90 minutes;
 * - `tok-busy`: each turn fails `server_is_overloaded`;
 * - `tok-badreq`: each turn fails `context_length_exceeded`, the request's own fault;
 * - `tok-echo`: every message comes back as it came; `ping-me`, `close-me` and
 *   `drop-me` make it ping, close with 4001, or drop the connection, and
 *   `flood-<n>` makes it send `n` binary messages of {@link floodSize} bytes at once,
 *   each starting with its index.
 * Any other token is refused with 401.
 */
/** The size of each message a flood sends. */
export const floodSize = 1024 * 1024

/** The `index`th message of a flood: its index in the first four bytes, then a pattern. */
export const floodMessage = (index: number): Uint8Array => {
  const out = new Uint8Array(floodSize)
  for (let at = 4; at < floodSize; at++) out[at] = at % 251
  new DataView(out.buffer).setUint32(0, index)
  return out
}

export const scripts: Readonly<Record<string, Script>> = {
  "tok-ok": onTurn(answer),
  "tok-also": onTurn(answer),
  "tok-limited": onTurn((send) =>
    send({
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: now() + 5400 },
    }),
  ),
  "tok-busy": onTurn((send) =>
    send({ type: "response.failed", response: { id: "resp_2", error: { code: "server_is_overloaded" } } }),
  ),
  "tok-badreq": onTurn((send) =>
    send({ type: "response.failed", response: { id: "resp_3", error: { code: "context_length_exceeded" } } }),
  ),
  "tok-echo": (_send, ws, message) => {
    if (message === "ping-me") return ws.ping()
    if (message === "close-me") return ws.close(4001, "done")
    if (message === "drop-me") return ws.terminate()
    if (typeof message === "string" && message.startsWith("flood-")) {
      for (let index = 0; index < Number(message.slice("flood-".length)); index++) ws.send(floodMessage(index))
      return
    }
    ws.send(message)
  },
}

/** The bearer token a request or handshake carried. */
export const tokenOf = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization")
  return authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined
}

const decoder = new TextDecoder()

/** ChatGPT's socket endpoint on loopback, for the life of the scope. */
export const chatgpt: Effect.Effect<Chatgpt, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => {
    const handshakes: Array<Handshake> = []
    const got: Array<Got> = []
    const pings: Array<string> = []
    const closes: Array<{ readonly token: string; readonly code: number; readonly reason: string }> = []
    const waiting = new Set<() => void>()
    const server = Bun.serve<Data>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, srv) => {
        const token = tokenOf(request.headers)
        handshakes.push({ path: new URL(request.url).pathname, headers: request.headers, token })
        if (token === undefined || scripts[token] === undefined) return new Response("invalid token", { status: 401 })
        const upgraded = srv.upgrade(request, {
          headers: { "openai-model": "gpt-6-sol", "x-reasoning-included": "true", "x-models-etag": "etag-1" },
          data: { token },
        })
        return upgraded ? undefined : new Response("not a socket", { status: 400 })
      },
      websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        // A flood is held for the relay however far behind it falls, as a real server would.
        backpressureLimit: 1024 * 1024 * 1024,
        message: (ws, message) => {
          const bytes = typeof message === "string" ? message : new Uint8Array(message)
          got.push({ token: ws.data.token, message: bytes })
          scripts[ws.data.token]?.((event) => void ws.send(JSON.stringify(event)), ws, bytes)
        },
        ping: (ws) => void pings.push(ws.data.token),
        pong: (ws) => void ws.send("ponged"),
        close: (ws, code, reason) => {
          closes.push({ token: ws.data.token, code, reason })
          for (const wake of waiting) wake()
        },
      },
    })
    const endpoint: Chatgpt = {
      origin: `http://127.0.0.1:${server.port ?? 0}`,
      handshakes,
      got,
      pings,
      closes,
      closed: (count) =>
        Effect.callback<void>((resume) => {
          const wake = () => {
            if (closes.length < count) return
            waiting.delete(wake)
            resume(Effect.void)
          }
          waiting.add(wake)
          wake()
          return Effect.sync(() => waiting.delete(wake))
        }),
      sent: (token) =>
        got
          .filter((each) => each.token === token && typeof each.message === "string")
          .map((each) => (typeof each.message === "string" ? JSON.parse(each.message) : decoder.decode(each.message))),
    }
    return { server, endpoint }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
).pipe(Effect.map(({ endpoint }) => endpoint))

/** The accept key a server answers a handshake's `sec-websocket-key` with. */
const acceptKey = (key: string): string =>
  createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")

/**
 * A ChatGPT that opens every socket and then stops reading from it, for the
 * life of the scope: what a client sends piles up on slopmax's side.
 */
export const stalledChatgpt: Effect.Effect<{ readonly origin: string }, never, Scope.Scope> = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
    const open = new Set<Socket>()
    const server = createServer((socket) => {
      open.add(socket)
      socket.on("close", () => open.delete(socket))
      socket.on("error", () => socket.destroy())
      let head = ""
      const onData = (chunk: Uint8Array) => {
        head += decoder.decode(chunk)
        if (!head.includes("\r\n\r\n")) return
        socket.off("data", onData)
        socket.pause()
        const key = /^sec-websocket-key:\s*(\S+)/im.exec(head)?.[1] ?? ""
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        )
      }
      socket.on("data", onData)
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${port}`,
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
