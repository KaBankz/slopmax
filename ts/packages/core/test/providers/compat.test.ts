import { describe, expect } from "bun:test"
import { type Dialect } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Layer, Redacted } from "effect"
import { Account, Credential } from "../../src/account.ts"
import { compat, modelsUrl } from "../../src/providers/compat.ts"
import { identified, Verdict } from "../../src/providers/provider.ts"
import { at, downUpstream, json, keyAccount, mockUpstream, reply, signInServices } from "./support.ts"

const endpoint = (models: ReadonlyArray<string>, options: { readonly dialect?: Dialect; readonly key?: string } = {}) =>
  new Account({
    ...keyAccount("compat", ""),
    credential: Credential.cases.Endpoint.make({
      baseUrl: "http://localhost:11434/v1",
      dialect: options.dialect ?? "chat",
      models: [...models],
      ...(options.key === undefined ? {} : { key: Redacted.make(options.key) }),
    }),
  })

const input = (account: Account) => ({ client: new Headers(), account, moved: false, agents: {}, codex: {} })

/** An endpoint listing two models for the key `good` (in its dialect's header), failing for `flaky`, refusing the rest. */
const server = () =>
  mockUpstream((seen) => {
    const list = { data: [{ id: "local-1" }, { id: "local-2" }] }
    const bearer = seen.headers.get("authorization")
    const xKey = seen.headers.get("x-api-key")
    if (seen.url.pathname === "/v1/models" && bearer === "Bearer good") return json(200, list)
    if (seen.url.pathname === "/anthropic/v1/models" && bearer === null && xKey === "good") return json(200, list)
    if (bearer === "Bearer flaky" || xKey === "flaky") return reply(500)
    return reply(401)
  })

const options = (baseUrl: string, dialect: Dialect, models: ReadonlyArray<string>, key: string) => ({
  endpoint: { baseUrl, dialect, models },
  key: Redacted.make(key),
})

describe("compatible endpoints", () => {
  it.effect("take their address, format and models from the account", () =>
    Effect.gen(function* () {
      const local = yield* identified(endpoint(["qwen3-*", "llama4"]))
      expect(compat.serves(local, "qwen3-coder")).toBe(true)
      expect(compat.serves(local, "gpt-6-sol")).toBe(false)
      expect(compat.apiOf(local)).toBe("http://localhost:11434/v1")
      expect(compat.dialectsOf(local)).toEqual(["chat"])
      expect(local.name).toBe("localhost:11434")
      expect(modelsUrl({ baseUrl: "http://localhost:11434/v1", dialect: "chat" })).toBe(
        "http://localhost:11434/v1/models",
      )
      // The same server under two keys is two accounts.
      const other = yield* identified(endpoint(["qwen3-*"], { key: "key" }))
      expect(other.id).not.toBe(local.id)
    }),
  )

  it.effect("list the endpoint's models at sign-in when none are named", () => {
    const api = server()
    return Effect.gen(function* () {
      const base = "http://gpu.test/v1/"
      const account = yield* compat.login(options(base, "chat", [], "good"))
      expect(account.credential).toMatchObject({ _tag: "Endpoint", models: ["local-1", "local-2"] })
      expect(account.secret).toBe("good")
      expect(account.id).toMatch(/^compat-[0-9a-f]{8}$/)
      expect(compat.identity(account)).toBe(`${base} good`)
      expect(api.seen[0]?.url.href).toBe("http://gpu.test/v1/models")
      // Anthropic-style endpoints list under /v1 with x-api-key.
      const messages = yield* compat.login(options("http://gpu.test/anthropic", "messages", [], "good"))
      expect(messages.credential).toMatchObject({ models: ["local-1", "local-2"], dialect: "messages" })
    }).pipe(Effect.provide(api.layer.pipe(Layer.provideMerge(signInServices))))
  })

  it.effect("keep named models when the endpoint cannot list, and need some", () => {
    const api = server()
    return Effect.gen(function* () {
      const base = "http://gpu.test/v1"
      const named = yield* compat.login(options(base, "responses", ["m-*", "m-1"], "flaky"))
      expect(named.credential).toMatchObject({ models: ["m-*", "m-1"] })
      const none = yield* Effect.flip(compat.login(options(base, "chat", [], "flaky")))
      expect(none.message).toBe(`could not list the models at ${base}; name them with --models`)
      const wrong = yield* Effect.flip(compat.login(options(base, "chat", [], "wrong")))
      expect(wrong.message).toContain("rejected the key")
    }).pipe(Effect.provide(api.layer.pipe(Layer.provideMerge(signInServices))))
  })

  it.effect("need an address to sign in", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(compat.login({}))
      expect(error.message).toBe("a compatible endpoint needs its address: --url <base url>")
    }).pipe(Effect.provide(downUpstream.pipe(Layer.provideMerge(signInServices)))),
  )

  it.effect("list named models but not patterns", () =>
    Effect.gen(function* () {
      expect(yield* compat.catalog(endpoint(["qwen3-*", "llama4", "phi"]), {})).toEqual(["llama4", "phi"])
    }).pipe(Effect.provide(downUpstream)),
  )

  it("serve nothing without an endpoint, sending a key as a bearer token", () => {
    const bare = keyAccount("compat", "k")
    expect(compat.identity(bare)).toBeUndefined()
    expect(compat.apiOf(bare)).toBe("")
    expect(compat.dialectsOf(bare)).toEqual([])
    expect(compat.serves(bare, "anything")).toBe(false)
    expect(compat.headers(input(bare)).get("authorization")).toBe("Bearer k")
  })

  it("put the key in the header the endpoint's format expects", () => {
    const messages = endpoint(["glm-*"], { dialect: "messages", key: "k" })
    const sent = compat.headers(input(messages))
    expect(sent.get("x-api-key")).toBe("k")
    expect(sent.has("authorization")).toBe(false)
    expect(modelsUrl({ baseUrl: "http://localhost:11434/v1", dialect: "messages" })).toBe(
      "http://localhost:11434/v1/v1/models",
    )
    // A keyless endpoint gets no credential at all.
    expect([...compat.headers(input(endpoint(["m"]))).keys()]).toEqual([])
    expect(compat.verdict({ status: 429, headers: new Headers(), body: new Uint8Array(), now: at(0) })).toEqual(
      Verdict.Throttled({}),
    )
  })
})
