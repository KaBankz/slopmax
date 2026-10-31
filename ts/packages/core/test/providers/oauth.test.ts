import { describe, expect } from "bun:test"
import { LoginEvent } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Effect, Exit, Fiber, Layer, Option, Result, Schema } from "effect"
import { Digest } from "effect/crypto"
import { TestClock } from "effect/testing"
import {
  browserLogin,
  challengeOf,
  jwtClaims,
  jwtExpiry,
  makePkce,
  parsePasted,
  receive,
} from "../../src/providers/oauth.ts"
import { withCrypto } from "../../src/providers/provider.ts"
import { jwt, loginUi, noSpawner } from "./support.ts"

const readEmail = jwtClaims(Schema.Struct({ email: Schema.String }))

/** A port on 127.0.0.1 taken by another server until the scope closes. */
const heldPort = Effect.acquireRelease(
  Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") })),
  (server) => Effect.promise(() => server.stop(true)),
).pipe(Effect.map((server) => server.port ?? 0))

/** A port that was free a moment ago. */
const freePort = Effect.scoped(heldPort)

const notes = (events: ReadonlyArray<LoginEvent>) =>
  events.flatMap((event) => (event._tag === "Note" ? [event.text] : []))

/** GETs a URL, retrying while the callback server starts. */
const get = (url: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url)
    return { status: response.status, page: await response.text(), type: response.headers.get("content-type") }
  }).pipe(Effect.retry({ times: 50 }))

describe("PKCE and tokens", () => {
  it.effect("compute the challenge of RFC 7636's example", () =>
    Effect.gen(function* () {
      expect(yield* challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      )
    }).pipe(Effect.provide(Digest.layerWebCrypto)),
  )

  it.effect("make verifiers that are URL-safe, 43 characters, and never the same twice", () =>
    Effect.gen(function* () {
      const a = yield* withCrypto(makePkce)
      const b = yield* withCrypto(makePkce)
      expect(a.verifier).not.toBe(b.verifier)
      expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(a.challenge).toBe(yield* withCrypto(challengeOf(a.verifier)))
    }),
  )

  it("read a token's claims and expiry without checking its signature", () => {
    const token = jwt({ email: "a@b.c", exp: 1_900_000_000 })
    expect(Option.map(readEmail(token), (claims) => claims.email)).toEqual(Option.some("a@b.c"))
    expect(jwtExpiry(token)).toEqual(Option.some(DateTime.makeUnsafe(1_900_000_000_000)))
    expect(jwtExpiry(jwt({ exp: "soon" }))).toEqual(Option.none())
  })

  it("read nothing from what is not a token", () => {
    expect(readEmail("not-a-jwt")).toEqual(Option.none())
    expect(readEmail("a.!!!.c")).toEqual(Option.none())
    expect(readEmail(`a.${btoa("[1]")}.c`)).toEqual(Option.none())
    expect(readEmail(jwt({ email: 7 }))).toEqual(Option.none())
  })
})

const pasted = (text: string) => Result.getOrThrowWith(parsePasted(text), (error) => new Error(error))

describe("pasted redirects", () => {
  it("read a whole redirect address", () => {
    expect(pasted("http://localhost:1455/auth/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" })
  })

  it("split the code and state a manual page shows as one", () => {
    expect(pasted("  abc#xyz \n")).toEqual({ code: "abc", state: "xyz" })
  })

  it("read a bare query and decode it", () => {
    expect(pasted("code=a%2Bb&state=s").code).toBe("a+b")
    expect(pasted("code=a+b").code).toBe("a b")
  })

  it("say what the provider refused", () => {
    expect(parsePasted("http://x/cb?error=access_denied&error_description=nope")).toEqual(
      Result.fail("authorization failed: access_denied nope"),
    )
  })

  it("refuse an empty code, drop a fragment, and keep a # inside a code whose state came apart", () => {
    expect(parsePasted("http://x/cb?code=&state=s")).toEqual(Result.fail("no code"))
    expect(pasted("http://x/cb?code=a&state=s#fragment")).toEqual({ code: "a", state: "s" })
    expect(pasted("code=a%23b&state=s&other=1")).toEqual({ code: "a#b", state: "s" })
    expect(pasted("bare-code")).toEqual({ code: "bare-code", state: undefined })
  })
})

