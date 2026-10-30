// Inbound HTTP/1.1 on Bun's server: keep-alive, WebSocket upgrades that can
// set headers on the `101`, and graceful shutdown. Routing is the handler's
// business: it is an `effect/http` app (an `HttpRouter`, or any effect
// answering the `HttpServerRequest`).
//
// Bun's server sets `TCP_NODELAY` on every accepted connection. Streamed
// answers are many small writes; Nagle's algorithm would hold each until
// the client acknowledges the last, and clients delay acknowledgments by
// up to 40 ms.
// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import http from "node:http"
import process from "node:process"

import { Context, Data, Duration, Effect, Layer, Result, type Scope } from "effect"
import {
  HttpEffect,
  type HttpMiddleware,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import * as NetAddress from "effect/net/NetAddress"

import { errorCode } from "./conn.ts"
import { closePayload, MAX_MESSAGE, type Message, type MessageReader, type MessageWriter, WsError } from "./ws.ts"

/** How long a client may take to send its request headers. */
export const HEADER_TIMEOUT = Duration.seconds(30)
/** How long shutdown waits for in-flight requests (long streams included). */
export const DRAIN = Duration.seconds(10)

// hyper's limit on a request head (its read buffer: 8 KiB + 100 × 4 KiB);
// Bun's default is 16 KiB.
const MAX_HEAD = 8192 + 4096 * 100
// How often shutdown looks for in-flight requests.
const DRAIN_POLL = Duration.millis(20)

/** The address could not be listened on. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly address: string
  /** The system's code, `EADDRINUSE` for a port that is taken. */
  readonly code: string | undefined
  readonly reason: string
}> {
  override get message(): string {
    return `cannot listen on ${this.address}: ${this.reason}`
  }
}

/** A WebSocket upgrade that could not happen. */
export class UpgradeError extends Data.TaggedError("UpgradeError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason
  }
}

type Handler = (request: Request, server: Bun.Server<ServerSocket>) => Promise<Response | undefined> | Response

const notServing: Handler = () => new Response("not found", { status: 404 })

/** A bound server: listening, answering 404 until something is served on it. */
export interface Listener {
  readonly hostname: string
  readonly port: number
  /** Serves `app` until the scope closes. */
  readonly serve: <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    middleware?: HttpMiddleware.HttpMiddleware,
  ) => Effect.Effect<void, never, Exclude<R, HttpServerRequest.HttpServerRequest | Scope.Scope> | Scope.Scope>
  /**
   * Stops accepting, closes idle connections, and waits up to 10 s for
   * in-flight requests before cutting what is left. Runs once.
   */
  readonly shutdown: Effect.Effect<void>
}

// What the handler needs to answer a request, by the request.
interface Pending {
  readonly request: Request
  readonly resolve: (response: Response | undefined) => void
  readonly server: Bun.Server<ServerSocket>
  /** Gives the connection the header timeout again, for its next request. */
  readonly rearm: () => void
  answered: boolean
  upgraded: boolean
}

const pending = new WeakMap<Request, Pending>()

// The web request under an `effect/http` one served here.
const entryOf = (request: HttpServerRequest.HttpServerRequest): Pending | undefined =>
  request.source instanceof Request ? pending.get(request.source) : undefined

/**
 * Listens on `hostname:port` (port 0 picks one). The scope's end shuts the
 * server down gracefully.
 */
