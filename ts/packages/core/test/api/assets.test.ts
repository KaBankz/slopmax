// The web dashboard's files: served at /slopmax/ with no key, compressed as
// the browser accepts, cached by their names, and under a strict policy.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect } from "effect"
import { gzipSync } from "node:zlib"
import {
  cacheControlOf,
  contentSecurityPolicy,
  contentTypeOf,
  isHashed,
  matchesEtag,
  pickEncoding,
} from "../../src/api/assets.ts"
import { apiStack, call } from "./stack.ts"

const page = "<!doctype html><title>slopmax</title><script src=./app-3f9a1c2b.js></script>"
const script = "console.log('slopmax')"

const dashboard = {
  "index.html": {
    plain: new Blob([page]),
    br: new Blob(["brotli copy of the page"]),
    gzip: new Blob([gzipSync(page)]),
  },
  // Only compressed copies: the plain bytes are unzipped once when asked for.
  "app-3f9a1c2b.js": { gzip: new Blob([gzipSync(script)]) },
  "OFL.txt": { plain: new Blob(["SIL Open Font License"]) },
}

describe("dashboard files", () => {
  it("are typed and cached by their names: a content hash means for good, anything else is checked each load", () => {
    expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8")
    expect(contentTypeOf("app-3f9a1c2b.js")).toBe("text/javascript; charset=utf-8")
    expect(contentTypeOf("ibm-plex-sans-400-1x2y3z4w.woff2")).toBe("font/woff2")
    expect(contentTypeOf("blob.bin")).toBe("application/octet-stream")
    expect(isHashed("app-3f9a1c2b.js")).toBe(true)
    expect(isHashed("index.html")).toBe(false)
    expect(isHashed("ibm-plex-sans-semibold.woff2")).toBe(false)
    expect(cacheControlOf("main.js", { immutable: true })).toBe("public, max-age=31536000, immutable")
    expect(cacheControlOf("app-3f9a1c2b.js", { immutable: false })).toBe("no-cache")
    expect(cacheControlOf("app-3f9a1c2b.js")).toBe("public, max-age=31536000, immutable")
    expect(cacheControlOf("index.html")).toBe("no-cache")
  })

  it("go brotli first, then gzip, then as they are, as the browser accepts and the file has", () => {
    const both = { br: true, gzip: true }
    expect(pickEncoding("gzip, deflate, br, zstd", both)).toBe("br")
    expect(pickEncoding("gzip, br;q=0", both)).toBe("gzip")
    expect(pickEncoding("br", { br: false, gzip: true })).toBe("identity")
    expect(pickEncoding(undefined, both)).toBe("identity")
    expect(pickEncoding("*", both)).toBe("br")
    expect(matchesEtag('"a", "b"', '"b"')).toBe(true)
    expect(matchesEtag('W/"b"', '"b"')).toBe(true)
    expect(matchesEtag('"c"', '"b"')).toBe(false)
    expect(matchesEtag(undefined, '"b"')).toBe(false)
  })

  it.effect("are served at /slopmax/ without a key, under a strict content security policy", () => {
    const { layer } = apiStack({ assets: dashboard })
    return Effect.gen(function* () {
      const index = yield* call("GET", "/slopmax/", { key: null })
      expect(index.status).toBe(200)
      expect(index.text).toBe(page)
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(index.headers.get("content-security-policy")).toBe(contentSecurityPolicy)
      expect(index.headers.get("referrer-policy")).toBe("no-referrer")
      expect(index.headers.get("x-content-type-options")).toBe("nosniff")
      expect(index.headers.get("cache-control")).toBe("no-cache")
      // Without its slash, relative addresses would not resolve.
      const bare = yield* call("GET", "/slopmax", { key: null })
      expect([bare.status, bare.headers.get("location")]).toEqual([308, "/slopmax/"])
      const missing = yield* call("GET", "/slopmax/nope.js", { key: null })
      expect([missing.status, missing.body]).toEqual([
        404,
        { _tag: "NotFound", what: "slopmax endpoint", message: "no such slopmax endpoint" },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("are sent compressed as the browser accepts, and a reload with a matching ETag costs a 304", () => {
    const { layer } = apiStack({ assets: dashboard })
    return Effect.gen(function* () {
      const brotli = yield* call("GET", "/slopmax/", { key: null, headers: { "accept-encoding": "gzip, br" } })
      expect(brotli.headers.get("content-encoding")).toBe("br")
      expect(brotli.headers.get("vary")).toBe("accept-encoding")
      const served = yield* call("GET", "/slopmax/app-3f9a1c2b.js", { key: null })
      expect(served.text).toBe("console.log('slopmax')")
      expect(served.headers.get("content-encoding")).toBeNull()
      expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      const etag = served.headers.get("etag") ?? ""
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
      const again = yield* call("GET", "/slopmax/app-3f9a1c2b.js", { key: null, headers: { "if-none-match": etag } })
      expect([again.status, again.text]).toEqual([304, ""])
      const license = yield* call("GET", "/slopmax/OFL.txt", { key: null, headers: { "accept-encoding": "br" } })
      expect([license.text, license.headers.get("content-encoding")]).toEqual(["SIL Open Font License", null])
    }).pipe(Effect.provide(layer))
  })

  it.effect("answer 404 when this slopmax was built without the dashboard", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      expect((yield* call("GET", "/slopmax/", { key: null })).status).toBe(404)
    }).pipe(Effect.provide(layer))
  })
})
