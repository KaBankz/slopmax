import { describe, expect } from "bun:test"
import { slopmaxVersion } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Option, Result } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { SettingsService } from "../../src/settings.ts"
import {
  bypassesProxy,
  chooseProxy,
  inferenceRoots,
  isLoopback,
  parseNoProxy,
  parseProxyUrl,
  ProxyUrlInvalid,
  rewriteOrigin,
  showProxy,
  TimedOut,
  TooLarge,
  trustedRoots,
  Unreachable,
  Upstream,
} from "../../src/upstream.ts"
import { httpProxy, provider } from "./servers.ts"

const noEnv = ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))

/** A root as PEM, its body wrapped at `wrap` characters. */
const pem = (body: string, wrap = 64) =>
  `-----BEGIN CERTIFICATE-----\n${body.match(new RegExp(`.{1,${wrap}}`, "g"))?.join("\n")}\n-----END CERTIFICATE-----`

/** Upstream over the network, with these settings and this environment (and nothing from the real one). */
const network = (settings: Parameters<typeof SettingsService.layerValue>[0] = {}, env: Record<string, string> = {}) =>
  Upstream.layer.pipe(
    Layer.provide(SettingsService.layerValue(settings)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  )

const request = (url: string, headers: Record<string, string> = {}, body?: string) => ({
  url,
  method: body === undefined ? "GET" : "POST",
  headers: new Headers(headers),
  body,
})

const env = (pairs: Record<string, string>) =>
  ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].map(
    (name) => [name, Option.fromUndefinedOr(pairs[name])] as const,
  )

