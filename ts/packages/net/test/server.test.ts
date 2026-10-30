// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { describe, expect } from "bun:test"
import { connect, createServer } from "node:net"
import process from "node:process"
import { it } from "@slopmax/test"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { Client } from "../src/client.ts"
import { bind, make, portHolder, serve, upgrade } from "../src/server.ts"
import { acceptKey, Message, newKey, Reader, Writer } from "../src/ws.ts"

const build = (builder = Client.builder()) =>
  builder.build().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))

const echoPath = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return HttpServerResponse.text(`${request.method} ${new URL(request.url, "http://x").pathname}`)
})

// Opens a WebSocket to `url` with the client's raw path; returns the socket
// and the `101`'s headers.
const openSocket = (url: string) =>
  Effect.gen(function* () {
    const client = yield* build()
    const key = newKey()
    const response = yield* client
      .get(url)
      .headers([
        ["upgrade", "websocket"],
        ["connection", "Upgrade"],
        ["sec-websocket-version", "13"],
        ["sec-websocket-key", key],
      ])
      .timeout("5 seconds")
      .send()
    expect(response.status).toBe(101)
    expect(response.headers.get("sec-websocket-accept")).toBe(acceptKey(key))
    const socket = yield* response.upgrade()
    return { headers: response.headers, reader: new Reader(socket), writer: Writer.client(socket), socket }
  })

