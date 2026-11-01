import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted } from "effect"
import { it, MemoryFileSystem } from "@slopmax/test"
import type { Connection } from "../src/main/engine.ts"
import {
  ApiFetch,
  contentSecurityPolicy,
  fileHeaders,
  forward,
  forwardHeaders,
  handle,
  route,
  serveFile,
} from "../src/main/protocol.ts"
import { fakeEngine } from "./support.ts"

describe("addresses on the app's origin", () => {
  test("the API goes to the proxy with its query; everything else is one of the UI's files", () => {
    expect(route("app://slopmax/slopmax/api/usage/history?range=week")).toEqual({
      _tag: "Api",
      path: "/slopmax/api/usage/history?range=week",
    })
    expect(route("app://slopmax/slopmax/api")).toEqual({ _tag: "Api", path: "/slopmax/api" })
    expect(route("app://slopmax/")).toEqual({ _tag: "File", file: "index.html" })
    expect(route("app://slopmax/#/panel")).toEqual({ _tag: "File", file: "index.html" })
    expect(route("app://slopmax/index-abc.js")).toEqual({ _tag: "File", file: "index-abc.js" })
    expect(route("app://slopmax/some%20file.txt")).toEqual({ _tag: "File", file: "some file.txt" })
  })

  test("another host, another scheme, or a mangled name is not found", () => {
    expect(route("app://elsewhere/index.html")._tag).toBe("NotFound")
    expect(route("https://slopmax/index.html")._tag).toBe("NotFound")
    expect(route("app://slopmax/%E0%A4%A")._tag).toBe("NotFound")
    expect(route("not a url")._tag).toBe("NotFound")
  })

  test("pages carry the content security policy; every file says its type and is not sniffed", () => {
    expect(fileHeaders(".html")).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": contentSecurityPolicy,
      "x-content-type-options": "nosniff",
    })
    expect(fileHeaders(".js")["content-security-policy"]).toBeUndefined()
    expect(fileHeaders(".woff2")["content-type"]).toBe("font/woff2")
    expect(contentSecurityPolicy).toContain("script-src 'self'")
    expect(contentSecurityPolicy).toContain("connect-src 'self'")
  })
})

const ui = "/app/ui"
const disk = MemoryFileSystem.layerWith({
  files: { "/app/ui/index.html": "<!doctype html>", "/app/ui/app.js": "run()", "/app/secret.txt": "nope" },
})

describe("the UI's files", () => {
  it.effect("are served with their type", () =>
    Effect.gen(function* () {
      const page = yield* serveFile(ui, "index.html")
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(yield* Effect.promise(() => page.text())).toBe("<!doctype html>")
    }).pipe(Effect.provide(disk)),
  )

  it.effect("nothing outside the UI's directory, and nothing missing, is served", () =>
    Effect.gen(function* () {
      expect((yield* serveFile(ui, "../secret.txt")).status).toBe(404)
      expect((yield* serveFile(ui, "/app/secret.txt")).status).toBe(404)
      expect((yield* serveFile(ui, "missing.js")).status).toBe(404)
    }).pipe(Effect.provide(disk)),
  )
})

const connection = (key: string): Connection => ({
  url: "http://127.0.0.1:7567",
  key: Redacted.make(key),
  version: "0.4.0",
})

/** An engine that answers only what forwarding asks, and a proxy that records what reaches it. */
const proxied = (options: {
  readonly running: Option.Option<Connection>
  readonly fresh?: Option.Option<Connection>
  readonly answer: (request: Request) => Response | Promise<Response>
}) => {
  const seen: Array<Request> = []
  const layer = Layer.mergeAll(
    fakeEngine({
      ready: Effect.succeed(options.running),
      refreshKey: Effect.succeed(options.fresh ?? Option.none()),
    }),
    Layer.succeed(ApiFetch, async (request: Request) => {
      seen.push(request)
      return options.answer(request)
    }),
  )
  return { layer, seen }
}

