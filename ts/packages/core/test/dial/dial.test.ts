// Dialing Codex's upstream socket: what the handshake sends and keeps, how it
// fails, that it goes through a CONNECT proxy (to `wss` too, trusting the
// roots it is given), and that messages of every frame length cross intact.
import { describe, expect } from "bun:test"
import * as BunDns from "@effect/platform-bun/BunDns"
import { it } from "@slopmax/test"
import { Effect, Exit, Fiber, type Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"
import { dial, type DialRoute, maxMessage, ReadyState, type UpstreamSocket } from "../../src/dial.ts"
import { networkRoute, Upstream } from "../../src/upstream.ts"
import {
  connectProxy,
  echoServer,
  inbox,
  openClient,
  patterned,
  patternedText,
  Received,
  silentServer,
  testTls,
} from "./support.ts"

const direct = (url: string): DialRoute => ({ url, proxy: undefined, ca: [] })

/** The upstream a layer builds. */
const upstreamOf = (layer: Layer.Layer<Upstream>) =>
  Effect.provide(
    Effect.gen(function* () {
      return yield* Upstream
    }),
    layer,
  )

/** Frame lengths at every boundary of the length field: 7 bits, 16 bits, 64 bits. */
const sizes = [0, 125, 126, 65_535, 65_536]

/** Sends a text and a binary message of each size on `raw`, and checks each comes back whole and as the same kind. */
const roundTrips = (socket: UpstreamSocket) =>
  Effect.gen(function* () {
    const next = yield* inbox(socket)
    const raw = socket.raw
    for (const size of sizes) {
      raw.send(patternedText(size))
      raw.send(patterned(size))
      const text = yield* next
      expect(text._tag).toBe("Text")
      if (text._tag === "Text") expect(text.text).toBe(patternedText(size))
      const binary = yield* next
      expect(binary._tag).toBe("Binary")
      if (binary._tag === "Binary") expect(binary.bytes).toEqual(patterned(size))
    }
  })

describe("dialing Codex's upstream socket", () => {
  it.live("opens the socket with the given headers and keeps those of the 101", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer()
      const socket = yield* dial(
        new Headers({ authorization: "Bearer tok-ok", "openai-beta": "responses_websockets=2026-02-06" }),
        direct(`${echo.url}/backend-api/codex/responses`),
      )
      expect(socket.headers.get("x-models-etag")).toBe("echo")
      expect(socket.headers.get("sec-websocket-accept")).not.toBeNull()
      const [handshake] = echo.handshakes
      expect(handshake?.get("authorization")).toBe("Bearer tok-ok")
      expect(handshake?.get("openai-beta")).toBe("responses_websockets=2026-02-06")
      expect(handshake?.get("sec-websocket-version")).toBe("13")
      // Frames go uncompressed, so the relay can read them.
      expect(handshake?.get("sec-websocket-extensions")).toBeNull()
      expect(socket.raw.readyState).toBe(ReadyState.open)
    }),
  )

  it.live("fails when the provider answers anything other than a 101", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 401 }) }),
        ),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const failed = yield* Effect.flip(dial(new Headers(), direct(`ws://127.0.0.1:${server.port}/responses`)))
      expect(failed._tag).toBe("DialRefused")
      expect(failed.message).toBe("answered 401")
    }),
  )

  it.live("fails when nothing listens", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(dial(new Headers(), direct("ws://127.0.0.1:1/responses")))
      expect(failed._tag).toBe("DialRefused")
    }),
  )

  it.live("cuts the socket when the scope it was dialed in closes", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer()
      const scope = yield* Scope.make()
      const socket = yield* dial(new Headers(), direct(echo.url)).pipe(Scope.provide(scope))
      const next = yield* inbox(socket)
      yield* Scope.close(scope, Exit.void)
      expect(yield* next).toEqual(Received.Closed({ code: 1006, reason: "" }))
    }),
  )

  it.live("refuses a message from the provider larger than slopmax takes", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
            websocket: { message: () => undefined, open: (ws) => void ws.send(new Uint8Array(maxMessage + 1)) },
          }),
        ),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const socket = yield* dial(new Headers(), direct(`ws://127.0.0.1:${server.port}/`))
      const next = yield* inbox(socket)
      expect((yield* next)._tag).toBe("Closed")
    }),
  )

  it.live("carries text and binary messages of every frame length intact", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer()
      const socket = yield* dial(new Headers(), direct(echo.url))
      yield* roundTrips(socket)
    }),
  )

  it.live("goes through a CONNECT proxy, with the proxy's credentials", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer()
      const proxy = yield* connectProxy("Basic dXNlcjpwYXNz")
      const socket = yield* dial(new Headers(), {
        url: echo.url,
        proxy: { url: proxy.url, headers: { "proxy-authorization": "Basic dXNlcjpwYXNz" } },
        ca: [],
      })
      expect(proxy.tunnels).toEqual([{ target: `127.0.0.1:${echo.port}`, authorization: "Basic dXNlcjpwYXNz" }])
      yield* roundTrips(socket)
    }),
  )

  it.live("reaches a wss server through the proxy, trusting the roots it is given", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer(testTls)
      const proxy = yield* connectProxy()
      const socket = yield* dial(new Headers(), {
        url: `${echo.url}/backend-api/codex/responses`,
        proxy: { url: proxy.url, headers: {} },
        ca: [testTls.cert],
      })
      expect(proxy.tunnels.map((tunnel) => tunnel.target)).toEqual([`localhost:${echo.port}`])
      yield* roundTrips(socket)
    }),
  )

  it.live("refuses a wss server the roots do not vouch for", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer(testTls)
      const failed = yield* Effect.flip(dial(new Headers(), direct(echo.url)))
      expect(failed._tag).toBe("DialRefused")
    }),
  )
})

