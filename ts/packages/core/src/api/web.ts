// The web app on the proxy's port: slopmax's own API under `/slopmax/api`,
// the hub under `/v0/management`, and the dashboard at `/slopmax/`. It runs
// on the same services as the proxy, so the API reports the pool the proxy
// places requests with. Bodies are capped at 64 KiB: nothing here takes more.
//
// A path under the API or the hub that matches no endpoint is checked for
// the key first, as every other path there is, then answered 404 in that
// API's own shape.
import { Unauthorized } from "@slopmax/domain"
import { InputErrors, OwnerKey, ownerKeyMatches, SlopmaxApi } from "@slopmax/domain/api"
import { ByteSize, Context, Effect, Layer, Redacted, Schema, type Scope } from "effect"
import {
  Etag,
  HttpEffect,
  HttpIncomingMessage,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SettingsService } from "../settings.ts"
import { WebApp } from "../server.ts"
import { dashboardRoutes, notFoundAnswer } from "./assets.ts"
import { HubInput, HubUnauthorized, HubApi, hubPrefix, hubUnknownPath, ManagementKey } from "./hub-api.ts"
import { hubHandlers } from "./hub.ts"
import { apiHandlers } from "./handlers.ts"

/** The largest body the API and the hub read. */
export const maxApiBody = 64 * 1024

const eventsPath = "/slopmax/api/events"

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status })

const unauthorized = json(401, Schema.encodeSync(Unauthorized)(new Unauthorized()))
const hubUnauthorized = json(401, { error: HubUnauthorized.message })
const hubNotFound = json(404, { error: hubUnknownPath })

/** The keys a request carries, as the API and the hub accept them. */
const presented = (headers: Readonly<Record<string, string | undefined>>, management: boolean): Array<string> => {
  const keys: Array<string> = []
  const authorization = headers.authorization
  if (authorization !== undefined && /^bearer /i.test(authorization)) keys.push(authorization.slice(7))
  if (headers["x-api-key"] !== undefined) keys.push(headers["x-api-key"])
  if (management && headers["x-management-key"] !== undefined) keys.push(headers["x-management-key"].trim())
  return keys
}

/** Paths under the API and the hub that no endpoint serves, and requests other than GET to the dashboard. */
const fallbacks = (key: Effect.Effect<Redacted.Redacted<string>>) => {
  const answer = (management: boolean) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const current = yield* key
      const owner = presented(request.headers, management).some((given) =>
        ownerKeyMatches(Redacted.make(given), current),
      )
      if (management) return owner ? hubNotFound : hubUnauthorized
      return owner ? notFoundAnswer : unauthorized
    })
  return Layer.mergeAll(
    HttpRouter.add("*", "/slopmax/api/*", answer(false)),
    HttpRouter.add("*", `${hubPrefix}/*`, answer(true)),
    ...(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const).map((method) =>
      HttpRouter.add(method, "/slopmax/*", answer(false)),
    ),
  )
}

/** The event stream is never cached by anything between the dashboard and slopmax. */
const uncachedEvents = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.flatMap(app, (response) =>
    Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
      request.url === eventsPath || request.url.startsWith(`${eventsPath}?`)
        ? HttpServerResponse.setHeader(response, "cache-control", "no-cache")
        : response,
    ),
  )

/** Everything the web app's routes are built from, besides the services the handlers use. */
const routesOf = (key: Effect.Effect<Redacted.Redacted<string>>) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(SlopmaxApi).pipe(Layer.provide(apiHandlers)),
    HttpApiBuilder.layer(HubApi).pipe(Layer.provide(hubHandlers)),
    dashboardRoutes,
    fallbacks(key),
  ).pipe(
    Layer.provide([OwnerKey.layer(key), InputErrors.layer, ManagementKey.layer(key), HubInput.layer]),
    Layer.provide(Layer.merge(HttpPlatform.layer, Etag.layer)),
  )

/** The web app, built once over the services in context, for the life of the scope. */
export const webAppLayer = Layer.effect(
  WebApp,
  Effect.gen(function* () {
    const settings = yield* SettingsService
    const key = Effect.map(settings.get, (current) => current.apiKey)
    const app = yield* HttpRouter.toHttpEffect(routesOf(key))
    const context = Context.add(
      yield* Effect.context<never>(),
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(maxApiBody),
    )
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(context)(
      uncachedEvents(app),
    )
    return { handle: (request: Request) => handler(request) }
  }),
)