describe("Upstream", () => {
  it("reads proxy URLs of every scheme it supports, and refuses the rest in plain words", () => {
    expect(parseProxyUrl("http://proxy.corp:3128")).toEqual(
      Result.succeed({ kind: "http", host: "proxy.corp", port: 3128 }),
    )
    expect(parseProxyUrl("HTTP://proxy.corp")).toEqual(Result.succeed({ kind: "http", host: "proxy.corp", port: 80 }))
    expect(parseProxyUrl("socks5://127.0.0.1")).toEqual(
      Result.succeed({ kind: "socks5", host: "127.0.0.1", port: 1080 }),
    )
    expect(parseProxyUrl(" socks5h://[::1]:9050/ ")).toEqual(
      Result.succeed({ kind: "socks5h", host: "::1", port: 9050 }),
    )
    expect(parseProxyUrl("http://me:p%40ss@proxy:8080")).toEqual(
      Result.succeed({ kind: "http", host: "proxy", port: 8080, user: "me", password: "p@ss" }),
    )
    expect(parseProxyUrl("proxy:8080")).toEqual(
      Result.fail('proxy "proxy:8080" needs a scheme, like http:// or socks5://'),
    )
    expect(parseProxyUrl("ftp://proxy")).toEqual(Result.fail('unsupported proxy scheme "ftp"'))
    expect(Result.isFailure(parseProxyUrl("http://"))).toBe(true)
    expect(Result.isFailure(parseProxyUrl("http://proxy:99999"))).toBe(true)
    // Shown without its credentials.
    const withCredentials = Result.getOrThrow(parseProxyUrl("socks5h://me:secret@[::1]:9050"))
    expect(showProxy(withCredentials)).toBe("socks5h://[::1]:9050")
  })

  it("lets loopback hosts and NO_PROXY's entries skip the proxy", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(isLoopback(host)).toBe(true)
    for (const host of ["example.com", "10.0.0.1", "::2", "localhost.example.com"]) expect(isLoopback(host)).toBe(false)
    const listed = parseNoProxy(" .Corp.example , internal, ,[fd00::1]")
    expect(listed).toEqual(["corp.example", "internal", "fd00::1"])
    expect(bypassesProxy("api.corp.example", listed)).toBe(true)
    expect(bypassesProxy("CORP.example", listed)).toBe(true)
    expect(bypassesProxy("notcorp.example", listed)).toBe(false)
    expect(bypassesProxy("internal", listed)).toBe(true)
    expect(bypassesProxy("[fd00::1]", listed)).toBe(true)
    expect(bypassesProxy("api.anthropic.com", listed)).toBe(false)
    expect(bypassesProxy("api.anthropic.com", parseNoProxy("*"))).toBe(true)
  })

  it("sends a URL whose start matches an origin to that origin's stand-in", () => {
    const origins = { "https://api.anthropic.com": "http://127.0.0.1:9000/" }
    expect(rewriteOrigin("https://api.anthropic.com/v1/messages", origins)).toBe("http://127.0.0.1:9000/v1/messages")
    expect(rewriteOrigin("https://api.anthropic.com?beta=1", origins)).toBe("http://127.0.0.1:9000?beta=1")
    expect(rewriteOrigin("https://api.anthropic.com", origins)).toBe("http://127.0.0.1:9000")
    expect(rewriteOrigin("https://api.anthropic.com.evil/v1", origins)).toBe("https://api.anthropic.com.evil/v1")
    expect(rewriteOrigin("https://chatgpt.com/backend-api", origins)).toBe("https://chatgpt.com/backend-api")
  })

  it("takes the proxy from the settings, else from HTTPS_PROXY or ALL_PROXY, and never from HTTP_PROXY", () => {
    const chosen = (setting: string | undefined, pairs: Record<string, string>) =>
      Result.map(chooseProxy(Option.fromUndefinedOr(setting), env(pairs)), Option.map(showProxy))
    expect(chosen("socks5h://127.0.0.1:1080", { HTTPS_PROXY: "http://env:1" })).toEqual(
      Result.succeed(Option.some("socks5h://127.0.0.1:1080")),
    )
    expect(chosen(undefined, { HTTPS_PROXY: "", https_proxy: "http://lower:2", ALL_PROXY: "http://all:3" })).toEqual(
      Result.succeed(Option.some("http://lower:2")),
    )
    expect(chosen(undefined, { all_proxy: "socks5://all:4" })).toEqual(Result.succeed(Option.some("socks5://all:4")))
    expect(chosen(undefined, { HTTP_PROXY: "http://plain:5" })).toEqual(Result.succeed(Option.none()))
    // A value in the environment that is not a proxy means none, as other tools read it.
    expect(chosen(undefined, { HTTPS_PROXY: "nonsense" })).toEqual(Result.succeed(Option.none()))
    const refused = chooseProxy(Option.some("http://"), env({}))
    expect(Result.isFailure(refused) && refused.failure.message).toBe(
      'upstreamProxy in config.json: proxy "http://" names no host',
    )
  })

  it.effect("fails to start with a proxy setting it cannot use", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.provide(Upstream, network({ upstreamProxy: "http://:80" })))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        expect(reason?._tag === "Fail" ? reason.error : undefined).toBeInstanceOf(ProxyUrlInvalid)
      }
    }),
  )

  it.live("passes compressed bodies and their encoding through untouched", () =>
    Effect.gen(function* () {
      const packed = Bun.gzipSync(new TextEncoder().encode("data: hello\n\n".repeat(50)))
      const mock = yield* provider(
        () => new Response(packed, { headers: { "content-encoding": "gzip", "content-type": "text/event-stream" } }),
      )
      const upstream = yield* Upstream
      const response = yield* upstream.send(request(`${mock.url}/v1/messages`, {}, "{}"))
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const bytes = yield* upstream.readAll(response, 1 << 20)
      expect([...bytes]).toEqual([...packed])
    }).pipe(Effect.provide(network())),
  )

  it.live("sends the headers it is given and no trace headers, and hands redirects back as they are", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<Headers>()
      const mock = yield* provider((req) => {
        Effect.runSync(Deferred.succeed(seen, req.headers))
        return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } })
      })
      const upstream = yield* Upstream
      const response = yield* upstream.send(
        request(
          `${mock.url}/v1/messages`,
          { authorization: "Bearer tok", "anthropic-beta": "x,y", "user-agent": "claude-cli/2" },
          "{}",
        ),
      )
      expect(response.status).toBe(307)
      const headers = yield* Deferred.await(seen)
      expect([headers.get("authorization"), headers.get("anthropic-beta"), headers.get("user-agent")]).toEqual([
        "Bearer tok",
        "x,y",
        "claude-cli/2",
      ])
      for (const name of ["traceparent", "tracestate", "b3", "x-b3-traceid"]) expect(headers.has(name)).toBe(false)
    }).pipe(Effect.provide(network())),
  )

  it.live("reports a provider it cannot reach as unreachable", () =>
    Effect.gen(function* () {
      const port = yield* provider(() => new Response()).pipe(
        Effect.map((mock) => mock.port),
        Effect.scoped,
      )
      const upstream = yield* Upstream
      const error = yield* Effect.flip(upstream.send(request(`http://127.0.0.1:${port}/`)))
      expect(error).toBeInstanceOf(Unreachable)
      expect(error.message).toStartWith("request failed: ")
    }).pipe(Effect.provide(network())),
  )

  it.effect("gives up waiting for a provider's headers after 600 seconds", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const waiting = yield* Effect.forkScoped(
        Effect.flip(upstream.send(request("https://api.anthropic.com/v1/messages"))),
      )
      yield* TestClock.adjust("599 seconds")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(waiting)
      expect(error).toBeInstanceOf(TimedOut)
      expect(error.message).toBe("timed out after 10m")
    }).pipe(Effect.provide(Upstream.layerHandler(() => new Promise<Response>(() => undefined)))),
  )

  it.effect("cancels the request when the caller hangs up before the headers come", () =>
    Effect.gen(function* () {
      const aborted = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const layer = Upstream.layerHandler(
        (req) =>
          new Promise<Response>((_, reject) => {
            Effect.runSync(Deferred.succeed(started, undefined))
            req.signal.addEventListener("abort", () => {
              Effect.runSync(Deferred.succeed(aborted, undefined))
              reject(new Error("aborted"))
            })
          }),
      )
      const upstream = yield* Effect.provide(Upstream, layer)
      const sending = yield* Effect.forkScoped(
        upstream.send(request("https://chatgpt.com/backend-api/codex/responses")),
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(sending)
      yield* Deferred.await(aborted)
    }),
  )

  it.effect("reads a body whole within its limit and refuses one past it", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const small = yield* upstream.readAll(new Response("x".repeat(100)), 100)
      expect(small.length).toBe(100)
      const error = yield* Effect.flip(upstream.readAll(new Response("x".repeat(101)), 100))
      expect(error).toBeInstanceOf(TooLarge)
      expect(error.message).toBe("body exceeds 100 bytes")
      expect((yield* upstream.readAll(new Response(null, { status: 204 }), 10)).length).toBe(0)
    }).pipe(Effect.provide(Upstream.layerHandler(() => new Response()))),
  )

  it.effect("gives cold calls slopmax's user agent unless they set one, and never trace headers", () =>
    Effect.gen(function* () {
      const seen: Array<Headers> = []
      const upstream = yield* Effect.provide(
        Upstream,
        Upstream.layerHandler((req) => {
          seen.push(req.headers)
          return Response.json({ ok: true })
        }),
      )
      const answer = yield* upstream.http.execute(HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage"))
      expect(yield* answer.json).toEqual({ ok: true })
      yield* upstream.http.execute(
        HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
          HttpClientRequest.setHeader("user-agent", "codex_cli_rs/0.50"),
        ),
      )
      expect(seen.map((headers) => headers.get("user-agent"))).toEqual([
        `slopmax/${slopmaxVersion}`,
        "codex_cli_rs/0.50",
      ])
      for (const headers of seen) for (const name of ["traceparent", "b3"]) expect(headers.has(name)).toBe(false)
    }).pipe(Effect.withSpan("a traced caller")),
  )

  it.effect("gives up on a cold call after 30 seconds", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const calling = yield* Effect.forkScoped(
        Effect.flip(upstream.http.get("https://platform.claude.com/v1/oauth/token")),
      )
      yield* TestClock.adjust("30 seconds")
      const error = yield* Fiber.join(calling)
      expect(error._tag).toBe("HttpClientError")
    }).pipe(Effect.provide(Upstream.layerHandler(() => new Promise<Response>(() => undefined)))),
  )

  it.effect("gives up on a cold call whose body stalls after its headers, within the same 30 seconds", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const calling = yield* Effect.forkScoped(
        Effect.flip(Effect.flatMap(upstream.http.get("https://api.anthropic.com/api/oauth/usage"), (r) => r.json)),
      )
      for (let turn = 0; turn < 5; turn++) yield* TestClock.adjust("6 seconds")
      const error = yield* Fiber.join(calling)
      expect(error._tag).toBe("HttpClientError")
      expect(error.message).toContain("timed out")
    }).pipe(
      Effect.provide(
        Upstream.layerHandler(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      ),
    ),
  )

  it.effect("reads a cold call's answer whole, so callers can read it after the call", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const answer = yield* upstream.http.get("https://api.anthropic.com/api/oauth/usage")
      expect(answer.status).toBe(201)
      expect(answer.headers["x-plan"]).toBe("max")
      expect(yield* answer.json).toEqual({ plan: "max" })
      const empty = yield* upstream.http.get("https://api.anthropic.com/empty")
      expect(empty.status).toBe(204)
      expect(yield* empty.text).toBe("")
    }).pipe(
      Effect.provide(
        Upstream.layerHandler((req) =>
          req.url.endsWith("/empty")
            ? new Response(null, { status: 204 })
            : Response.json({ plan: "max" }, { status: 201, headers: { "x-plan": "max" } }),
        ),
      ),
    ),
  )

  it.live("decompresses cold calls as usual", () =>
    Effect.gen(function* () {
      const packed = Bun.gzipSync(new TextEncoder().encode('{"plan":"max"}'))
      const mock = yield* provider(
        () => new Response(packed, { headers: { "content-encoding": "gzip", "content-type": "application/json" } }),
      )
      const upstream = yield* Upstream
      const answer = yield* upstream.http.get(`${mock.url}/usage`)
      expect(yield* answer.json).toEqual({ plan: "max" })
    }).pipe(Effect.provide(network())),
  )

  it.live("goes through an HTTP proxy with its credentials, except for loopback and NO_PROXY hosts", () =>
    Effect.gen(function* () {
      const mock = yield* provider((req) => new Response(`served ${new URL(req.url).pathname}`))
      const proxy = yield* httpProxy(mock.port)
      const settings = { upstreamProxy: `http://me:p%40ss@127.0.0.1:${proxy.port}` }
      const upstream = yield* Effect.provide(Upstream, network(settings, { NO_PROXY: "direct.test" }))
      const response = yield* upstream.send(request(`http://provider.test:${mock.port}/v1/messages`, {}, "{}"))
      expect(yield* Effect.promise(() => response.text())).toBe("served /v1/messages")
      expect(proxy.seen).toEqual([
        {
          line: `POST http://provider.test:${mock.port}/v1/messages HTTP/1.1`,
          authorization: `Basic ${btoa("me:p@ss")}`,
        },
      ])
      expect(upstream.proxy).toEqual(Option.some(`http://127.0.0.1:${proxy.port}`))
      // Loopback goes direct.
      const local = yield* upstream.send(request(`${mock.url}/local`))
      expect(yield* Effect.promise(() => local.text())).toBe("served /local")
      // NO_PROXY hosts go direct, so a name only the proxy knows is not found.
      const direct = yield* Effect.flip(upstream.send(request(`http://direct.test:${mock.port}/`)))
      expect(direct).toBeInstanceOf(Unreachable)
      expect(proxy.seen.length).toBe(1)
      // Cold calls take the same route.
      const cold = yield* upstream.http.get(`http://provider.test:${mock.port}/usage`)
      expect(yield* cold.text).toBe("served /usage")
      expect(proxy.seen.length).toBe(2)
    }),
  )

  it.live("takes the proxy from HTTPS_PROXY when the settings name none", () =>
    Effect.gen(function* () {
      const mock = yield* provider(() => new Response("via env"))
      const proxy = yield* httpProxy(mock.port)
      const upstream = yield* Effect.provide(
        Upstream,
        network({}, { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: "http://127.0.0.1:1" }),
      )
      const response = yield* upstream.send(request(`http://provider.test:${mock.port}/`))
      expect(yield* Effect.promise(() => response.text())).toBe("via env")
      expect(proxy.seen.map((seen) => seen.authorization)).toEqual([undefined])
    }),
  )

  it.live("points providers at stand-ins for tests", () =>
    Effect.gen(function* () {
      const mock = yield* provider((req) => new Response(new URL(req.url).pathname))
      const upstream = yield* Effect.provide(
        Upstream,
        Upstream.layerOrigins({ "https://api.anthropic.com": mock.url }).pipe(
          Layer.provide(SettingsService.layerValue()),
          Layer.provide(noEnv),
        ),
      )
      const response = yield* upstream.send(request("https://api.anthropic.com/v1/messages", {}, "{}"))
      expect(yield* Effect.promise(() => response.text())).toBe("/v1/messages")
      const cold = yield* upstream.http.get("https://api.anthropic.com/api/oauth/profile")
      expect(yield* cold.text).toBe("/api/oauth/profile")
    }),
  )

  it.effect("refuses WebSocket dials until the relay arrives", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const error = yield* Effect.flip(
        Effect.scoped(upstream.dial("wss://chatgpt.com/backend-api/codex/responses", new Headers())),
      )
      expect(error).toBeInstanceOf(Unreachable)
    }).pipe(Effect.provide(Upstream.layerHandler(() => new Response()))),
  )

  it("hands inference fetches no list of roots unless Bun's own trust would miss one the system has", () => {
    const bundled = [pem("A".repeat(100)), pem("B".repeat(100))]
    // Bun on Linux verifies against the system's store itself.
    expect(inferenceRoots("linux", [pem("C".repeat(100))], bundled)).toBeUndefined()
    // The same root wrapped differently is the same root.
    expect(inferenceRoots("darwin", [pem("A".repeat(100), 76)], bundled)).toBeUndefined()
    expect(inferenceRoots("darwin", [pem("C".repeat(100))], bundled)).toEqual([...bundled, pem("C".repeat(100))])
  })

  it.effect("keeps no timer running while nothing is being sent", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      // Days pass in an instant: a watcher ticking every second would take ages to catch up.
      yield* TestClock.adjust("1000 days")
      const answer = yield* upstream.send(request("https://api.anthropic.com/v1/messages"))
      expect(answer.status).toBe(200)
    }).pipe(Effect.provide(Upstream.layerHandler(() => new Response("ok")))),
  )

  it("trusts the system's roots and Bun's bundled ones", () => {
    const roots = trustedRoots()
    expect(roots.length).toBeGreaterThan(100)
    expect(new Set(roots).size).toBe(roots.length)
  })

  it.effect("sends cold calls through HttpClient's own API as any Effect code would", () =>
    Effect.gen(function* () {
      const upstream = yield* Upstream
      const answer = yield* HttpClient.get("https://api.x.ai/v1/models").pipe(
        Effect.provideService(HttpClient.HttpClient, upstream.http),
      )
      expect(answer.status).toBe(200)
    }).pipe(Effect.provide(Upstream.layerHandler(() => Response.json({ data: [] })))),
  )
})
