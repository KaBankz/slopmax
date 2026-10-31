import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client } from "@slopmax/net"
import type { Dialect } from "@slopmax/wire"

import { Account } from "../../src/account.ts"
import { type LoginOptions, LoginOptions as Options, Prompt } from "../../src/auth/mod.ts"
import { Compat, modelsUrl } from "../../src/provider/compat.ts"
import { Verdict } from "../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../src/testkit.ts"

const account = (models: ReadonlyArray<string>): Account =>
  Account.assignId({
    ...Account.make("compat", { accessToken: "" }, 0),
    endpoint: { baseUrl: "http://localhost:11434/v1", dialect: "chat", models },
  })

/**
 * An endpoint listing two models for the key `good` (by the dialect's
 * header), failing for `flaky`, and refusing anything else.
 */
const server = () =>
  Mock.start((seen) => {
    const list = { data: [{ id: "local-1" }, { id: "local-2" }] }
    const route = Seen.route(seen)
    const bearer = Seen.header(seen, "authorization")
    const xKey = Seen.header(seen, "x-api-key")
    if ((route === "/v1/models" || route === "/v1/v1/models") && bearer === "Bearer good") return json(200, list)
    if (route === "/anthropic/v1/models" && bearer === undefined && xKey === "good") return json(200, list)
    if (bearer === "Bearer flaky" || xKey === "flaky") return reply(500, "")
    return reply(401, "")
  })

const options = (baseUrl: string, dialect: Dialect, models: ReadonlyArray<string>, key: string): LoginOptions => ({
  ...Options.default(),
  endpoint: { baseUrl, dialect, models },
  key,
})

const login = (opts: LoginOptions) =>
  Effect.gen(function* () {
    const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
    return yield* Compat.login(
      http,
      opts,
      Prompt.make(() => {}),
    )
  })

describe("provider/compat", () => {
  plain("endpoints_are_the_accounts_data", () => {
    const local = account(["qwen3-*", "llama4"])
    expect(Compat.serves(local, "qwen3-coder")).toBe(true)
    expect(Compat.serves(local, "gpt-6-sol")).toBe(false)
    expect(Compat.api(local)).toBe("http://localhost:11434/v1")
    expect(Compat.dialects(local)).toEqual(["chat"])
    expect(Account.name(local)).toBe("localhost:11434")
    expect(local.endpoint && modelsUrl(local.endpoint)).toBe("http://localhost:11434/v1/models")
    // The same server under two keys is two accounts.
    const other = Account.assignId({ ...local, tokens: { ...local.tokens, accessToken: "key" } })
    expect(other.id).not.toBe(local.id)
  })

  it.live("logins_list_the_models_when_none_are_named", () =>
    Effect.gen(function* () {
      const mock = yield* server()
      const base = `${mock.url}/v1/`
      const a = yield* login(options(base, "chat", [], "good"))
      expect(a.endpoint?.models).toEqual(["local-1", "local-2"])
      expect(a.tokens.accessToken).toBe("good")
      expect(a.id.startsWith("compat-")).toBe(true)
      expect(Compat.identity(a)).toBe(`${base} good`)

      // Anthropic-style endpoints list under /v1 with x-api-key.
      const messages = yield* login(options(`${mock.url}/anthropic`, "messages", [], "good"))
      expect(messages.endpoint?.models.length).toBe(2)
    }),
  )

  it.live("named_models_survive_an_endpoint_that_cannot_list", () =>
    Effect.gen(function* () {
      const mock = yield* server()
      const base = `${mock.url}/v1`
      const named = yield* login(options(base, "responses", ["m-*", "m-1"], "flaky"))
      expect(named.endpoint?.models).toEqual(["m-*", "m-1"])

      const err = yield* Effect.flip(login(options(base, "chat", [], "flaky")))
      expect(err.message).toBe(`could not list the models at ${base}; name them with --models`)
      const wrong = yield* Effect.flip(login(options(base, "chat", [], "wrong")))
      expect(wrong.message).toContain("rejected the key")
    }),
  )

  it.live("logins_need_an_address", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(login(Options.default()))
      expect(err.message).toBe("a compatible endpoint needs its address: --url <base url>")
    }),
  )

  it.live("catalogs_name_models_but_not_patterns", () =>
    Effect.gen(function* () {
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      const models = yield* Compat.catalog(http, account(["qwen3-*", "llama4", "phi"]), "")
      expect(models).toEqual(["llama4", "phi"])
    }),
  )

  plain("accounts_without_an_endpoint_serve_nothing", () => {
    const bare = Account.make("compat", { accessToken: "" }, 0)
    expect(Compat.identity(bare)).toBeUndefined()
    expect(Compat.api(bare)).toBe("")
    expect(Compat.dialects(bare)).toEqual([])
    expect(Compat.serves(bare, "anything")).toBe(false)
    const keyed = { ...bare, tokens: { ...bare.tokens, accessToken: "k" } }
    // Without an endpoint the key goes as a bearer token.
    expect(Compat.headers(new Headers(), keyed, false).get("authorization")).toBe("Bearer k")
  })

  plain("keys_go_in_the_header_the_dialect_expects", () => {
    const base = account(["glm-*"])
    const messages: Account = {
      ...base,
      tokens: { ...base.tokens, accessToken: "k" },
      endpoint: { baseUrl: "http://localhost:11434/v1", dialect: "messages", models: ["glm-*"] },
    }
    const sent = Compat.headers(new Headers(), messages, false)
    expect(sent.get("x-api-key")).toBe("k")
    expect(sent.has("authorization")).toBe(false)
    expect(messages.endpoint && modelsUrl(messages.endpoint)).toBe("http://localhost:11434/v1/v1/models")
    expect(Compat.verdict(429, new Headers(), new Uint8Array(), undefined, Timestamp.nowUnsafe())).toEqual(
      Verdict.Throttled(undefined),
    )
  })
})

describe("provider/compat, beyond the Rust tests", () => {
  it.live("open endpoints need no key and send no credential", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.header(seen, "authorization") === undefined ? json(200, { data: [{ id: "free" }] }) : reply(401, ""),
      )
      const a = yield* login({
        ...Options.default(),
        endpoint: { baseUrl: `${mock.url}//`, dialect: "chat", models: [] },
      })
      expect(a.endpoint?.models).toEqual(["free"])
      expect(mock.seen()[0]?.path).toBe("/models")
      expect(Compat.headers(new Headers({ authorization: "Bearer sm" }), a, false).has("authorization")).toBe(false)
    }),
  )
})