describe("server", () => {
  it.live("serves_until_shutdown", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      const url = `http://127.0.0.1:${listener.port}/hi`
      const stop = yield* Deferred.make<void>()
      const server = yield* Effect.forkChild(serve(listener, echoPath, Deferred.await(stop)))
      const client = yield* build()
      const text = yield* Effect.flatMap(client.get(url).send(), (r) => r.text())
      expect(text).toBe("GET /hi")
      yield* Deferred.succeed(stop, undefined)
      const done = yield* Fiber.join(server).pipe(Effect.timeout("5 seconds"), Effect.as(true))
      expect(done).toBe(true)
    }),
  )

  it.live("names_the_program_holding_a_port", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux" && process.platform !== "darwin") return
      const listener = createServer()
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) =>
            listener.listen(0, "127.0.0.1", () => {
              const address = listener.address()
              resolve(typeof address === "object" && address !== null ? address.port : 0)
            }),
          ),
      )
      const holder = (yield* portHolder(port)) ?? ""
      expect(holder).toContain(`pid ${process.pid}`)
      yield* Effect.promise(() => new Promise<void>((resolve) => listener.close(() => resolve())))
      expect(yield* portHolder(port)).toBeUndefined()
    }),
  )

  it.live("a taken port fails with the system's code", () =>
    Effect.gen(function* () {
      const first = yield* bind({ hostname: "127.0.0.1", port: 0 })
      const error = yield* Effect.flip(bind({ hostname: "127.0.0.1", port: first.port }))
      expect(error.code).toBe("EADDRINUSE")
      expect(error.message.startsWith(`cannot listen on 127.0.0.1:${first.port}`)).toBe(true)
    }),
  )

  it.live("shutdown stops accepting and lets in-flight requests finish", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      const started = yield* Deferred.make<void>()
      yield* listener.serve(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Effect.sleep("300 millis")
          return HttpServerResponse.text("finished")
        }),
      )
      const client = yield* build()
      const url = `http://127.0.0.1:${listener.port}/`
      const inFlight = yield* Effect.forkChild(Effect.flatMap(client.get(url).send(), (r) => r.text()))
      yield* Deferred.await(started)
      const stopping = yield* Effect.forkChild(listener.shutdown)
      yield* Effect.sleep("50 millis")
      const late = yield* Effect.flip((yield* build()).get(url).send())
      expect(late.kind).toBe("Connect")
      expect(yield* Fiber.join(inFlight)).toBe("finished")
      yield* Fiber.join(stopping)
    }),
  )

  it.live(
    "a client that stalls in its headers is cut off; an answer may take its time",
    () =>
      Effect.gen(function* () {
        // Bun's idle timer ticks in seconds-long steps, so 1 s here cuts off
        // within about 12 s; the default is 30 s.
        const listener = yield* bind({ hostname: "127.0.0.1", port: 0, headerTimeout: "1 second" })
        yield* listener.serve(
          Effect.succeed(
            HttpServerResponse.stream(
              Stream.make("a", "b").pipe(
                Stream.mapEffect((part) => Effect.as(Effect.sleep("6 seconds"), new TextEncoder().encode(part))),
              ),
            ),
          ),
        )
        // Half a request head, then nothing.
        const stalled = Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const started = Date.now()
              const socket = connect(listener.port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nhost: x\r\n"))
              socket.on("close", () => resolve(Date.now() - started))
              socket.on("error", () => undefined)
              setTimeout(() => socket.destroy(), 20_000)
            }),
        )
        // A quiet answer, 6 s between chunks.
        const quiet = Effect.flatMap(build(), (client) =>
          Effect.flatMap(client.get(`http://127.0.0.1:${listener.port}/`).send(), (r) => r.text()),
        )
        // A kept-alive connection: one whole request, then half of the next.
        const quick = yield* bind({ hostname: "127.0.0.1", port: 0, headerTimeout: "1 second" })
        yield* quick.serve(Effect.succeed(HttpServerResponse.text("ok")))
        const second = Effect.promise(
          () =>
            new Promise<{ readonly answered: boolean; readonly closedAfter: number }>((resolve) => {
              let started = 0
              let seen = ""
              const socket = connect(quick.port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"))
              socket.on("data", (chunk) => {
                seen += chunk.toString()
                if (started === 0 && seen.endsWith("ok")) {
                  started = Date.now()
                  socket.write("GET / HTTP/1.1\r\nhost: x\r\n")
                }
              })
              socket.on("close", () => resolve({ answered: started > 0, closedAfter: Date.now() - started }))
              socket.on("error", () => undefined)
              setTimeout(() => socket.destroy(), 20_000)
            }),
        )
        const [closedAfter, text, kept] = yield* Effect.all([stalled, quiet, second], { concurrency: 3 })
        expect(closedAfter).toBeLessThan(16_000)
        expect(text).toBe("ab")
        expect(kept.answered).toBe(true)
        expect(kept.closedAfter).toBeLessThan(16_000)
      }),
    30_000,
  )

  it.live("request heads up to hyper's limit and bodies of any size reach the handler", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      yield* listener.serve(Effect.succeed(HttpServerResponse.text("handled")))
      const client = yield* build()
      const url = `http://127.0.0.1:${listener.port}/`
      const big = yield* client.get(url).header("x-big", "y".repeat(100_000)).send()
      expect(big.status).toBe(200)
      // Past Bun's 128 MiB default, announced and not sent.
      const answer = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            let seen = ""
            const socket = connect(listener.port, "127.0.0.1", () =>
              socket.write(`POST / HTTP/1.1\r\nhost: x\r\ncontent-length: ${200 * 1024 * 1024}\r\n\r\nabc`),
            )
            socket.on("data", (chunk) => {
              seen += chunk.toString()
              if (seen.includes("\r\n\r\n")) {
                socket.destroy()
                resolve(seen.split("\r\n")[0] ?? "")
              }
            })
            socket.on("error", () => resolve(seen))
          }),
      )
      expect(answer).toBe("HTTP/1.1 200 OK")
    }),
  )

  it.live("shutdown does not wait for open WebSockets", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      yield* listener.serve(
        Effect.gen(function* () {
          const socket = yield* upgrade()
          while ((yield* socket.message) !== undefined);
          return HttpServerResponse.empty()
        }),
      )
      const open = yield* openSocket(`http://127.0.0.1:${listener.port}/ws`)
      const started = Date.now()
      yield* listener.shutdown
      expect(Date.now() - started).toBeLessThan(2_000)
      // The socket goes with the server, as it went with the process in Rust.
      const last = yield* open.reader.message
      expect(last === undefined || last._tag === "Close").toBe(true)
    }),
  )

  it.live("messages that wait to be read keep their bytes", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      yield* listener.serve(
        Effect.gen(function* () {
          const socket = yield* upgrade()
          yield* Effect.sleep("200 millis")
          for (;;) {
            const message = yield* socket.message
            if (message === undefined || message._tag === "Close") break
            if (message._tag === "Binary") yield* socket.send(Message.text([...message.data].join(",")))
          }
          return HttpServerResponse.empty()
        }),
      )
      const open = yield* openSocket(`http://127.0.0.1:${listener.port}/ws`)
      for (const n of [1, 2, 3]) yield* open.writer.send(Message.binary(Uint8Array.of(n, n, n)))
      for (const n of [1, 2, 3]) expect(yield* open.reader.message).toEqual(Message.text(`${n},${n},${n}`))
      yield* open.writer.send(Message.close(1000, ""))
    }),
  )

  it.live("make is an effect/http HttpServer: routers serve on it", () =>
    Effect.gen(function* () {
      const server = yield* make({ hostname: "127.0.0.1", port: 0 })
      const routes = HttpRouter.add("GET", "/hello/:name", (request) =>
        Effect.succeed(HttpServerResponse.text(`hello ${new URL(request.url, "http://x").pathname.split("/")[2]}`)),
      )
      const app = yield* HttpRouter.toHttpEffect(routes)
      yield* server.serve(app)
      const port = "port" in server.address ? server.address.port : 0
      const client = yield* build()
      expect(yield* Effect.flatMap(client.get(`http://127.0.0.1:${port}/hello/you`).send(), (r) => r.text())).toBe(
        "hello you",
      )
      const missing = yield* client.get(`http://127.0.0.1:${port}/nope`).send()
      expect(missing.status).toBe(404)
    }).pipe(Effect.provide(Layer.empty)),
  )

  it.live(
    "WebSocket upgrades send their own 101 headers and carry messages both ways",
    () =>
      Effect.gen(function* () {
        const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
        const seen: Array<Message> = []
        const ended = yield* Deferred.make<void>()
        yield* listener.serve(
          Effect.gen(function* () {
            const socket = yield* upgrade({ "openai-model": "gpt-test", "x-models-etag": "e1" })
            for (;;) {
              const message = yield* socket.message
              if (message === undefined) break
              seen.push(message)
              if (message._tag === "Text" && message.text === "close me") {
                yield* socket.send(Message.close(1011, "upstream closed"))
              } else if (message._tag === "Text") {
                yield* socket.send(Message.text(`echo:${message.text}`))
              } else if (message._tag === "Binary") {
                yield* socket.send(Message.binary(message.data))
              } else if (message._tag === "Close") {
                yield* socket.send(Message.close(1000, "bye too"))
                break
              }
            }
            yield* Deferred.succeed(ended, undefined)
            return HttpServerResponse.empty()
          }),
        )
        const url = `http://127.0.0.1:${listener.port}/ws`
        const first = yield* openSocket(url)
        expect(first.headers.get("openai-model")).toBe("gpt-test")
        expect(first.headers.get("x-models-etag")).toBe("e1")
        expect(first.headers.get("sec-websocket-extensions")).toBeNull()
        yield* first.writer.send(Message.text("hi"))
        expect(yield* first.reader.message).toEqual(Message.text("echo:hi"))
        // Bun answers pings itself; they never reach the server's reader.
        yield* first.writer.send(Message.ping(Uint8Array.of(7)))
        expect(yield* first.reader.message).toEqual(Message.pong(Uint8Array.of(7)))
        // Past Bun's 16 MB default, within slopmax's 64 MiB.
        const big = new Uint8Array(20 * 1024 * 1024).fill(9)
        yield* first.writer.send(Message.binary(big))
        const back = yield* first.reader.message
        expect(back?._tag === "Binary" && back.data.length === big.length && back.data[123] === 9).toBe(true)
        // Bun answers a close with the same close at once.
        yield* first.writer.send(Message.close(1000, "bye"))
        expect(yield* first.reader.message).toEqual(Message.close(1000, "bye"))
        yield* Deferred.await(ended)
        expect(seen.map((m) => m._tag)).toEqual(["Text", "Binary", "Close"])
        expect(seen.at(-1)).toEqual(Message.close(1000, "bye"))

        const second = yield* openSocket(url)
        yield* second.writer.send(Message.text("close me"))
        expect(yield* second.reader.message).toEqual(Message.close(1011, "upstream closed"))
        yield* second.socket.close
      }),
    20_000,
  )

  it.live("an upgrade on a plain request fails", () =>
    Effect.gen(function* () {
      const listener = yield* bind({ hostname: "127.0.0.1", port: 0 })
      yield* listener.serve(
        upgrade().pipe(
          Effect.as(HttpServerResponse.text("upgraded")),
          Effect.catchTag("UpgradeError", (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 426 })),
          ),
        ),
      )
      const client = yield* build()
      const response = yield* client.get(`http://127.0.0.1:${listener.port}/`).send()
      expect(response.status).toBe(426)
      expect(yield* response.text()).toBe("not a WebSocket upgrade")
    }),
  )
})