const body = (response: Response) => Effect.promise(() => response.text())

describe("calls to slopmax's API", () => {
  test("carry what matters from the window, and the owner key instead of anything the window sent", () => {
    const headers = forwardHeaders(
      new Headers({
        accept: "text/event-stream",
        "content-type": "application/json",
        cookie: "a=b",
        origin: "app://slopmax",
        authorization: "Bearer from-the-window",
      }),
      Redacted.make("sm-one"),
    )
    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: "Bearer sm-one",
    })
  })

  it.effect("reach the running proxy with their method, body and query, and stream back", () => {
    const { layer, seen } = proxied({
      running: Option.some(connection("sm-one")),
      answer: () => new Response("ok", { status: 201, headers: { "content-encoding": "gzip", "x-kept": "1" } }),
    })
    return Effect.gen(function* () {
      const answer = yield* forward(
        new Request("app://slopmax/slopmax/api/accounts?x=1", { method: "POST", body: '{"a":1}' }),
        "/slopmax/api/accounts?x=1",
      )
      expect(answer.status).toBe(201)
      expect(yield* body(answer)).toBe("ok")
      // The body arrives decoded, so the header describing the wire is not passed on.
      expect(answer.headers.get("content-encoding")).toBeNull()
      expect(answer.headers.get("x-kept")).toBe("1")
      const sent = seen[0]
      expect(sent?.url).toBe("http://127.0.0.1:7567/slopmax/api/accounts?x=1")
      expect(sent?.method).toBe("POST")
      expect(sent?.headers.get("authorization")).toBe("Bearer sm-one")
      expect(yield* Effect.promise(() => sent?.text() ?? Promise.resolve(""))).toBe('{"a":1}')
    }).pipe(Effect.provide(layer))
  })

  it.effect("answer 503 while no proxy runs on the bundled release", () => {
    const { layer, seen } = proxied({ running: Option.none(), answer: () => new Response("never") })
    return Effect.gen(function* () {
      const answer = yield* forward(new Request("app://slopmax/slopmax/api/status"), "/slopmax/api/status")
      expect(answer.status).toBe(503)
      expect(JSON.parse(yield* body(answer))).toMatchObject({ _tag: "NotRunning" })
      expect(seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a refused key is read again and the call sent once more with the new one", () => {
    const { layer, seen } = proxied({
      running: Option.some(connection("sm-old")),
      fresh: Option.some(connection("sm-new")),
      answer: (request) =>
        request.headers.get("authorization") === "Bearer sm-new"
          ? Response.json({ fine: true })
          : new Response("no", { status: 401 }),
    })
    return Effect.gen(function* () {
      const answer = yield* forward(
        new Request("app://slopmax/slopmax/api/settings", { method: "PATCH", body: "{}" }),
        "/slopmax/api/settings",
      )
      expect(answer.status).toBe(200)
      expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer sm-old", "Bearer sm-new"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a proxy that stops mid-call reads as not running", () => {
    const { layer } = proxied({
      running: Option.some(connection("sm-one")),
      answer: () => Promise.reject(new Error("connection reset")),
    })
    return Effect.gen(function* () {
      const answer = yield* forward(new Request("app://slopmax/slopmax/api/status"), "/slopmax/api/status")
      expect(answer.status).toBe(503)
    }).pipe(Effect.provide(layer))
  })

  it.effect("files take only GET, and other origins are not found", () => {
    const { layer } = proxied({ running: Option.none(), answer: () => new Response("never") })
    return Effect.gen(function* () {
      const respond = handle(ui)
      expect((yield* respond(new Request("app://slopmax/app.js"))).status).toBe(200)
      expect((yield* respond(new Request("app://slopmax/app.js", { method: "POST", body: "x" }))).status).toBe(405)
      expect((yield* respond(new Request("app://elsewhere/app.js"))).status).toBe(404)
    }).pipe(Effect.provide(Layer.merge(layer, disk)))
  })
})