export const bind = Effect.fn("server.bind")(function* (options: {
  readonly hostname: string
  readonly port: number
  /** For tests: the header timeout, in whole seconds. */
  readonly headerTimeout?: Duration.Input | undefined
}) {
  let current: Handler = notServing
  // Bun reads the limit when it parses a request; raise it, never lower it.
  if (http.maxHeaderSize < MAX_HEAD) Reflect.set(http, "maxHeaderSize", MAX_HEAD)
  const headerSeconds = Math.max(1, Math.round(Duration.toSeconds(options.headerTimeout ?? HEADER_TIMEOUT)))
  const address = options.hostname.includes(":")
    ? `[${options.hostname}]:${options.port}`
    : `${options.hostname}:${options.port}`
  const server = yield* Effect.try({
    try: () =>
      Bun.serve<ServerSocket>({
        hostname: options.hostname,
        port: options.port,
        // Bun's idle timeout covers a client sending its headers and an idle
        // keep-alive connection; a request being answered turns it off, and
        // its answer, once sent, turns it back on.
        idleTimeout: headerSeconds,
        // hyper set no limit; callers bound what they buffer.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        fetch: (request, bun) => current(request, bun),
        websocket: {
          maxPayloadLength: MAX_MESSAGE,
          // One whole message may wait to be sent.
          backpressureLimit: MAX_MESSAGE + 1024 * 1024,
          closeOnBackpressureLimit: false,
          idleTimeout: 0,
          sendPings: false,
          perMessageDeflate: false,
          open: (ws) => ws.data.opened(ws),
          message: (ws, data) => ws.data.received(typeof data === "string" ? data : view(data)),
          pong: (ws, data) => ws.data.ponged(view(data)),
          close: (ws, code, reason) => ws.data.closed(code, reason),
          drain: (ws) => ws.data.drained(),
        },
      }),
    catch: (cause) =>
      new ListenError({
        address,
        code: cause instanceof Error ? errorCode(cause) : undefined,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

  // In-flight requests, not upgraded sockets: those left the server as
  // hyper's upgraded connections did, and end with the process.
  const drained: Effect.Effect<void> = Effect.suspend(() =>
    server.pendingRequests === 0 ? Effect.void : Effect.andThen(Effect.sleep(DRAIN_POLL), drained),
  )
  const shutdown = yield* Effect.cached(
    Effect.sync(() => void server.stop(false).catch(() => undefined)).pipe(
      Effect.andThen(Effect.timeoutOrElse(drained, { duration: DRAIN, orElse: () => Effect.void })),
      Effect.andThen(Effect.promise(() => server.stop(true).catch(() => undefined))),
    ),
  )
  yield* Effect.addFinalizer(() => shutdown)

  const serve = <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    middleware?: HttpMiddleware.HttpMiddleware,
  ): Effect.Effect<void, never, Exclude<R, HttpServerRequest.HttpServerRequest | Scope.Scope> | Scope.Scope> =>
    Effect.gen(function* () {
      // TypeScript cannot see that the request's context below holds what
      // `handled` needs (`Exclude<R | A, S>` is `Exclude<R, A | S> | A`).
      const services = (yield* Effect.context<
        Exclude<R, HttpServerRequest.HttpServerRequest | Scope.Scope>
      >()) as Context.Context<never>
      // The request's scope ends once its answer is sent (a streamed one
      // included); then the connection waits for its next request's headers.
      const timed = Effect.andThen(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* Effect.addFinalizer(() => Effect.sync(() => entryOf(request)?.rearm()))
        }),
        app,
      )
      const handled = HttpEffect.toHandled(
        timed,
        (request, response) =>
          Effect.sync(() => {
            const entry = entryOf(request)
            if (entry === undefined || entry.answered) return
            entry.answered = true
            if (entry.upgraded) return entry.resolve(undefined)
            const withoutBody = request.method === "HEAD"
            entry.resolve(
              HttpServerResponse.toWeb(
                HttpServerResponse.omitsBody(response, withoutBody)
                  ? response
                  : HttpEffect.scopeTransferToStream(response),
                { withoutBody, context: services, signal: entry.request.signal },
              ),
            )
          }),
        middleware,
      ) as Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>
      const handler: Handler = (request, bun) => {
        // The headers are in: no time limit while the answer streams.
        bun.timeout(request, 0)
        return new Promise((resolve) => {
          const entry: Pending = {
            request,
            resolve,
            server: bun,
            rearm: () => {
              if (entry.upgraded) return
              try {
                bun.timeout(request, headerSeconds)
              } catch {
                // The connection is gone.
              }
            },
            answered: false,
            upgraded: false,
          }
          pending.set(request, entry)
          const context = Context.add(services, HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))
          const fiber = Effect.runForkWith(context)(handled)
          request.signal.addEventListener(
            "abort",
            () => {
              // Bun aborts the signal when an upgraded socket closes; that is
              // not the client going away.
              if (!entry.upgraded) fiber.interruptUnsafe(undefined, HttpServerError.ClientAbort.annotation)
            },
            { once: true },
          )
        })
      }
      current = handler
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (current === handler) current = notServing
        }),
      )
    })

  return {
    hostname: server.hostname ?? options.hostname,
    port: server.port ?? options.port,
    serve,
    shutdown,
  } satisfies Listener
})

