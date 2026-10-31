import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { ConfigProvider, Context, Effect, Exit, Layer, Result, Scope } from "effect"
import { Dns, NetAddress } from "effect/net"
import { SettingsService } from "../../src/settings.ts"
import { addressBytes, bridge, dialThrough, replyText, SocksFailed, type SocksTarget } from "../../src/socks.ts"
import { Upstream } from "../../src/upstream.ts"
import { exchange, provider, socksProxy } from "../upstream/servers.ts"

const withSocks = (upstreamProxy: string) =>
  Upstream.layer.pipe(
    Layer.provide(SettingsService.layerValue({ upstreamProxy })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
  )

/** Upstream built in the test's scope, so its bridge lives as long as the test. */
const upstreamWith = (upstreamProxy: string) =>
  Effect.map(Layer.build(withSocks(upstreamProxy)), (context) => Context.get(context, Upstream))

const get = (url: string) => ({ url, method: "GET", headers: new Headers(), body: undefined })

/** Names resolved here, without a real DNS lookup. */
const names = Dns.layerStatic({ hosts: { "provider.test": ["127.0.0.1"] } })

const target = (port: number, more: Partial<SocksTarget> = {}): SocksTarget => ({
  host: "127.0.0.1",
  port,
  remoteDns: true,
  ...more,
})

const ip = (text: string) => Result.getOrThrow(NetAddress.ipFromString(text))

describe("SOCKS5 bridge", () => {
  it("writes the address part of a request for IPv4, IPv6 and names", () => {
    expect([...addressBytes(ip("10.1.2.3"))]).toEqual([1, 10, 1, 2, 3])
    expect([...addressBytes(ip("::1"))]).toEqual([4, ...Array.from({ length: 15 }, () => 0), 1])
    expect([...addressBytes("ab.test")]).toEqual([3, 7, ...new TextEncoder().encode("ab.test")])
    expect(replyText(5)).toBe("connection refused")
    expect(replyText(42)).toBe("unknown reply 42")
  })

  it.live("lets the proxy resolve names with socks5h://", () =>
    Effect.gen(function* () {
      const mock = yield* provider((req) => new Response(`hello from ${new URL(req.url).pathname}`))
      const socks = yield* socksProxy(mock.port)
      const upstream = yield* upstreamWith(`socks5h://127.0.0.1:${socks.port}`)
      const response = yield* upstream.send(get(`http://provider.test:${mock.port}/v1/models`))
      expect(yield* Effect.promise(() => response.text())).toBe("hello from /v1/models")
      expect(socks.seen).toEqual([{ type: "name", host: "provider.test", port: mock.port }])
      expect(upstream.proxy._tag).toBe("Some")
    }),
  )

  it.live("resolves names here with socks5://, sending the proxy an address", () =>
    Effect.gen(function* () {
      const mock = yield* provider(() => new Response("ok"))
      const socks = yield* socksProxy(mock.port)
      const { socket } = yield* dialThrough(target(socks.port, { remoteDns: false }), "provider.test", mock.port).pipe(
        Effect.provide(names),
      )
      socket.destroy()
      expect(socks.seen).toEqual([{ type: "ipv4", host: "127.0.0.1", port: mock.port }])
    }),
  )

  it.live("signs in to the proxy with a user name and password", () =>
    Effect.gen(function* () {
      const mock = yield* provider(() => new Response("signed in"))
      const socks = yield* socksProxy(mock.port, { credentials: ["me", "s3cret"] })
      const upstream = yield* upstreamWith(`socks5h://me:s3cret@127.0.0.1:${socks.port}`)
      const response = yield* upstream.send(get(`http://provider.test:${mock.port}/`))
      expect(yield* Effect.promise(() => response.text())).toBe("signed in")
      const refused = yield* Effect.flip(
        dialThrough(target(socks.port, { user: "me", password: "wrong" }), "provider.test", mock.port),
      ).pipe(Effect.provide(names))
      expect(refused).toBeInstanceOf(SocksFailed)
      expect(refused.message).toBe("SOCKS proxy: the proxy refused the user name and password")
      const unasked = yield* Effect.flip(dialThrough(target(socks.port), "provider.test", mock.port)).pipe(
        Effect.provide(names),
      )
      expect(unasked.reason).toBe("the proxy accepts none of our ways to sign in")
    }),
  )

  it.live("tunnels CONNECT requests through the proxy, with bytes sent early", () =>
    Effect.gen(function* () {
      const mock = yield* provider(() => new Response("tunneled"))
      const socks = yield* socksProxy(mock.port)
      const started = yield* bridge(target(socks.port)).pipe(Effect.provide(names))
      const port = Number(new URL(started.url).port)
      const answer = yield* Effect.promise(() =>
        exchange(port, [
          `CONNECT provider.test:${mock.port} HTTP/1.1\r\nhost: provider.test\r\nproxy-authorization: ${started.authorization}\r\n\r\n` +
            `GET / HTTP/1.1\r\nhost: provider.test\r\nconnection: close\r\n\r\n`,
        ]),
      )
      expect(answer).toStartWith("HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 200 OK")
      expect(answer).toEndWith("tunneled")
      expect(socks.seen).toEqual([{ type: "name", host: "provider.test", port: mock.port }])
    }),
  )

  it.live("serves only requests that carry its own credentials", () =>
    Effect.gen(function* () {
      const socks = yield* socksProxy(1)
      const started = yield* bridge(target(socks.port)).pipe(Effect.provide(names))
      const port = Number(new URL(started.url).port)
      const answer = yield* Effect.promise(() => exchange(port, ["CONNECT provider.test:443 HTTP/1.1\r\n\r\n"]))
      expect(answer).toStartWith("HTTP/1.1 407 Proxy Authentication Required")
      expect(socks.seen).toEqual([])
    }),
  )

  it.live("answers 502 when the proxy cannot reach the provider", () =>
    Effect.gen(function* () {
      const socks = yield* socksProxy(1, { reply: 5 })
      const started = yield* bridge(target(socks.port)).pipe(Effect.provide(names))
      const port = Number(new URL(started.url).port)
      const answer = yield* Effect.promise(() =>
        exchange(port, [`CONNECT provider.test:443 HTTP/1.1\r\nproxy-authorization: ${started.authorization}\r\n\r\n`]),
      )
      expect(answer).toStartWith("HTTP/1.1 502 Bad Gateway")
      const failed = yield* Effect.flip(dialThrough(target(socks.port), "provider.test", 443)).pipe(
        Effect.provide(names),
      )
      expect(failed.reason).toBe("connection refused")
    }),
  )

  it.live("fails plainly when there is no proxy to reach", () =>
    Effect.gen(function* () {
      const closed = yield* socksProxy(1).pipe(
        Effect.map((socks) => socks.port),
        Effect.scoped,
      )
      const failed = yield* Effect.flip(dialThrough(target(closed), "provider.test", 443)).pipe(Effect.provide(names))
      expect(failed).toBeInstanceOf(SocksFailed)
    }),
  )

  it.live("stops with the scope that started it", () =>
    Effect.gen(function* () {
      const socks = yield* socksProxy(1)
      const scope = yield* Scope.make()
      const started = yield* bridge(target(socks.port)).pipe(Effect.provide(names), Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      const port = Number(new URL(started.url).port)
      const refused = yield* Effect.exit(Effect.tryPromise(() => exchange(port, ["x"])))
      expect(Exit.isFailure(refused)).toBe(true)
    }),
  )
})
