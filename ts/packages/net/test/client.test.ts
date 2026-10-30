import { describe, expect } from "bun:test"
import { constants } from "node:os"
import { gzipSync } from "node:zlib"
import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Result, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"

import { read } from "../src/body.ts"
import { Bypass, Client, layerHttpClient, MAX_BODY, Origins, Proxy, statusText } from "../src/client.ts"
import { acceptKey, Message, newKey, Reader, Writer } from "../src/ws.ts"
import { httpProxy, socksProxy, upstream } from "./support.ts"

const ok = (text: string): Proxy => Result.getOrThrow(Proxy.parse(text))
const err = (text: string): string => {
  const parsed = Proxy.parse(text)
  return Result.isFailure(parsed) ? parsed.failure : "parsed"
}

const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromUnknown(vars))
const noEnv = env({})

// Every header the upstream saw, as JSON.
const echo = (request: Request): Response =>
  Response.json({ method: request.method, url: request.url, headers: [...request.headers] })

const build = (builder = Client.builder()) => builder.build().pipe(Effect.provide(noEnv))

describe("client", () => {
  it.live("plain_clients_refuse_https", () =>
    Effect.gen(function* () {
      const client = yield* build(Client.builder().plainHttp())
      const error = yield* Effect.flip(client.get("https://example.com/").send())
      expect(error.message).toContain("plain HTTP")
      expect(error.message).toBe("request failed: this client makes plain HTTP requests only")
    }),
  )

  it("parses_proxy_urls", () => {
    const proxy = ok("http://user:p%40ss@proxy.local:3128")
    expect(proxy.kind).toBe("Http")
    expect(proxy.auth).toEqual(["user", "p@ss"])
    expect(proxy.toString()).toBe("http://proxy.local:3128")
    const socks = ok("socks5h://10.0.0.2")
    expect(socks.kind).toBe("SocksRemoteDns")
    expect(socks.toString()).toBe("socks5h://10.0.0.2:1080")
    expect(Result.isFailure(Proxy.parse("proxy.local:3128"))).toBe(true)
    expect(Result.isFailure(Proxy.parse("ftp://proxy.local"))).toBe(true)
  })

  it("origins_rewrite_matching_prefixes", () => {
    const origins = new Origins([["https://chatgpt.com/backend-api", "http://127.0.0.1:9"]])
    expect(origins.apply("https://chatgpt.com/backend-api/wham/usage")).toBe("http://127.0.0.1:9/wham/usage")
    expect(origins.apply("https://chatgpt.com/backend-apix")).toBeUndefined()
    expect(origins.apply("https://api.anthropic.com/v1/messages")).toBeUndefined()
  })

  it("loopback_and_listed_hosts_bypass_the_proxy", () => {
    const bypass = new Bypass(["example.com", "internal"])
    expect(bypass.skips("127.0.0.1")).toBe(true)
    expect(bypass.skips("[::1]")).toBe(true)
    expect(bypass.skips("localhost")).toBe(true)
    expect(bypass.skips("api.example.com")).toBe(true)
    expect(bypass.skips("example.com")).toBe(true)
    expect(bypass.skips("notexample.com")).toBe(false)
    expect(bypass.skips("chatgpt.com")).toBe(false)
    expect(new Bypass(["*"]).skips("chatgpt.com")).toBe(true)
  })

  it("loopback IPs read as Rust's parser reads them", () => {
    const bypass = new Bypass()
    expect(bypass.skips("127.255.0.9")).toBe(true)
    expect(bypass.skips("0:0:0:0:0:0:0:1")).toBe(true)
    // Leading zeros are not an IPv4 address to Rust, and IPv4-mapped is not loopback.
    expect(bypass.skips("127.0.0.01")).toBe(false)
    expect(bypass.skips("::ffff:127.0.0.1")).toBe(false)
    expect(bypass.skips("128.0.0.1")).toBe(false)
  })

  it("proxy URLs: errors, default ports, case, credentials kept out of the display", () => {
    expect(err("proxy.local:3128")).toBe('proxy "proxy.local:3128" needs a scheme, like http:// or socks5://')
    expect(err("FTP://proxy.local")).toBe('unsupported proxy scheme "ftp"')
    expect(ok("HTTP://proxy.local/").toString()).toBe("http://proxy.local:80")
    expect(ok(" Socks5://u@10.0.0.2:9050// ").toString()).toBe("socks5://10.0.0.2:9050")
    expect(ok("socks5://u@10.0.0.2:9050").auth).toEqual(["u", ""])
    expect(ok("socks5://u@10.0.0.2:9050").kind).toBe("Socks")
    expect(ok("http://a:b:c@[::1]:8080").auth).toEqual(["a", "b:c"])
    expect(ok("http://[::1]").toString()).toBe("http://[::1]:80")
    expect(ok("http://[::1]").hostname).toBe("::1")
    expect(err("http://host:99999")).toBe('invalid proxy "http://host:99999": invalid authority')
  })

  it("proxy URLs are checked as http's Uri checks them", () => {
    // What Rust accepted, however odd, and where it stopped.
    expect(ok("  http://  ").toString()).toBe("http://:80")
    expect(ok("http://u:p@").toString()).toBe("http://:80")
    expect(ok("http://host:+80").toString()).toBe("http://host:+80")
    expect(ok("http://host:+80").port).toBe(80)
    expect(ok("http://host/path").toString()).toBe("http://host")
    expect(ok("http://host/path").port).toBe(80)
    expect(ok("socks5://host/path").port).toBe(80)
    expect(ok("http://host?x").toString()).toBe("http://host")
    expect(ok("http://h#x").toString()).toBe("http://h")
    expect(err("http://ü.example:80")).toBe('invalid proxy "http://ü.example:80": invalid uri character')
    expect(err("http://a b:80")).toBe('invalid proxy "http://a b:80": invalid uri character')
    expect(err("http://[::1:80")).toBe('invalid proxy "http://[::1:80": invalid authority')
    expect(err("http://h%41:80")).toBe('invalid proxy "http://h%41:80": invalid authority')
    expect(err("http://h/a b")).toBe('invalid proxy "http://h/a b": invalid uri character')
  })

  it.effect("which proxy: HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy; HTTP_PROXY is not read", () =>
    Effect.gen(function* () {
      const from = (vars: Record<string, string>) => Proxy.fromEnv.pipe(Effect.provide(env(vars)))
      expect((yield* from({ HTTPS_PROXY: "http://a:1", ALL_PROXY: "http://b:2" }))?.toString()).toBe("http://a:1")
      expect((yield* from({ HTTPS_PROXY: " ", all_proxy: "socks5h://b:2" }))?.toString()).toBe("socks5h://b:2")
      expect((yield* from({ https_proxy: "http://c:3" }))?.toString()).toBe("http://c:3")
      expect(yield* from({ HTTP_PROXY: "http://a:1", http_proxy: "http://a:1" })).toBeUndefined()
      // An unparsable value means none; the next name is not tried.
      expect(yield* from({ HTTPS_PROXY: "nonsense", ALL_PROXY: "http://b:2" })).toBeUndefined()
      const bypass = yield* Bypass.fromEnv.pipe(Effect.provide(env({ no_proxy: " .Example.COM, ,internal" })))
      expect(bypass.entries).toEqual(["example.com", "internal"])
      expect((yield* Bypass.fromEnv.pipe(Effect.provide(env({ NO_PROXY: "a", no_proxy: "b" })))).entries).toEqual(["a"])
      // An empty NO_PROXY is set, as std::env::var reads it, when the
      // provider keeps empty strings (the CLI's does).
      const keeping = ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { NO_PROXY: "", no_proxy: "x.example" }, preserveEmptyStrings: true }),
      )
      expect((yield* Bypass.fromEnv.pipe(Effect.provide(keeping))).entries).toEqual([])
    }),
  )

  it("statuses print as http prints them", () => {
    expect(statusText(404)).toBe("404 Not Found")
    expect(statusText(203)).toBe("203 Non Authoritative Information")
    expect(statusText(599)).toBe("599 <unknown status code>")
  })

  it.live("headers: header replaces, headers keeps every value, the agent fills in only when missing", () =>
    Effect.gen(function* () {
      const up = yield* upstream(echo)
      const client = yield* build(Client.builder().userAgent("slopmax/test"))
      const seen = (yield* (yield* client
        .post(`${up.url}/x?y=1`)
        .header("X-One", "a")
        .header("x-one", "b")
        .header("x-many", "keep-me-not")
        .headers([
          ["x-many", "1"],
          ["X-Many", "2"],
        ])
        .json({ hi: "é" })
        .send()).json()) as { method: string; url: string; headers: Array<[string, string]> }
      const headers = new Map<string, Array<string>>()
      for (const [name, value] of seen.headers) headers.set(name, [...(headers.get(name) ?? []), value])
      expect(seen.method).toBe("POST")
      expect(seen.url.endsWith("/x?y=1")).toBe(true)
      expect(headers.get("x-one")).toEqual(["b"])
      expect(headers.get("x-many")?.join(", ")).toBe("1, 2")
      expect(headers.get("content-type")).toEqual(["application/json"])
      expect(headers.get("user-agent")).toEqual(["slopmax/test"])
      expect(headers.get("accept-encoding")).toBeUndefined()
      const own = (yield* (yield* client.get(up.url).header("user-agent", "mine").send()).json()) as {
        headers: Array<[string, string]>
      }
      expect(own.headers.filter(([name]) => name === "user-agent")).toEqual([["user-agent", "mine"]])
    }),
  )

  it.live("forms set their content type; bearer auth sets authorization", () =>
    Effect.gen(function* () {
      const up = yield* upstream(async (request) =>
        Response.json({
          type: request.headers.get("content-type"),
          auth: request.headers.get("authorization"),
          body: await request.text(),
        }),
      )
      const client = yield* build()
      const answer = yield* (yield* client
        .post(up.url)
        .bearerAuth("tok")
        .form([
          ["a", "b c"],
          ["d", "é"],
        ])
        .send()).json(Schema.Struct({ type: Schema.String, auth: Schema.String, body: Schema.String }))
      expect(answer).toEqual({ type: "application/x-www-form-urlencoded", auth: "Bearer tok", body: "a=b+c&d=%C3%A9" })
    }),
  )

  it.live("an invalid header or JSON value fails at send", () =>
    Effect.gen(function* () {
      const client = yield* build()
      const name = yield* Effect.flip(client.get("http://127.0.0.1:9/").header("bad name", "x").send())
      expect(name.message).toBe("invalid request: invalid HTTP header name")
      const value = yield* Effect.flip(client.get("http://127.0.0.1:9/").header("x", "a\nb").send())
      expect(value.message).toBe("invalid request: failed to parse header value")
      const json = yield* Effect.flip(client.post("http://127.0.0.1:9/").json({ n: 1n }).send())
      expect(json.kind).toBe("Request")
      const url = yield* Effect.flip(client.get("not a url").send())
      expect(url.message).toBe('invalid request: invalid URL "not a url": invalid uri character')
      const spaced = yield* Effect.flip(client.get("http://127.0.0.1:9/a b").send())
      expect(spaced.message).toBe('invalid request: invalid URL "http://127.0.0.1:9/a b": invalid uri character')
      const ftp = yield* Effect.flip(client.get("ftp://127.0.0.1:9/").send())
      expect(ftp.message).toBe("request failed: unsupported scheme ftp")
      const relative = yield* Effect.flip(client.get("127.0.0.1:9").send())
      expect(relative.message).toBe("request failed: client error (UserAbsoluteUriRequired)")
    }),
  )

  it.live("non-ASCII header values go out as their UTF-8 bytes", () =>
    Effect.gen(function* () {
      const up = yield* upstream((request) => new Response(request.headers.get("x-name") ?? ""))
      const client = yield* build()
      const text = yield* (yield* client.get(up.url).header("x-name", "café").send()).text()
      expect(Buffer.from(text, "latin1").toString("utf8")).toBe("café")
    }),
  )

  it.live("compressed bodies pass through untouched", () =>
    Effect.gen(function* () {
      const packed = gzipSync("hello, compressed world")
      const up = yield* upstream(
        () => new Response(packed, { headers: { "content-encoding": "gzip", "content-type": "text/plain" } }),
      )
      const client = yield* build()
      const response = yield* client.get(up.url).header("accept-encoding", "gzip").send()
      expect(response.headers.get("content-encoding")).toBe("gzip")
      expect(Buffer.from(yield* response.bytes()).equals(packed)).toBe(true)
    }),
  )

  it.live("connections are kept alive and reused", () =>
    Effect.gen(function* () {
      const ports: Array<number> = []
      const up = yield* upstream((request, server) => {
        ports.push(server.requestIP(request)?.port ?? 0)
        return new Response("ok")
      })
      const client = yield* build()
      for (let i = 0; i < 3; i++) yield* (yield* client.get(up.url).send()).text()
      expect(new Set(ports).size).toBe(1)
    }),
  )

  it.live("redirects are answers, not followed", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response(null, { status: 302, headers: { location: "/elsewhere" } }))
      const client = yield* build()
      const response = yield* client.get(up.url).send()
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/elsewhere")
    }),
  )

  it.live("errors say what failed and why", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response("nope", { status: 404 }))
      const client = yield* build()
      const status = yield* Effect.flip(Effect.flatMap(client.get(up.url).send(), (r) => r.errorForStatus()))
      expect(status.message).toBe("HTTP 404 Not Found")
      expect(status.status).toBe(404)
      const refused = yield* Effect.flip(client.get("http://127.0.0.1:1/").send())
      expect(refused.message).toBe(`request failed: Connection refused (os error ${constants.errno.ECONNREFUSED})`)
      const decode = yield* Effect.flip(Effect.flatMap(client.get(up.url).send(), (r) => r.json()))
      expect(decode.message.startsWith("unexpected response: ")).toBe(true)
    }),
  )

  it.live("timeouts: the total covers headers and body, the read timeout every wait", () =>
    Effect.gen(function* () {
      const up = yield* upstream((request) => {
        const path = new URL(request.url).pathname
        if (path === "/slow") return Bun.sleep(2_000).then(() => new Response("late"))
        let stop = false
        request.signal.addEventListener("abort", () => (stop = true))
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode("a"))
            await Bun.sleep(path === "/stall" ? 2_000 : 20)
            if (stop) controller.close()
          },
        })
        return new Response(stream)
      })
      const total = yield* build(Client.builder().timeout("300 millis"))
      const noAnswer = yield* Effect.flip(total.get(`${up.url}/slow`).send())
      expect(noAnswer.message).toBe("timed out: no response")
      expect(noAnswer.isTimeout()).toBe(true)
      const endless = yield* total.get(`${up.url}/drip`).send()
      const body = yield* Effect.flip(endless.bytes())
      expect(body.message).toBe("timed out: reading the body")

      const reading = yield* build(Client.builder().readTimeout("300 millis"))
      expect((yield* Effect.flip(reading.get(`${up.url}/slow`).send())).message).toBe("timed out: no response")
      const stalled = yield* reading.get(`${up.url}/stall`).send()
      const stall = yield* Effect.flip(read(stalled.intoBody(), 100))
      expect(stall.message).toBe("no data for 300ms")
      // A request's own timeout wins over the client's.
      const own = yield* Effect.flip(total.get(`${up.url}/slow`).timeout("100 millis").send())
      expect(own.isTimeout()).toBe(true)
    }),
  )

  it.live("bytes reads at most 64 MiB", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response(new Uint8Array(MAX_BODY + 1)))
      const client = yield* build()
      const error = yield* Effect.flip(Effect.flatMap(client.get(up.url).send(), (r) => r.bytes()))
      expect(error.message).toBe("reading the response failed: length limit exceeded")
    }),
  )

  it.live("an HTTP proxy gets Basic credentials; loopback goes direct", () =>
    Effect.gen(function* () {
      const up = yield* upstream(() => new Response("direct"))
      const proxy = yield* httpProxy(() => up.port)
      const client = yield* build(Client.builder().proxy(ok(`http://us%3Aer:p%40ss@${proxy.url.slice(7)}`)))
      expect(yield* (yield* client.get("http://upstream.test/x").send()).text()).toBe("proxied")
      expect(proxy.heads[0]?.startsWith("GET http://upstream.test/x HTTP/1.1\r\n")).toBe(true)
      const basic = Buffer.from("us:er:p@ss").toString("base64")
      expect(proxy.heads[0]?.toLowerCase()).toContain(`proxy-authorization: basic ${basic}`.toLowerCase())
      expect(yield* (yield* client.get(up.url).send()).text()).toBe("direct")
      expect(proxy.heads.length).toBe(1)
    }),
  )

  it.live("a SOCKS5 proxy, with user and password, carries plain HTTP through the bridge", () =>
    Effect.gen(function* () {
      const up = yield* upstream(echo)
      const socks = yield* socksProxy(() => up.port, ["user", "pa ss"])
      const client = yield* build(Client.builder().proxy(ok(`socks5h://user:pa%20ss@127.0.0.1:${socks.port}`)))
      const seen = (yield* (yield* client.get("http://upstream.test:8080/path?q=1").send()).json()) as {
        url: string
        headers: Array<[string, string]>
      }
      expect(new URL(seen.url).pathname + new URL(seen.url).search).toBe("/path?q=1")
      expect(seen.headers.some(([name, value]) => name === "host" && value === "upstream.test:8080")).toBe(true)
      expect(socks.requests[0]).toEqual({
        methods: [2],
        auth: ["user", "pa ss"],
        kind: 3,
        host: "upstream.test",
        port: 8080,
      })
    }),
  )

  it.live("a 101 hands over its connection, directly or through either proxy", () =>
    Effect.gen(function* () {
      const up = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, server) =>
              server.upgrade(request, { headers: { "x-models-etag": "e1" } })
                ? undefined
                : new Response("no", { status: 400 }),
            websocket: { message: (ws, message) => void ws.send(`echo:${String(message)}`) },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const port = up.port ?? 0
      const http = yield* httpProxy(() => port)
      const socks = yield* socksProxy(() => port)
      const clients = [
        [yield* build(), `http://127.0.0.1:${port}/ws`],
        [
          yield* build(Client.builder().proxy(ok(`http://u:p@${http.url.slice(7)}`))),
          `http://upstream.test:${port}/ws`,
        ],
        [
          yield* build(Client.builder().proxy(ok(`socks5h://127.0.0.1:${socks.port}`))),
          `http://upstream.test:${port}/ws`,
        ],
      ] as const
      for (const [client, url] of clients) {
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
        expect(response.headers.get("x-models-etag")).toBe("e1")
        const socket = yield* response.upgrade()
        yield* Writer.client(socket).send(Message.text("hi"))
        expect(yield* new Reader(socket).message).toEqual(Message.text("echo:hi"))
        yield* socket.close
      }
      expect(
        http.heads[0]?.startsWith(`CONNECT upstream.test:${port} HTTP/1.1\r\nHost: upstream.test:${port}\r\n`),
      ).toBe(true)
      expect(http.heads[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("u:p").toString("base64")}\r\n`)
      expect(socks.requests[0]).toMatchObject({ methods: [0], kind: 3, host: "upstream.test", port })
      // A refused upgrade is an ordinary answer, its body read.
      const refused = yield* (yield* build()).get(`http://127.0.0.1:${port}/ws`).header("upgrade", "websocket").send()
      expect(refused.status).toBe(400)
      expect(yield* refused.text()).toBe("no")
      expect((yield* Effect.flip(refused.upgrade())).kind).toBe("Connect")
    }),
  )

  it.live("intoBody streams chunks as they come", () =>
    Effect.gen(function* () {
      const up = yield* upstream(
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                for (const part of ["a", "b", "c"]) {
                  controller.enqueue(new TextEncoder().encode(part))
                  await Bun.sleep(10)
                }
                controller.close()
              },
            }),
          ),
      )
      const client = yield* build(Client.builder().readTimeout("2 seconds"))
      const chunks = yield* Stream.runCollect((yield* client.get(up.url).send()).intoBody())
      expect(chunks.map((c) => new TextDecoder().decode(c)).join("")).toBe("abc")
    }),
  )

  it.live(
    "the connect timeout bounds a connect that never completes, with or without an upgrade",
    () =>
      Effect.gen(function* () {
        // TEST-NET-1 is never routed: a connect there stalls (or fails at once
        // where there is no route at all).
        const client = yield* build(Client.builder().connectTimeout("300 millis").proxy(ok("http://192.0.2.1:9")))
        for (const upgrade of [false, true]) {
          const request = client.get("http://upstream.test/")
          if (upgrade) request.header("upgrade", "websocket")
          const started = Date.now()
          const error = yield* Effect.flip(request.send())
          expect(Date.now() - started).toBeLessThan(5_000)
          expect(error.kind).toBe("Connect")
          expect(["request failed: deadline has elapsed", "request failed: Network is unreachable"]).toContain(
            error.message.replace(/ \(os error \d+\)$/, ""),
          )
        }
      }),
    15_000,
  )

  it.live("a SOCKS5 proxy that cannot reach the target fails the request with its reason", () =>
    Effect.gen(function* () {
      const socks = yield* socksProxy(() => 1)
      const client = yield* build(Client.builder().proxy(ok(`socks5h://127.0.0.1:${socks.port}`)))
      for (const url of ["http://upstream.test/", "https://upstream.test/"]) {
        const error = yield* Effect.flip(client.get(url).send())
        expect(error.message).toBe("request failed: SOCKS error: connection refused")
      }
      const down = yield* build(Client.builder().proxy(ok("socks5://127.0.0.1:1")))
      expect((yield* Effect.flip(down.get("http://upstream.test/").send())).message).toBe(
        "request failed: SOCKS error: failed to create underlying connection",
      )
    }),
  )

  it.live("layerHttpClient sends effect/http requests through the client", () =>
    Effect.gen(function* () {
      const up = yield* upstream(echo)
      const client = yield* build(Client.builder().origins(new Origins([["https://api.test", up.url]])))
      const response = yield* HttpClient.get("https://api.test/v1?x=1").pipe(Effect.provide(layerHttpClient(client)))
      const seen = (yield* response.json) as { url: string }
      expect(new URL(seen.url).pathname + new URL(seen.url).search).toBe("/v1?x=1")
    }),
  )
})