describe("Upstream's socket dial", () => {
  it.live("dials a URL tests sent elsewhere at its new origin, and names a refusal", () =>
    Effect.gen(function* () {
      const echo = yield* echoServer()
      const refusing = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 403 }) }),
        ),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const upstream = yield* upstreamOf(
        Upstream.layerHandler(() => new Response(null, { status: 404 }), {
          "https://chatgpt.com": `http://127.0.0.1:${echo.port}`,
          "https://refusing.test": `http://127.0.0.1:${refusing.port}`,
        }),
      )
      const socket = yield* upstream.dial("https://chatgpt.com/backend-api/codex/responses", new Headers())
      expect(socket.headers.get("x-models-etag")).toBe("echo")
      expect(echo.handshakes).toHaveLength(1)
      const failed = yield* Effect.flip(upstream.dial("https://refusing.test/responses", new Headers()))
      expect(failed._tag).toBe("Unreachable")
      expect(failed.message).toBe("request failed: answered 403")
    }),
  )

  it.effect("gives up after 15 seconds without a 101", () =>
    Effect.gen(function* () {
      const silent = yield* silentServer
      const upstream = yield* upstreamOf(
        Upstream.layerHandler(() => new Response(null, { status: 404 }), {
          "https://chatgpt.com": `http://127.0.0.1:${silent.port}`,
        }),
      )
      const dialing = yield* Effect.forkChild(
        Effect.scoped(upstream.dial("https://chatgpt.com/backend-api/codex/responses", new Headers())),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("14 seconds")
      expect(dialing.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const failed = yield* Effect.flip(Fiber.join(dialing))
      expect(failed._tag).toBe("TimedOut")
    }),
  )

  it.effect("goes through the upstream proxy, except to loopback and NO_PROXY hosts", () =>
    Effect.gen(function* () {
      const route = yield* networkRoute({
        proxy: Option.some({ kind: "http", host: "proxy.test", port: 3128, user: "user", password: "pass" }),
        noProxy: ["internal.test"],
        origins: {},
      })
      const proxied = route.dialRoute("https://chatgpt.com/backend-api/codex/responses")
      expect(proxied.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(proxied.proxy).toEqual({
        url: "http://proxy.test:3128",
        headers: { "proxy-authorization": "Basic dXNlcjpwYXNz" },
      })
      expect(proxied.ca.length).toBeGreaterThan(0)
      expect(route.dialRoute("ws://127.0.0.1:9/responses").proxy).toBeUndefined()
      expect(route.dialRoute("wss://api.internal.test/responses").proxy).toBeUndefined()
    }).pipe(Effect.provide(BunDns.layer)),
  )

  it.effect("rewrites a dial's origin before deciding whether it goes through the proxy", () =>
    Effect.gen(function* () {
      const route = yield* networkRoute({
        proxy: Option.some({ kind: "http", host: "proxy.test", port: 3128 }),
        noProxy: [],
        origins: { "https://chatgpt.com": "http://127.0.0.1:5" },
      })
      const rewritten = route.dialRoute("https://chatgpt.com/backend-api/codex/responses")
      expect(rewritten.url).toBe("http://127.0.0.1:5/backend-api/codex/responses")
      expect(rewritten.proxy).toBeUndefined()
    }).pipe(Effect.provide(BunDns.layer)),
  )
})

// The client helper is shared with the relay's tests; make sure it reports a refused handshake by its status.
describe("the test client", () => {
  it.live("reports a handshake that was not upgraded by its status", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 426 }) }),
        ),
        (listener) => Effect.promise(() => listener.stop(true)),
      )
      const refused = yield* Effect.flip(openClient(`ws://127.0.0.1:${server.port}/`))
      expect(refused.status).toBe(426)
    }),
  )
})
