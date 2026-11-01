// The front door on a real socket: what it answers itself, what it hands the
// proxy, its empty slots, and how it stops.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Array, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect"
import { Proxy } from "../../src/proxy/forward.ts"
import { LiveStreams } from "../../src/proxy/live.ts"
import { Relay, Server, WebApp } from "../../src/server.ts"
import { chatgptApi, claudeApi, on, streaming } from "../support/memory-upstream.ts"
import { claudeBody, claudeCode, codexRequest, frontDoorAlone, key, oauth, proxyStack } from "../proxy/stack.ts"

const loopback = { listen: "127.0.0.1:0" }

/** The front door on a free loopback port, until the returned scope closes. */
const listening = <E>(stack: { readonly layer: Layer.Layer<Server, E> }) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(stack.layer, scope)
    const server = Context.get(context, Server)
    return { scope, server, base: `http://${server.address}` }
  })

const get = (url: string, init?: RequestInit) => Effect.promise(() => fetch(url, init))

describe("the front door on a socket", () => {
  it.live("serves until shutdown, then stops listening", () =>
    Effect.gen(function* () {
      const stack = proxyStack({
        routes: claudeApi,
        accounts: [oauth("claude", "a", "tok-ok", 0)],
        settings: loopback,
        listen: true,
      })
      const { scope, server, base } = yield* listening(stack)
      expect(server.address).toMatch(/^127\.0\.0\.1:\d+$/)
      const health = yield* get(`${base}/healthz`)
      expect(health.status).toBe(200)
      expect(health.headers.get("content-type")).toBe("application/json")
      expect(yield* Effect.promise(() => health.json())).toMatchObject({ status: "ok", service: "slopmax" })

      const answer = yield* get(`${base}/claude/v1/messages?beta=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "user-agent": "claude-cli/2.1.287 (external, cli)" },
        body: claudeBody,
      })
      expect(answer.status).toBe(200)
      expect(yield* Effect.promise(() => answer.text())).toContain("message_stop")

      yield* Scope.close(scope, Exit.void)
      const after = yield* Effect.tryPromise(() => fetch(`${base}/healthz`)).pipe(Effect.exit)
      expect(Exit.isFailure(after)).toBe(true)
    }),
  )

  it.live("answers the probes, unknown paths, sockets and web paths itself", () =>
    Effect.gen(function* () {
      const stack = frontDoorAlone({ routes: claudeApi, accounts: [], settings: loopback, listen: true })
      const { base } = yield* listening(stack)
      const hello = yield* get(`${base}/api/hello`)
      expect([hello.status, yield* Effect.promise(() => hello.text())]).toEqual([200, ""])
      const head = yield* get(`${base}/slopmax/api/status`, { method: "HEAD" })
      expect(head.status).toBe(200)
      const unknown = yield* get(`${base}/nowhere`)
      expect(unknown.status).toBe(404)
      expect(yield* Effect.promise(() => unknown.json())).toMatchObject({ error: { type: "not_found_error" } })
      // Until slopmax's own API and the dashboard are plugged in, their paths are not found.
      expect((yield* get(`${base}/slopmax/api/status`)).status).toBe(404)
      expect((yield* get(`${base}/v0/management/auth-files`)).status).toBe(404)
    }),
  )

  it.live("tells Codex to stream over HTTP while no socket relay is plugged in", () =>
    Effect.gen(function* () {
      const stack = frontDoorAlone({ routes: chatgptApi, accounts: [], settings: loopback, listen: true })
      const { server } = yield* listening(stack)
      const answer = yield* Effect.promise(() =>
        Promise.resolve(
          server.fetch(
            new Request(`http://${server.address}/codex/responses`, {
              headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13" },
            }),
          ),
        ),
      )
      expect(answer.status).toBe(426)
      expect(yield* Effect.promise(() => answer.json())).toMatchObject({ error: { type: "invalid_request_error" } })
    }),
  )

  it.live("lets an answer in flight finish when it shuts down", () =>
    Effect.gen(function* () {
      let push: ((text: string) => void) | undefined
      let end: (() => void) | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text))
          end = () => controller.close()
        },
      })
      const stack = proxyStack({
        routes: [on("POST /backend-api/codex/responses", () => streaming(body))],
        accounts: [oauth("codex", "a", "tok-ok", 0)],
        settings: loopback,
        listen: true,
      })
      const { scope, server, base } = yield* listening(stack)
      push?.('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n')
      const response = yield* get(`${base}/codex/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: '{"model":"gpt-6-sol","input":[],"stream":true}',
      })
      expect(response.status).toBe(200)
      const text = Effect.promise(() => response.text())
      const reading = yield* Effect.forkChild(text)
      const draining = yield* Effect.forkChild(server.drain)
      yield* Effect.sleep("50 millis")
      expect(draining.pollUnsafe()).toBeUndefined()
      push?.('data: {"type":"response.completed","response":{"id":"r"}}\n\n')
      end?.()
      expect(yield* Fiber.join(reading)).toContain("response.completed")
      yield* Fiber.join(draining)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.live("refuses a body past 256 MiB itself, in the client's own format", () =>
    Effect.gen(function* () {
      const stack = proxyStack({ routes: claudeApi, accounts: [], settings: loopback, listen: true })
      const { server } = yield* listening(stack)
      const [hostname, port] = server.address.split(":")
      // fetch cannot declare a length its body does not have; a raw request can, and sends none of it.
      const head = [
        "POST /claude/v1/messages HTTP/1.1",
        `host: ${server.address}`,
        `authorization: Bearer ${key}`,
        "content-type: application/json",
        `content-length: ${300 * 1024 * 1024}`,
        "",
        "",
      ].join("\r\n")
      const reply = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            let text = ""
            void Bun.connect({
              hostname: hostname ?? "127.0.0.1",
              port: Number(port),
              socket: {
                open: (socket) => void socket.write(head),
                data: (socket, data) => {
                  text += data.toString()
                  if (text.includes("too large")) {
                    socket.end()
                    resolve(text)
                  }
                },
                close: () => resolve(text),
              },
            })
          }),
      )
      expect(reply.startsWith("HTTP/1.1 413")).toBe(true)
      expect(reply.toLowerCase()).toContain("content-type: application/json")
      expect(reply).toContain('"type":"error"')
      expect(reply).toContain("request body is too large")
    }),
  )

  it.live("says which address it could not listen on", () =>
    Effect.gen(function* () {
      const first = proxyStack({ routes: [], accounts: [], settings: loopback, listen: true })
      const { server } = yield* listening(first)
      const taken = proxyStack({ routes: [], accounts: [], settings: { listen: server.address }, listen: true })
      const failed = yield* Effect.flip(listening(taken))
      expect(failed._tag).toBe("ListenFailed")
      expect(failed.message).toContain(`cannot listen on ${server.address}`)
    }),
  )
})

describe("the front door in process", () => {
  it.effect("a bug answers 500 in the client's format, and its log shows the cause whole", () => {
    const errors: Array<string> = []
    const capture = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Error") errors.push(Array.ensure(message).map(String).join(" "))
      }),
    ])
    const broken = Layer.succeed(Proxy)({
      handle: () => Effect.die(new Error("the planner lost its map")),
      models: () => Effect.die(new Error("unused")),
      noteAgents: () => Effect.void,
    })
    const layer = Server.layerMemory.pipe(
      Layer.provide(Layer.mergeAll(broken, Relay.refuse, WebApp.none, LiveStreams.layer, capture)),
    )
    return Effect.gen(function* () {
      const server = yield* Server
      const response = yield* Effect.promise(() => Promise.resolve(server.fetch(claudeCode())))
      expect(response.status).toBe(500)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        type: "error",
        error: { type: "api_error", message: "slopmax failed to answer: the planner lost its map" },
      })
      while (errors.length === 0) yield* Effect.yieldNow
      expect(errors[0]).toContain("answering POST /claude/v1/messages failed")
      expect(errors[0]).toContain("Error: the planner lost its map")
      expect(errors[0]).toContain("server.test.ts")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a client gone before its answer starts takes the request with it", () => {
    const stack = proxyStack({
      routes: [on("POST /backend-api/codex/responses", () => new Promise<Response>(() => undefined))],
      accounts: [oauth("codex", "a", "tok-ok", 0)],
    })
    return Effect.gen(function* () {
      const server = yield* Server
      const gone = new AbortController()
      const made = codexRequest()
      const answered = yield* Deferred.make<number>()
      const pending = server.fetch(new Request(made, { signal: gone.signal }))
      void Promise.resolve(pending).then((response) => Effect.runSync(Deferred.succeed(answered, response.status)))
      // Hang up once the provider has the request, before it answers.
      while (stack.upstream.at("/backend-api/codex/responses").length === 0) {
        yield* Effect.yieldNow
      }
      gone.abort()
      // The interrupted request still answers (no one hears it), in the client's format.
      expect(yield* Deferred.await(answered)).toBe(500)
      expect(stack.upstream.at("/backend-api/codex/responses")).toHaveLength(1)
    }).pipe(Effect.provide(stack.layer))
  })

  it.effect("answers Claude Code's requests as a socket would", () => {
    const stack = proxyStack({ routes: claudeApi, accounts: [oauth("claude", "a", "tok-ok", 0)] })
    return Effect.gen(function* () {
      const server = yield* Server
      expect(server.address).toBe("memory")
      const response = yield* Effect.promise(() => Promise.resolve(server.fetch(claudeCode())))
      expect(response.status).toBe(200)
    }).pipe(Effect.provide(stack.layer))
  })
})
