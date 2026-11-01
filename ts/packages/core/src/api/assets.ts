// The web dashboard's files, served at `/slopmax/` with no key: the page
// asks for the key itself and keeps it in the tab. The files are built into
// the CLI binary (its build writes the layer that lists them); a slopmax
// built without them answers the dashboard's paths with 404.
//
// Each file is sent compressed as the browser accepts (brotli, else gzip),
// with an ETag so a reload costs a 304. Files whose names carry a content
// hash never change and are cached for a year; the rest, `index.html` among
// them, are checked on every load. Every answer carries a strict content
// security policy: the page runs only its own scripts, styles and fonts and
// talks only to its own origin.
import { NotFound } from "@slopmax/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { Digest } from "effect/crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/** What a path slopmax does not serve under `/slopmax/` hears, in the API's error shape. */
export const notFoundAnswer: HttpServerResponse.HttpServerResponse = HttpServerResponse.jsonUnsafe(
  Schema.encodeSync(NotFound)(NotFound.of({ what: "slopmax endpoint" })),
  { status: 404 },
)

/** One file of the dashboard: as it is, and compressed. */
export interface Asset {
  /** The bytes as they are; when absent, they are unzipped from the gzip copy once, on first use. */
  readonly plain?: Blob | undefined
  readonly br?: Blob | undefined
  readonly gzip?: Blob | undefined
  /**
   * Whether the name carries a content hash, so the file never changes under
   * it; the build that hashed it says so. When absent, the name is read for one.
   */
  readonly immutable?: boolean | undefined
}

export interface AssetsShape {
  /** By name relative to the dashboard, such as `index.html` or `app-3f9a1c2b.js`. */
  readonly files: ReadonlyMap<string, Asset>
}

/** The dashboard's files. The CLI's build generates the layer; tests give their own. */
export class Assets extends Context.Service<Assets, AssetsShape>()("@slopmax/core/Assets") {
  /** No dashboard: its paths answer 404. */
  static readonly none: Layer.Layer<Assets> = Layer.succeed(Assets)({ files: new Map() })

  /** The dashboard from these files, by name. */
  static readonly layerFiles = (files: Readonly<Record<string, Asset>>): Layer.Layer<Assets> =>
    Layer.succeed(Assets)({ files: new Map(Object.entries(files)) })
}

/** Where the dashboard lives on the proxy's address. */
export const dashboardPrefix = "/slopmax"

export const contentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Headers every dashboard answer carries. */
export const pageHeaders: Readonly<Record<string, string>> = {
  "content-security-policy": contentSecurityPolicy,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

const types: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
}

/** A file's content type, by its extension. */
export const contentTypeOf = (name: string): string =>
  types[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"

/**
 * Whether a file's name looks like it carries a content hash
 * (`app-3f9a1c2b.js`): eight or more letters and digits, at least one a digit,
 * after the last dash. Words such as `-semibold` are not hashes; a hash that
 * happens to hold no digit is only checked on each load, which costs a 304.
 */
export const isHashed = (name: string): boolean => /-(?=[a-z]*[0-9])[a-z0-9]{8,}\.[a-z0-9]+$/i.test(name)

/** The cache policy for a file: for good when it never changes under its name, else checked on every load. */
export const cacheControlOf = (name: string, asset: Asset = {}): string =>
  (asset.immutable ?? isHashed(name)) ? "public, max-age=31536000, immutable" : "no-cache"

export type Encoding = "br" | "gzip" | "identity"

/** The best encoding the browser accepts of those the file has: brotli, then gzip, then as it is. */
export const pickEncoding = (accept: string | undefined, has: { readonly br: boolean; readonly gzip: boolean }) => {
  const accepted = new Map<string, number>()
  for (const part of (accept ?? "").split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";")
    if (name === "") continue
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="))
    accepted.set(name, q === undefined ? 1 : Number(q.slice(2)) || 0)
  }
  const ok = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0
  if (has.br && ok("br")) return "br" as const
  if (has.gzip && ok("gzip")) return "gzip" as const
  return "identity" as const
}

/** Whether `If-None-Match` names `etag`. */
export const matchesEtag = (ifNoneMatch: string | undefined, etag: string): boolean =>
  ifNoneMatch !== undefined &&
  ifNoneMatch.split(",").some((tag) => {
    const trimmed = tag.trim()
    return trimmed === "*" || trimmed === etag || trimmed === `W/${etag}`
  })

const gunzip = (blob: Blob): Effect.Effect<Blob> =>
  Effect.promise(() => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob())

/** What a file is served from: its copies, and its ETag, worked out once. */
interface Served {
  readonly asset: Asset
  readonly type: string
  readonly cacheControl: string
  /** The plain bytes and the ETag, read on first use. */
  readonly prepared: Effect.Effect<{ readonly plain: Blob; readonly etag: string }>
}

/** Routes for the dashboard: `/slopmax/` is `index.html`, and `/slopmax` sends the browser there. */
export const dashboardRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter | Assets> = Layer.unwrap(
  Effect.gen(function* () {
    const { files } = yield* Assets
    const digest = yield* Effect.provide(Effect.service(Digest.Digest), Digest.layerWebCrypto)
    const served = new Map<string, Served>()
    for (const [name, asset] of files) {
      const plain =
        asset.plain !== undefined
          ? Effect.succeed(asset.plain)
          : asset.gzip !== undefined
            ? gunzip(asset.gzip)
            : Effect.succeed(new Blob([]))
      const prepared = yield* Effect.cached(
        Effect.gen(function* () {
          const bytes = yield* plain
          const hash = yield* digest.digestHex(
            Digest.sha256,
            new Uint8Array(yield* Effect.promise(() => bytes.arrayBuffer())),
          )
          return { plain: bytes, etag: `"${hash.slice(0, 32)}"` }
        }),
      )
      served.set(name, { asset, type: contentTypeOf(name), cacheControl: cacheControlOf(name, asset), prepared })
    }

    const serve = (
      name: string,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> =>
      Effect.gen(function* () {
        const file = served.get(name)
        if (file === undefined) return notFoundAnswer
        const request = yield* HttpServerRequest.HttpServerRequest
        const { plain, etag } = yield* file.prepared
        const common = { ...pageHeaders, "cache-control": file.cacheControl, etag, vary: "accept-encoding" }
        if (matchesEtag(request.headers["if-none-match"], etag)) {
          return HttpServerResponse.empty({ status: 304, headers: common })
        }
        const encoding = pickEncoding(request.headers["accept-encoding"], {
          br: file.asset.br !== undefined,
          gzip: file.asset.gzip !== undefined,
        })
        const body = encoding === "br" ? file.asset.br : encoding === "gzip" ? file.asset.gzip : plain
        return HttpServerResponse.raw(body ?? plain, {
          contentType: file.type,
          headers: encoding === "identity" ? common : { ...common, "content-encoding": encoding },
        })
      })

    const index = files.has("index.html") ? serve("index.html") : Effect.succeed(notFoundAnswer)
    // `/slopmax/*` also takes `/slopmax` itself, where the page's relative
    // addresses would not resolve, so that one is sent on to `/slopmax/`.
    return HttpRouter.add(
      "GET",
      `${dashboardPrefix}/*`,
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const path = new URL(request.url, "http://slopmax").pathname
        if (!path.startsWith(`${dashboardPrefix}/`)) {
          return Effect.succeed(HttpServerResponse.redirect(`${dashboardPrefix}/`, { status: 308 }))
        }
        const name = decodeURIComponent(path.slice(dashboardPrefix.length + 1))
        return name === "" ? index : serve(name)
      }),
    )
  }),
)
