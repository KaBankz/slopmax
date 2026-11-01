// The window's origin, `app://slopmax/`. The UI ships inside the app and is
// served from here, so no program squatting on the proxy's port can ever hand
// the window a page, and the window still draws while the proxy is down.
// Calls to slopmax's API (`/slopmax/api/*`) are passed to the running proxy
// with the owner key added here; the key never reaches the window, and the
// window needs no CORS because the API is on its own origin.
import { Context, Data, Effect, FileSystem, Option, Path, Redacted } from "effect"
import { apiPrefix } from "@slopmax/domain/api"
import { type Connection, Engine } from "./engine.ts"

export const scheme = "app"
export const host = "slopmax"
export const origin = `${scheme}://${host}`

/** What an address on the app's origin asks for. */
export type Route = Data.TaggedEnum<{
  /** A call to slopmax's API, passed to the proxy as `path` (with its query). */
  Api: { readonly path: string }
  /** One of the UI's files, relative to the UI's directory. */
  File: { readonly file: string }
  NotFound: {}
}>
export const Route = Data.taggedEnum<Route>()

/** A path's name decoded; none when its escapes are broken. */
const decoded = (name: string): Option.Option<string> => {
  try {
    return Option.some(decodeURIComponent(name))
  } catch {
    return Option.none()
  }
}

export const route = (url: string): Route => {
  const parsed = URL.parse(url)
  if (parsed === null || parsed.protocol !== `${scheme}:` || parsed.host !== host) return Route.NotFound()
  const pathname = parsed.pathname
  if (pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`)) {
    return Route.Api({ path: `${pathname}${parsed.search}` })
  }
  if (pathname === "/" || pathname === "") return Route.File({ file: "index.html" })
  return Option.match(decoded(pathname.slice(1)), {
    onNone: () => Route.NotFound(),
    onSome: (file) => (file === "" || file.includes("\0") ? Route.NotFound() : Route.File({ file })),
  })
}

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
}

export const contentType = (extension: string): string => types[extension.toLowerCase()] ?? "application/octet-stream"

/**
 * The window's content security policy: nothing but the app's own files and
 * its own origin's API, no inline script, and no way to be framed or to post
 * a form elsewhere.
 */
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** Headers on every file the app serves. */
export const fileHeaders = (extension: string): Record<string, string> => ({
  "content-type": contentType(extension),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  ...(extension === ".html" ? { "content-security-policy": contentSecurityPolicy, "cache-control": "no-cache" } : {}),
})

/** Request headers the proxy should see from the window; the rest (cookies, the page's origin) stay behind. */
const passed = ["accept", "content-type", "last-event-id", "cache-control"]

/** The headers a call carries to the proxy: what the window sent that matters, and the owner key. */
export const forwardHeaders = (from: Headers, key: Redacted.Redacted<string>): Headers => {
  const headers = new Headers()
  for (const name of passed) {
    const value = from.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set("authorization", `Bearer ${Redacted.value(key)}`)
  return headers
}

/** Response headers that describe the bytes as they crossed the wire, not as the window receives them. */
const wireOnly = ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** What the window hears while no proxy runs on the bundled release: it then shows the stopped view. */
export const notRunning = (): Response => json(503, { _tag: "NotRunning", message: "the proxy is not running" })

/** How main reaches the proxy: Electron's `net.fetch`, which streams. A test gives its own. */
export class ApiFetch extends Context.Service<ApiFetch, (request: Request) => Promise<Response>>()(
  "slopmax-desktop/ApiFetch",
) {}

/**
 * Passes a call to the proxy and its answer back as it streams. A refused key
 * is read again once (someone changed it in `config.json`), and the call is
 * tried again with the new one.
 */
export const forward = Effect.fn("Protocol.forward")(
  function* (request: Request, path: string) {
    const engine = yield* Engine
    const send = yield* ApiFetch
    // A call made while the app is still starting the proxy waits for it, rather than failing at once.
    const running = yield* engine.ready
    if (Option.isNone(running)) return notRunning()
    // Calls to the API carry small JSON bodies; holding one lets a refused call be sent again.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : yield* Effect.promise(() => request.arrayBuffer())
    const call = (connection: Connection) =>
      Effect.tryPromise(() =>
        send(
          new Request(`${connection.url}${path}`, {
            method: request.method,
            headers: forwardHeaders(request.headers, connection.key),
            ...(body === undefined ? {} : { body }),
            signal: request.signal,
          }),
        ),
      )
    let answer = yield* call(running.value)
    if (answer.status === 401) {
      const fresh = yield* engine.refreshKey
      if (Option.isSome(fresh)) answer = yield* call(fresh.value)
    }
    const headers = new Headers(answer.headers)
    for (const name of wireOnly) headers.delete(name)
    return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers })
  },
  Effect.catchCause((cause) => Effect.as(Effect.logWarning("a call to the proxy failed", cause), notRunning())),
)

/** Serves one of the UI's files from `root`; anything outside it, or missing, is not found. */
export const serveFile = Effect.fn("Protocol.file")(function* (root: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolved = path.resolveWithin(root, file)
  if (Option.isNone(resolved)) return new Response("not found", { status: 404 })
  const bytes = yield* fs.readFile(resolved.value).pipe(Effect.option)
  if (Option.isNone(bytes)) return new Response("not found", { status: 404 })
  return new Response(Uint8Array.from(bytes.value), { status: 200, headers: fileHeaders(path.extname(resolved.value)) })
})

/** Answers any request on the app's origin. */
export const handle =
  (root: string) =>
  (request: Request): Effect.Effect<Response, never, Engine | ApiFetch | FileSystem.FileSystem | Path.Path> =>
    Route.$match(route(request.url), {
      Api: (found) => forward(request, found.path),
      File: (found) =>
        request.method === "GET" || request.method === "HEAD"
          ? serveFile(root, found.file)
          : Effect.succeed(new Response("method not allowed", { status: 405 })),
      NotFound: () => Effect.succeed(new Response("not found", { status: 404 })),
    })
