// The ground the scenarios stand on: the mock provider records what slopmax
// sends and ignores probes, origin rewriting sends every outbound call to it,
// and both harnesses run the real daemon.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Exit } from "effect"
import { Upstream } from "../../src/upstream.ts"
import { eventually, NotYet, until } from "../support/clients.ts"
import { subscriptions } from "../support/fixtures.ts"
import { Harness, transports } from "../support/harness.ts"
import { json, on } from "../support/memory-upstream.ts"
import { intended, mockProvider, providerOrigins } from "../support/mock-provider.ts"

describe("the mock provider", () => {
  it.live("records each call by the URL slopmax meant, with its headers and body, and answers from its scripts", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider({
        routes: [on("POST https://api.anthropic.com/v1/messages", (seen) => json(201, { echoed: seen.text }))],
      })
      const origins = mock.origins()
      const target = `${origins["https://api.anthropic.com"]}/v1/messages?beta=true`
      const answer = yield* Effect.promise(() =>
        fetch(target, { method: "POST", headers: { "x-api-key": "key-1" }, body: '{"model":"m"}' }),
      )
      expect(answer.status).toBe(201)
      expect(yield* Effect.promise(() => answer.json())).toEqual({ echoed: '{"model":"m"}' })
      const [seen] = mock.upstream.seen
      expect(seen?.url.href).toBe("https://api.anthropic.com/v1/messages?beta=true")
      expect(seen?.path).toBe("/v1/messages?beta=true")
      expect(seen?.token).toBe("key-1")
      expect(seen?.headers.get("host")).toBeNull()
      // The route is the path alone; a path no script takes is a 404, still recorded.
      expect(mock.upstream.at("/v1/messages")).toHaveLength(1)
      const missing = yield* Effect.promise(() => fetch(`${mock.url}/nowhere`))
      expect(missing.status).toBe(404)
      expect(mock.upstream.paths()).toEqual(["/v1/messages", "/nowhere"])
    }),
  )

  it.live("answers probes of / with 404 and leaves them out of what it saw", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider({ routes: [] })
      const probe = yield* Effect.promise(() => fetch(`${mock.url}/`))
      expect(probe.status).toBe(404)
      expect(mock.probes()).toBe(1)
      expect(mock.upstream.seen).toHaveLength(0)
    }),
  )

  it("rebuilds the provider URL from a rewritten one, and leaves its own URLs alone", () => {
    expect(intended(new URL("http://127.0.0.1:1/_/https/chatgpt.com/backend-api/codex/responses?x=1"))).toBe(
      "https://chatgpt.com/backend-api/codex/responses?x=1",
    )
    expect(intended(new URL("http://127.0.0.1:1/_/https/api.x.ai"))).toBe("https://api.x.ai")
    expect(intended(new URL("http://127.0.0.1:1/v1/models"))).toBe("http://127.0.0.1:1/v1/models")
  })

  it.live("sends every provider origin to itself, through slopmax's own outbound client", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider({ routes: [on("GET /ping", () => json(200, { pong: true }))] })
      const answered = yield* Effect.gen(function* () {
        const upstream = yield* Upstream
        const out: Array<number> = []
        for (const origin of providerOrigins) {
          const response = yield* upstream.send({
            url: `${origin}/ping`,
            method: "GET",
            headers: new Headers(),
            body: undefined,
          })
          out.push(response.status)
        }
        return out
      }).pipe(Effect.provide(Harness.upstreamTo(mock)))
      expect(answered).toEqual(providerOrigins.map(() => 200))
      expect(mock.upstream.seen.map((seen) => seen.url.origin)).toEqual([...providerOrigins])
    }),
  )

  it.live("refuses a call to a host nobody rewrote, so it never reaches the network", () =>
    Effect.gen(function* () {
      const mock = yield* mockProvider({ routes: [] })
      const outcome = yield* Effect.gen(function* () {
        const upstream = yield* Upstream
        const tunnelled = yield* Effect.exit(
          upstream.send({ url: "https://example.com/v1/x", method: "GET", headers: new Headers(), body: undefined }),
        )
        const plain = yield* upstream.send({
          url: "http://example.com/v1/y",
          method: "GET",
          headers: new Headers(),
          body: undefined,
        })
        return { tunnelled, plain: plain.status }
      }).pipe(Effect.provide(Harness.upstreamTo(mock)))
      expect(Exit.isFailure(outcome.tunnelled)).toBe(true)
      expect(outcome.plain).toBe(403)
      expect(mock.leaks).toEqual(["CONNECT example.com:443", "GET http://example.com/v1/y"])
      expect(mock.upstream.seen).toHaveLength(0)
    }),
  )
})

for (const [where, make] of transports) {
  describe(`the daemon ${where}`, () => {
    it.live("serves Claude Code with the account's credential, and records the request", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("claude", ["tok-ok"]) })
        const answer = yield* harness.claude()
        expect(answer.status).toBe(200)
        expect(answer.text).toContain("message_stop")
        const [seen] = harness.upstream.seen
        expect(seen?.url.href).toBe("https://api.anthropic.com/v1/messages?beta=true")
        expect(seen?.token).toBe("tok-ok")
        const records = yield* eventually(
          Effect.flatMap(harness.ledger, (all) => Effect.as(until(all.length === 1, "one record"), all)),
        )
        expect(records[0]).toMatchObject({ _tag: "Request", account: "claude-0", status: 200, agent: "claude-code" })
      }),
    )

    it.live("answers slopmax's own API to the owner key", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
        const api = yield* harness.api
        const report = yield* api.system.status()
        expect(report.accounts.map((account) => String(account.id))).toEqual(["codex-0"])
        const refused = yield* harness.call("GET", "/slopmax/api/status", { key: "wrong" })
        expect(refused.status).toBe(401)
        const proxied = yield* harness.codex()
        expect(proxied.status).toBe(200)
        yield* harness.settled
        const after = yield* api.system.status()
        expect(after.accounts[0]?.served.requests).toBe(1)
      }),
    )
  })
}

describe("waiting for what happens after an answer", () => {
  it.live("tries a check again until it holds, and gives up after a second", () =>
    Effect.gen(function* () {
      let tries = 0
      yield* eventually(Effect.suspend(() => until(++tries >= 5, "five tries")))
      expect(tries).toBe(5)
      const failed = yield* Effect.flip(eventually(until(false, "never")))
      expect(failed).toBeInstanceOf(NotYet)
    }),
  )
})