describe("the callback server", () => {
  it.live("delivers the redirect's code, answering with a page, and tells failed attempts", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const ui = loginUi()
      const waiting = yield* receive(port, "/cb", "st").pipe(Effect.provide(ui.layer), Effect.forkScoped)
      const base = `http://127.0.0.1:${port}`
      expect((yield* get(`${base}/elsewhere`)).status).toBe(404)
      const refused = yield* get(`${base}/cb?error=access_denied`)
      expect(refused.status).toBe(200)
      expect(refused.page).toContain("Authorization failed")
      expect(refused.type).toBe("text/html; charset=utf-8")
      const connected = yield* get(`${base}/cb?code=abc&state=st`)
      expect(connected.page).toContain("Account connected")
      expect(yield* Fiber.join(waiting)).toEqual({ code: "abc", state: "st" })
      const told = notes(ui.events)
      expect(told).toHaveLength(1)
      expect(told[0]).toContain("access_denied")
      expect(told[0]?.endsWith("; try again")).toBe(true)
      // The server stops once the code is in.
      const after = yield* Effect.tryPromise(() => fetch(`${base}/cb?code=late`)).pipe(Effect.exit)
      expect(Exit.isFailure(after)).toBe(true)
    }),
  )

  it.live("falls back to pasted addresses when the port is busy, skipping blank lines", () =>
    Effect.gen(function* () {
      const port = yield* heldPort
      const ui = loginUi({ pasted: ["   ", "http://localhost/cb?state=st", "http://localhost/cb?code=pasted"] })
      const callback = yield* receive(port, "/cb", "st").pipe(Effect.provide(ui.layer))
      // No state came back with the paste, which is accepted.
      expect(callback).toEqual({ code: "pasted", state: undefined })
      const told = notes(ui.events)
      expect(told[0]?.startsWith(`port ${port} is busy`)).toBe(true)
      expect(told[0]?.endsWith("paste the redirect address instead")).toBe(true)
      expect(told[1]).toBe("no code; try again")
      expect(told).toHaveLength(2)
    }),
  )

  it.live("refuses a redirect for a sign-in someone else started", () =>
    Effect.gen(function* () {
      const port = yield* heldPort
      const ui = loginUi({ pasted: ["code=abc&state=evil"] })
      const error = yield* receive(port, "/cb", "st").pipe(Effect.provide(ui.layer), Effect.flip)
      expect(error._tag).toBe("StateMismatch")
      expect(error.message).toBe("OAuth state mismatch; start over")
    }),
  )

  it.live("fails when the port is busy and nothing can be pasted", () =>
    Effect.gen(function* () {
      const port = yield* heldPort
      const ui = loginUi({ pasted: [] })
      const error = yield* receive(port, "/cb", "st").pipe(Effect.provide(ui.layer), Effect.flip)
      expect(error.message).toBe(`port ${port} is busy and no redirect address can be pasted`)
    }),
  )
})

describe("browser sign-in", () => {
  it.live("says where to authorize, and that no browser was opened when the caller opens none", () =>
    Effect.gen(function* () {
      const port = yield* heldPort
      const ui = loginUi({ pasted: ["code=c&state=s"] })
      const callback = yield* browserLogin({
        title: "Claude",
        url: "https://x/authorize",
        port,
        path: "/cb",
        state: "s",
      }).pipe(Effect.provide(Layer.merge(ui.layer, noSpawner)))
      expect(callback).toEqual({ code: "c", state: "s" })
      expect(ui.events[0]).toEqual(
        LoginEvent.cases.Authorize.make({ title: "Claude", url: "https://x/authorize", port, opened: false }),
      )
    }),
  )

  it.effect("gives up after ten minutes without an answer", () =>
    Effect.gen(function* () {
      const port = yield* heldPort
      const ui = loginUi()
      const waiting = yield* browserLogin({ title: "ChatGPT", url: "https://x", port, path: "/cb", state: "s" }).pipe(
        Effect.provide(Layer.merge(ui.layer, noSpawner)),
        Effect.flip,
        Effect.forkScoped,
      )
      yield* TestClock.adjust("9 minutes")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(waiting)
      expect(error.message).toBe("timed out waiting for authorization")
    }),
  )
})