/** An `HttpServer` for `effect/http`, on a {@link bind}ed listener. */
export const make = (options: {
  readonly hostname: string
  readonly port: number
}): Effect.Effect<HttpServer.HttpServer["Service"], ListenError, Scope.Scope> =>
  Effect.map(bind(options), (listener) =>
    HttpServer.make({
      address: Result.getOrElse(NetAddress.inetAddressFromIpString(listener.hostname, listener.port), () =>
        NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", listener.port),
      ),
      serve: (app, middleware) => listener.serve(app, middleware),
    }),
  )

/** {@link make} as a layer. */
export const layer = (options: {
  readonly hostname: string
  readonly port: number
}): Layer.Layer<HttpServer.HttpServer, ListenError> => Layer.effect(HttpServer.HttpServer, make(options))

/**
 * Serves `app` on `listener` until `shutdown` completes, then lets
 * in-flight requests finish for a moment.
 */
export const serve = <E, R>(
  listener: Listener,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  shutdown: Effect.Effect<void>,
): Effect.Effect<void, never, Exclude<R, HttpServerRequest.HttpServerRequest | Scope.Scope>> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* listener.serve(app)
      yield* shutdown
      yield* listener.shutdown
    }),
  )

// A plain view of a Buffer Bun hands over, without copying it.
const view = (data: Buffer): Uint8Array => new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

// Cuts `reason` to at most 123 bytes of UTF-8 at a character boundary, as a
// close frame has room for.
const closeReason = (reason: string): string => {
  const bytes = closePayload(0, reason).subarray(2)
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (text.endsWith("�") && !reason.startsWith(text)) text = text.slice(0, -1)
  return text
}

/**
 * The server side of an upgraded WebSocket, framed by Bun. Bun answers a
 * client's ping itself, so pings never reach {@link message}; pongs do.
 */
export class ServerSocket implements MessageReader, MessageWriter {
  private ws: Bun.ServerWebSocket<ServerSocket> | undefined
  private readonly queue: Array<Message> = []
  private ended = false
  private readonly waiters: Array<() => void> = []
  private readonly drains: Array<() => void> = []
  private readonly opens: Array<() => void> = []

  private wake(list: Array<() => void>): void {
    for (const waiter of list.splice(0)) waiter()
  }

  /** @internal */
  opened(ws: Bun.ServerWebSocket<ServerSocket>): void {
    this.ws = ws
    this.wake(this.opens)
  }

  /** @internal */
  received(data: string | Uint8Array): void {
    this.queue.push(typeof data === "string" ? { _tag: "Text", text: data } : { _tag: "Binary", data })
    this.wake(this.waiters)
  }

  /** @internal */
  ponged(data: Uint8Array): void {
    this.queue.push({ _tag: "Pong", data })
    this.wake(this.waiters)
  }

  /** @internal */
  closed(code: number, reason: string): void {
    // 1005: a close without a status; 1006: no close at all, the connection
    // just ended.
    if (code === 1005) this.queue.push({ _tag: "Close", close: undefined })
    else if (code !== 1006) this.queue.push({ _tag: "Close", close: { code, reason } })
    this.ended = true
    this.wake(this.waiters)
    this.wake(this.drains)
    this.wake(this.opens)
  }

  /** @internal */
  drained(): void {
    this.wake(this.drains)
  }

