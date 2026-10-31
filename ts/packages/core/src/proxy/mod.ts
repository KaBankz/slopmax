// The local HTTP proxy that agents talk to.
//
// Claude Code reaches it through `ANTHROPIC_BASE_URL` and Codex through a
// custom model provider. Each request is authenticated with the slopmax
// key, assigned an account by the `Pool`, and forwarded upstream with that
// account's credentials.
//
// The state and helpers the handlers share are in `app.ts`; the handlers
// import that, never this module.
import { Effect, type Scope } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/http"

import { clientAgent } from "../provider/claude/wire.ts"
import { clientVersion } from "../provider/codex/wire.ts"
import * as admin from "./admin.ts"
import {
  type App,
  caller,
  emptyReply,
  error,
  headersOf,
  isWebsocket,
  jsonReply,
  route,
  splitUrl,
  unauthorized,
} from "./app.ts"
import * as forward from "./forward.ts"
import * as hub from "./hub.ts"
import * as models from "./models.ts"
import * as socket from "./socket.ts"
import { VERSION } from "../version.ts"

export * from "./app.ts"

/** Answers one request: slopmax's own endpoints, else the proxy. */
export const handle = (
  app: App,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope> =>
  Effect.suspend(() => {
    const [path, query] = splitUrl(request.url)
    const method = request.method
    if (method === "GET" && path === "/healthz") {
      return Effect.succeed(jsonReply(200, { status: "ok", service: "slopmax", version: VERSION }))
    }
    // Claude Code's unauthenticated connectivity check; HEAD probes alike.
    if (path === "/api/hello" || method === "HEAD") return Effect.succeed(emptyReply(200))
    if (path.startsWith("/slopmax/")) return admin.handle(app, request)
    if (path.startsWith("/v0/management/")) return hub.handle(app, request)
    const headers = headersOf(request)
    if (method === "GET" && path === "/v1/models" && models.wantsList(headers, query)) {
      return Effect.flatMap(app.config, (config) => {
        const who = caller(config, headers)
        if (who === undefined) return Effect.succeed(unauthorized("chat"))
        return models.list(app, who._tag === "Client" ? who.key : undefined)
      })
    }
    return proxy(app, request, headers)
  })

/** {@link handle} as an `effect/http` app, for `@slopmax/net`'s server. */
export const httpApp = (
  app: App,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope> =>
  Effect.gen(function* () {
    return yield* handle(app, yield* HttpServerRequest.HttpServerRequest)
  })

const proxy = Effect.fn("proxy.proxy")(function* (
  app: App,
  request: HttpServerRequest.HttpServerRequest,
  headers: Headers,
): Effect.fn.Return<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Scope.Scope> {
  const target = route(request.url, headers)
  if (target === undefined) {
    return error(undefined, 404, "unknown path; slopmax serves /v1/*, /claude/*, and /codex/*")
  }
  const who = caller(yield* app.config, headers)
  if (who === undefined) return unauthorized(target.dialect)
  const client = who._tag === "Client" ? who.key : undefined
  const version = clientVersion(headers)
  if (version !== undefined) app.codexVersion = version
  const agent = clientAgent(headers)
  if (agent !== undefined) yield* app.pool.sawAgent("claude", agent)
  // Codex's sockets are relayed when they can be; refusing a handshake
  // with 426 makes Codex stream over HTTP at once instead of retrying.
  if (isWebsocket(headers)) return yield* socket.accept(app, target, headers, client)
  return yield* forward.forward(app, target, request, headers, client)
})
