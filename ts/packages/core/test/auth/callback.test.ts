import { describe, expect, it as plain } from "bun:test"
import { createServer, type Server } from "node:net"

import { it } from "@slopmax/test"
import { Cause, Effect, Fiber, Queue, Result } from "effect"
import { TestClock } from "effect/testing"

import { Client } from "@slopmax/net"

import { type Callback, hasBrowser, parsePasted, receive } from "../../src/auth/callback.ts"
import { type LoginEvent, Prompt } from "../../src/auth/mod.ts"
import { noEnv } from "../../src/testkit.ts"

const ok = (input: string): Callback => {
  const result = parsePasted(input)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

const err = (input: string): string => {
  const result = parsePasted(input)
  if (Result.isSuccess(result)) throw new Error(`${input} parsed`)
  return result.failure.message
}

/** A port another server holds, released with the scope. */
const held = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer()
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 })
        })
      }),
  ),
  ({ server }) => Effect.sync(() => server.close()),
)

/** A port free a moment ago. */
const freePort = Effect.scoped(Effect.map(held, ({ port }) => port))

const recording = (): { prompt: Prompt; events: Array<LoginEvent> } => {
  const events: Array<LoginEvent> = []
  return { prompt: Prompt.make((e) => events.push(e)), events }
}

const notices = (events: ReadonlyArray<LoginEvent>): Array<string> =>
  events.flatMap((e) => (e._tag === "Notice" ? [e.text] : []))

/** GETs `url`, retrying while the callback server starts. */
const get = (url: string) =>
  Effect.gen(function* () {
    const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
    for (let i = 0; i < 100; i++) {
      const sent = yield* Effect.result(http.get(url).send())
      if (sent._tag === "Success") return [sent.success.status, yield* sent.success.text()] as const
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(`${url} never answered`)
  })

describe("callback", () => {
  plain("parses_full_redirect_url", () => {
    const cb = ok("http://localhost:1455/auth/callback?code=abc&state=xyz")
    expect(cb).toEqual({ code: "abc", state: "xyz" })
  })

  plain("parses_code_hash_state", () => {
    expect(ok("  abc#xyz \n")).toEqual({ code: "abc", state: "xyz" })
  })

  plain("parses_bare_query_and_decodes", () => {
    expect(ok("code=a%2Bb&state=s").code).toBe("a+b")
  })

  plain("surfaces_provider_errors", () => {
    expect(err("http://x/cb?error=access_denied&error_description=nope")).toContain("access_denied")
    expect(err("http://x/cb?error=access_denied&error_description=nope")).toBe(
      "authorization failed: access_denied nope",
    )
  })

  plain("empty_codes_and_fragments_are_handled", () => {
    expect(err("http://x/cb?code=&state=s")).toBe("no code")
    expect(ok("http://x/cb?code=a&state=s#fragment")).toEqual({ code: "a", state: "s" })
    // A `#` inside the code stays when the state comes separately.
    expect(ok("code=a%23b&state=s&other=1")).toEqual({ code: "a#b", state: "s" })
    expect(ok("bare-code")).toEqual({ code: "bare-code", state: undefined })
  })

  it.live("desktops_have_a_browser", () =>
    Effect.gen(function* () {
      if (process.platform === "darwin") expect(yield* hasBrowser).toBe(true)
      // Elsewhere a desktop session is what says so.
      const none = yield* hasBrowser.pipe(Effect.provide(noEnv))
      if (process.platform === "linux") expect(none).toBe(false)
    }),
  )

  it.live("the_redirect_delivers_the_code_and_a_page", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const { prompt, events } = recording()
      const waiting = yield* Effect.forkChild(receive(port, "/cb", "st", prompt))
      const base = `http://127.0.0.1:${port}`

      const [elsewhere] = yield* get(`${base}/elsewhere`)
      expect(elsewhere).toBe(404)
      const [status, failed] = yield* get(`${base}/cb?error=access_denied`)
      expect(status).toBe(200)
      expect(failed).toContain("Authorization failed")
      const [, page] = yield* get(`${base}/cb?code=abc&state=st`)
      expect(page).toContain("Account connected")

      const callback = yield* Fiber.join(waiting)
      expect(callback).toEqual({ code: "abc", state: "st" })
      const told = notices(events)
      expect(told.length).toBe(1)
      expect(told[0]).toContain("access_denied")
      expect(told[0]?.endsWith("; try again")).toBe(true)
    }),
  )

  it.live("busy_ports_fall_back_to_pasted_addresses", () =>
    Effect.gen(function* () {
      const { port } = yield* held
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      const recorded = recording()
      const prompt = recorded.prompt.withPasted(lines)
      for (const line of ["   ", "http://localhost/cb?state=st", "http://localhost/cb?code=pasted"]) {
        Queue.offerUnsafe(lines, line)
      }
      const callback = yield* receive(port, "/cb", "st", prompt)
      // No state came back with the paste, which is accepted.
      expect(callback).toEqual({ code: "pasted", state: undefined })
      const told = notices(recorded.events)
      expect(told[0]?.startsWith(`port ${port} is busy`)).toBe(true)
      expect(told[0]).toBe(
        `port ${port} is busy (Address already in use (os error 98)); paste the redirect address instead`,
      )
      expect(told[1]).toBe("no code; try again")
      expect(told.length).toBe(2)
    }),
  )

  it.live("a_foreign_state_is_refused", () =>
    Effect.gen(function* () {
      const { port } = yield* held
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      const prompt = Prompt.make(() => {}).withPasted(lines)
      Queue.offerUnsafe(lines, "code=abc&state=evil")
      const error = yield* Effect.flip(receive(port, "/cb", "st", prompt))
      expect(error.message).toBe("OAuth state mismatch; start over")
    }),
  )

  it.live("nothing_to_wait_for_is_an_error", () =>
    Effect.gen(function* () {
      const { port } = yield* held
      const { prompt } = recording()
      const error = yield* Effect.flip(receive(port, "/cb", "st", prompt))
      expect(error.message).toBe(`port ${port} is busy and no redirect address can be pasted`)
    }),
  )
})

describe("callback, beyond the Rust tests", () => {
  it.live("pastes that run out, with no redirect to wait for, end the wait", () =>
    Effect.gen(function* () {
      const { port } = yield* held
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      const prompt = Prompt.make(() => {}).withPasted(lines)
      yield* Queue.end(lines)
      const error = yield* Effect.flip(receive(port, "/cb", "st", prompt))
      expect(error.message).toBe(`port ${port} is busy and no redirect address can be pasted`)
    }),
  )

  it.effect("a sign-in nobody finishes times out after ten minutes", () =>
    Effect.gen(function* () {
      const { port } = yield* held
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      const waiting = yield* Effect.forkChild(receive(port, "/cb", "st", Prompt.make(() => {}).withPasted(lines)))
      yield* TestClock.adjust("599 seconds")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const error = yield* Effect.flip(Fiber.join(waiting))
      expect(error.message).toBe("timed out waiting for authorization")
    }),
  )
})