  // Waits on `list` until woken; an interrupted wait leaves nothing behind.
  private wait(list: Array<() => void>): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      const waiter = (): void => resume(Effect.void)
      list.push(waiter)
      return Effect.sync(() => {
        const at = list.indexOf(waiter)
        if (at >= 0) list.splice(at, 1)
      })
    })
  }

  /** @internal */
  readonly open: Effect.Effect<void> = Effect.suspend(() =>
    this.ws !== undefined || this.ended ? Effect.void : this.wait(this.opens),
  )

  /** The next message, or undefined when the connection ends. */
  readonly message: Effect.Effect<Message | undefined, WsError> = Effect.callback<Message | undefined>((resume) => {
    const take = (): boolean => {
      const next = this.queue.shift()
      if (next !== undefined) {
        resume(Effect.succeed(next))
        return true
      }
      if (this.ended) {
        resume(Effect.succeed(undefined))
        return true
      }
      return false
    }
    if (take()) return
    const waiter = (): void => {
      if (!take()) this.waiters.push(waiter)
    }
    this.waiters.push(waiter)
    return Effect.sync(() => {
      const at = this.waiters.indexOf(waiter)
      if (at >= 0) this.waiters.splice(at, 1)
    })
  })

  private drain(): Effect.Effect<void> {
    return Effect.suspend(() => (this.ended ? Effect.void : this.wait(this.drains)))
  }

  readonly send = (message: Message): Effect.Effect<void, WsError> =>
    Effect.suspend(() => {
      const ws = this.ws
      if (ws === undefined || this.ended || ws.readyState !== 1) {
        // A close after the socket closed has nothing left to do.
        return message._tag === "Close" ? Effect.void : Effect.fail(new WsError({ reason: "the socket is closed" }))
      }
      let status: number
      switch (message._tag) {
        case "Text":
          status = ws.sendText(message.text)
          break
        case "Binary":
          status = ws.sendBinary(message.data)
          break
        case "Ping":
          status = ws.ping(message.data)
          break
        case "Pong":
          status = ws.pong(message.data)
          break
        case "Close":
          if (message.close === undefined) ws.close()
          else ws.close(message.close.code, closeReason(message.close.reason))
          return Effect.void
      }
      if (status === 0) return Effect.fail(new WsError({ reason: "the message was dropped" }))
      // -1: queued behind earlier messages; wait until they are out.
      return status < 0 ? this.drain() : Effect.void
    })
}

/**
 * Upgrades the current request to a WebSocket, sending `headers` with the
 * `101`. Works on requests served by {@link bind}.
 */
export const upgrade = Effect.fn("server.upgrade")(function* (headers?: Bun.HeadersInit) {
  const entry = entryOf(yield* HttpServerRequest.HttpServerRequest)
  if (entry === undefined || entry.upgraded || entry.answered) {
    return yield* new UpgradeError({ reason: "this request cannot be upgraded" })
  }
  const socket = new ServerSocket()
  const ok = entry.server.upgrade(entry.request, headers === undefined ? { data: socket } : { headers, data: socket })
  if (!ok) return yield* new UpgradeError({ reason: "not a WebSocket upgrade" })
  entry.upgraded = true
  yield* socket.open
  return socket
})

/**
 * The program listening on TCP `port`, as `name (pid N)`, when the
 * system says. Used to explain a port that is already taken.
 */
export const portHolder = (port: number): Effect.Effect<string | undefined> =>
  Effect.sync(() =>
    process.platform === "linux" ? linuxHolder(port) : process.platform === "darwin" ? macHolder(port) : undefined,
  )

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const linuxHolder = (port: number): string | undefined => {
  // Listening sockets of that port, by inode…
  const inodes: Array<string> = []
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = read(table)
    if (text === undefined) continue
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      const local = fields[1]?.split(":").at(-1)
      const inode = fields[9]
      if (local !== undefined && Number.parseInt(local, 16) === port && fields[3] === "0A" && inode !== undefined) {
        inodes.push(inode)
      }
    }
  }
  if (inodes.length === 0) return undefined
  // …and the process holding one of them.
  const targets = new Set(inodes.map((inode) => `socket:[${inode}]`))
  let pids: Array<string>
  try {
    pids = readdirSync("/proc")
  } catch {
    return undefined
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    let fds: Array<string>
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (targets.has(target)) return `${(read(`/proc/${pid}/comm`) ?? "").trim()} (pid ${pid})`
    }
  }
  // The socket belongs to a process this user cannot see.
  return "another user's program"
}

const macHolder = (port: number): string | undefined => {
  const output = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8" })
  if (output.error !== undefined || typeof output.stdout !== "string") return undefined
  const lines = output.stdout.split("\n")
  const pid = lines.find((line) => line.startsWith("p"))?.slice(1)
  if (pid === undefined) return undefined
  const name = lines.find((line) => line.startsWith("c"))?.slice(1) ?? "a program"
  return `${name} (pid ${pid})`
}
