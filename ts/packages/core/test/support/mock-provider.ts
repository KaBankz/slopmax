// The providers on a real socket: one `Bun.serve` on 127.0.0.1:0 per test
// that answers HTTP, event streams and WebSockets from the same scripts the
// in-process upstream uses, so a scenario behaves the same whether the
// daemon talks to providers in process or over the network.
//
// slopmax reaches it through origin rewriting (`Upstream.layerOrigins`):
// each provider origin (`https://api.anthropic.com`, `https://chatgpt.com`,
// …) is sent to `{mock}/_/https/{host}`, and the mock rebuilds the URL
// slopmax meant before answering. Scripts match and record the provider's
// own URLs.
//
// The mock is also the outbound proxy a harness configures, so a call to a
// host nobody rewrote (a provider origin added to slopmax but not to
// `providerOrigins`) reaches the mock as a proxy request instead of the
// real network: it is refused with 403 and kept in `leaks`, and the harness
// fails the scenario over it.
//
// Requests for `/` are answered 404 and not recorded: other programs on the
// machine probe open ports, and their probes must not show up in a test.
import { Data, Effect, type Scope } from "effect"
import { type Data as SocketData, type Script, scripts as chatgptScripts, tokenOf } from "../socket/chatgpt.ts"
import { type MemoryUpstream, memoryUpstream, type Route } from "./memory-upstream.ts"

/** One thing the mock's WebSocket endpoint saw: a handshake (`ws {uri}`), then each text message received. */
export type SocketSeen = Data.TaggedEnum<{
  Open: { readonly url: string; readonly headers: Headers; readonly token: string | undefined }
  Message: { readonly token: string; readonly text: string }
}>
export const SocketSeen = Data.taggedEnum<SocketSeen>()

/** The provider origins slopmax calls, every one of which a harness rewrites to the mock. */
export const providerOrigins: ReadonlyArray<string> = [
  "https://api.anthropic.com",
  "https://platform.claude.com",
  "https://claude.ai",
  "https://chatgpt.com",
  "https://auth.openai.com",
  "https://api.openai.com",
  "https://api.x.ai",
]

export interface MockProvider {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string
  /** The recorder and the scripts: every HTTP call, by the URL slopmax meant. */
  readonly upstream: MemoryUpstream
  /** The handshakes and text messages its WebSocket endpoint saw, in order. */
  readonly sockets: ReadonlyArray<SocketSeen>
  /** How many probes of `/` it answered without recording them. */
  readonly probes: () => number
  /** Calls to hosts nobody rewrote, which reached the mock as their proxy (`CONNECT host:443`, or `GET http://…`) and were refused. */
  readonly leaks: ReadonlyArray<string>
  /** Where each of `origins` (and every provider origin) goes instead: the mock. */
  readonly origins: (extra?: ReadonlyArray<string>) => Readonly<Record<string, string>>
}

const rewritten = /^\/_\/(https?)\/([^/]+)(\/.*)?$/

/** The URL slopmax meant, from one the origin rewrite sent to the mock; anything else is a call to the mock itself. */
export const intended = (url: URL): string => {
  const parts = rewritten.exec(url.pathname)
  if (parts === null) return url.href
  return `${parts[1]}://${parts[2]}${parts[3] ?? ""}${url.search}`
}

const notFound = () =>
  new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } })

/** The headers a request carried, as the provider would see them: the mock's own host is not one of them. */
const forwarded = (headers: Headers): Headers => {
  const out = new Headers(headers)
  out.delete("host")
  return out
}

/**
 * ChatGPT's socket scripts as a spent account really answers: `tok-limited`
 * opens each turn with `response.created` and only then reports
 * `usage_limit_reached`, so the relay has already passed an event on to
 * Codex when it learns the account is spent.
 */
export const socketScripts: Readonly<Record<string, Script>> = {
  ...chatgptScripts,
  "tok-limited": (send, _ws, message) => {
    if (typeof message !== "string" || !message.includes('"response.create"')) return
    send({ type: "response.created", response: { id: "resp_limited", status: "in_progress" } })
    send({
      type: "error",
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: Math.floor(Date.now() / 1000) + 5400,
      },
    })
  },
}

export interface Options {
  /** The HTTP scripts. */
  readonly routes: ReadonlyArray<Route>
  /** The WebSocket scripts, by bearer token: {@link socketScripts} by default. */
  readonly sockets?: Readonly<Record<string, Script>>
  /**
   * A name the mock also answers to, which `origins` then points at. slopmax
   * reaches loopback directly, never through a proxy; under a name that is
   * not loopback, calls to the mock go through the outbound proxy instead.
   */
  readonly alias?: string
}

/** The mock provider, listening until the scope closes. */
export const mockProvider = (options: Options): Effect.Effect<MockProvider, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const upstream = memoryUpstream(options.routes)
      const scripts = options.sockets ?? socketScripts
      const sockets: Array<SocketSeen> = []
      const leaks: Array<string> = []
      let probes = 0
      const server = Bun.serve<SocketData>({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch: async (request, srv) => {
          // A proxy request names its target, not the mock: a tunnel's `host:port`, or an absolute URL elsewhere.
          const own = [`http://127.0.0.1:${srv.port}/`, `http://${options.alias ?? "127.0.0.1"}:${srv.port}/`]
          if (request.method === "CONNECT" || !own.some((start) => request.url.startsWith(start))) {
            leaks.push(`${request.method} ${request.url}`)
            return new Response("not rewritten to the mock", { status: 403 })
          }
          const url = new URL(request.url)
          if (url.pathname === "/") {
            probes += 1
            return notFound()
          }
          const target = intended(url)
          const headers = forwarded(request.headers)
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const token = tokenOf(request.headers)
            sockets.push(SocketSeen.Open({ url: target, headers, token }))
            if (token === undefined || scripts[token] === undefined) {
              return new Response("invalid token", { status: 401 })
            }
            const upgraded = srv.upgrade(request, {
              headers: { "openai-model": "gpt-6-sol", "x-reasoning-included": "true", "x-models-etag": "etag-1" },
              data: { token },
            })
            return upgraded ? undefined : new Response("not a socket", { status: 400 })
          }
          const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
          return upstream.handle(
            new Request(target, { method: request.method, headers, ...(body === undefined ? {} : { body }) }),
          )
        },
        websocket: {
          maxPayloadLength: 64 * 1024 * 1024,
          message: (ws, message) => {
            const bytes = typeof message === "string" ? message : new Uint8Array(message)
            if (typeof bytes === "string") sockets.push(SocketSeen.Message({ token: ws.data.token, text: bytes }))
            scripts[ws.data.token]?.((event) => void ws.send(JSON.stringify(event)), ws, bytes)
          },
        },
      })
      const mock = (port: number): MockProvider => {
        const url = `http://127.0.0.1:${port}`
        return {
          url,
          upstream,
          sockets,
          probes: () => probes,
          leaks,
          origins: (extra = []) =>
            Object.fromEntries(
              [...providerOrigins, ...extra].map((origin) => {
                const at = new URL(origin)
                const to = options.alias === undefined ? url : `http://${options.alias}:${port}`
                return [origin, `${to}/_/${at.protocol.slice(0, -1)}/${at.host}`] as const
              }),
            ),
        }
      }
      return { server, mock }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(
    // Port 0 on 127.0.0.1 always gets a port; a server without one could not be reached at all.
    Effect.flatMap(({ server, mock }) =>
      server.port === undefined ? Effect.die("the mock provider has no port") : Effect.succeed(mock(server.port)),
    ),
  )
