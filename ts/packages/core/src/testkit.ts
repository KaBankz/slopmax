// Test helpers: throwaway directories and a local stand-in for a provider's
// servers, reached through a `Client` whose origins point at it.
//
// For tests only; nothing in the package's public surface imports it.
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ConfigProvider, Effect, Layer, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { ids } from "@slopmax/common"
import { Client, Origins, server } from "@slopmax/net"

/** A fresh, empty directory under the system's temp dir. */
export const tempDir = (name: string): string => {
  const dir = join(tmpdir(), `slopmax-${name}-${ids.token()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A fresh directory removed when the scope closes. */
export const scopedTempDir = (name: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => tempDir(name)),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

/** No environment at all, so nothing a test does depends on the machine's. */
export const noEnv: Layer.Layer<never> = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

/** One request the mock received. */
export interface Seen {
  readonly method: string
  /** Path and query. */
  readonly path: string
  readonly headers: Headers
  readonly body: Uint8Array
}

const decoder = new TextDecoder()

export const Seen = {
  text: (self: Seen): string => decoder.decode(self.body),

  json: (self: Seen): unknown => JSON.parse(decoder.decode(self.body)),

  header: (self: Seen, name: string): string | undefined => self.headers.get(name) ?? undefined,

  /** The path without its query. */
  route: (self: Seen): string => self.path.split("?")[0] ?? "",
} as const

/** An answer with a status and a body. */
export interface Reply {
  readonly status: number
  readonly body: string | Uint8Array
  readonly headers?: Readonly<Record<string, string>>
}

/** An answer with a status and a body. */
export const reply = (status: number, body: string | Uint8Array): Reply => ({ status, body })

/** A JSON answer. */
export const json = (status: number, value: unknown): Reply => ({
  status,
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
})

/**
 * A local HTTP server that records each request and answers with
 * `handler`. Probes of `/` from other programs on the machine are answered
 * 404 and not recorded. It stops when the scope closes.
 */
export class Mock {
  private constructor(
    readonly url: string,
    private readonly log: Array<Seen>,
  ) {}

  static readonly start = Effect.fn("Mock.start")(function* (
    handler: (seen: Seen) => Reply,
  ): Effect.fn.Return<Mock, never, Scope.Scope> {
    const listener = yield* server.bind({ hostname: "127.0.0.1", port: 0 }).pipe(Effect.orDie)
    const log: Array<Seen> = []
    yield* listener.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://127.0.0.1")
        if (url.pathname === "/") return HttpServerResponse.empty({ status: 404 })
        const body = new Uint8Array(yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))))
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) headers.append(name, value)
        const seen: Seen = { method: request.method, path: url.pathname + url.search, headers, body }
        const answer = handler(seen)
        log.push(seen)
        return HttpServerResponse.uint8Array(
          typeof answer.body === "string" ? new TextEncoder().encode(answer.body) : answer.body,
          {
            status: answer.status,
            headers: answer.headers ?? {},
            ...(answer.headers?.["content-type"] === undefined ? {} : { contentType: answer.headers["content-type"] }),
          },
        )
      }),
    )
    return new Mock(`http://127.0.0.1:${listener.port}`, log)
  })

  /** Every request so far, oldest first. */
  seen(): ReadonlyArray<Seen> {
    return [...this.log]
  }

  /** Requests to `route` (a path without query). */
  seenAt(route: string): ReadonlyArray<Seen> {
    return this.log.filter((s) => Seen.route(s) === route)
  }

  /**
   * A client that sends each of `prefixes` (such as
   * `https://api.anthropic.com`) to this server instead.
   */
  client(prefixes: ReadonlyArray<string>): Effect.Effect<Client> {
    const origins = new Origins(prefixes.map((p) => [p, this.url] as const))
    return Client.builder().plainHttp().origins(origins).build().pipe(Effect.provide(noEnv))
  }
}
