import { describe, expect } from "bun:test"
import { createServer } from "node:net"
import { it } from "@slopmax/test"
import { Duration, Effect } from "effect"

import { Conn, openTcp, tunnel } from "../src/conn.ts"
import { bridge, dial as socksDial, ipv6Bytes, type SocksProxy } from "../src/socks.ts"
import { socksProxy, upstream } from "./support.ts"

const dial = (proxy: SocksProxy, host: string, port: number) => socksDial(proxy, host, port, Duration.seconds(5))

// The error's text, or "" when it worked.
const why = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, { onFailure: (error) => error.message, onSuccess: () => "" })

describe("socks", () => {
  it.live("socks5 resolves names here, socks5h at the proxy", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response("hi"))
      const socks = yield* socksProxy(() => up.port)
      const local = yield* dial(
        { host: "127.0.0.1", port: socks.port, auth: undefined, localDns: true },
        "localhost",
        81,
      )
      local.destroy()
      const remote = yield* dial(
        { host: "127.0.0.1", port: socks.port, auth: undefined, localDns: false },
        "localhost",
        82,
      )
      remote.destroy()
      const literal = yield* dial(
        { host: "127.0.0.1", port: socks.port, auth: undefined, localDns: false },
        "[::1]",
        83,
      )
      literal.destroy()
      expect(socks.requests[0]?.kind === 1 || socks.requests[0]?.kind === 4).toBe(true)
      expect(socks.requests[0]?.port).toBe(81)
      expect(socks.requests[1]).toMatchObject({ kind: 3, host: "localhost", port: 82 })
      expect(socks.requests[2]).toMatchObject({ kind: 4, host: "00000000000000000000000000000001", port: 83 })
    }),
  )

  it.live("SOCKS failures say what went wrong", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response("hi"))
      const socks = yield* socksProxy(() => up.port, ["user", "right"])
      const wrong = yield* why(
        dial({ host: "127.0.0.1", port: socks.port, auth: ["user", "wrong"], localDns: false }, "a.test", 80),
      )
      expect(wrong).toBe("SOCKS error: credentials not accepted")
      const none = yield* why(
        dial({ host: "127.0.0.1", port: socks.port, auth: undefined, localDns: false }, "a.test", 80),
      )
      expect(none).toBe("SOCKS error: server does not support user/pass authentication")
      const closed = yield* why(dial({ host: "127.0.0.1", port: 1, auth: undefined, localDns: false }, "a.test", 80))
      expect(closed).toBe("SOCKS error: failed to create underlying connection")
      const refused = yield* socksProxy(() => 1)
      const target = yield* why(
        dial({ host: "127.0.0.1", port: refused.port, auth: undefined, localDns: false }, "a.test", 80),
      )
      expect(target).toBe("SOCKS error: connection refused")
      const long = yield* why(
        dial({ host: "127.0.0.1", port: socks.port, auth: undefined, localDns: false }, "a".repeat(256), 80),
      )
      expect(long).toBe("SOCKS error: host address is more than 255 characters")
    }),
  )

  it.live("the bridge serves only requests carrying its credentials", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response("hi"))
      const socks = yield* socksProxy(() => up.port)
      const via = yield* Effect.promise(() =>
        bridge({ host: "127.0.0.1", port: socks.port, auth: undefined, localDns: false }, Duration.seconds(5)),
      )
      const anyone = via.url.replace(/\/\/[^@]*@/, "//")
      const denied = yield* Effect.promise(() => fetch("http://upstream.test/", { proxy: anyone }))
      expect(denied.status).toBe(407)
      expect(socks.requests.length).toBe(0)
      const allowed = yield* Effect.promise(() =>
        fetch("http://upstream.test/", { proxy: via.url }).then((response) => response.text()),
      )
      expect(allowed).toBe("hi")
      expect(socks.requests.length).toBe(1)
    }),
  )

  it("IPv6 addresses become their 16 bytes", () => {
    expect([...ipv6Bytes("::1")]).toEqual([...Array.from({ length: 15 }, () => 0), 1])
    expect([...ipv6Bytes("2001:db8::ff00:42:8329")]).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0xff, 0x00, 0x00, 0x42, 0x83, 0x29,
    ])
    expect([...ipv6Bytes("::ffff:127.0.0.1")]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])
  })

  it.live("a CONNECT tunnel that is refused says why", () =>
    Effect.gen(function* () {
      const answers = [
        "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
        "HTTP/1.1 500 Internal Server Error\r\n\r\n",
        "",
      ]
      let next = 0
      const server = createServer((socket) => {
        socket.once("data", () => {
          const answer = answers[next++] ?? ""
          if (answer === "") socket.end()
          else socket.write(answer)
        })
      })
      const port = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve) =>
              server.listen(0, "127.0.0.1", () => {
                const address = server.address()
                resolve(typeof address === "object" && address !== null ? address.port : 0)
              }),
            ),
        ),
        () => Effect.sync(() => server.close()),
      )
      for (const expected of [
        "tunnel error: proxy authorization required",
        "tunnel error: unsuccessful",
        "tunnel error: unexpected end of file",
      ]) {
        const conn = new Conn(yield* openTcp("127.0.0.1", port))
        const result = yield* why(tunnel(conn, "a.test", 443, undefined))
        conn.destroy()
        expect(result).toBe(expected)
      }
    }),
  )
})
