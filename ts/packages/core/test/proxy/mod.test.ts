import { describe, expect, it } from "bun:test"

// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { Config } from "../../src/config.ts"
import { affinity, forwardable, returnable } from "../../src/proxy/headers.ts"
import { authorized, caller, route } from "../../src/proxy/mod.ts"

const at = (path: string) => {
  const t = route(path, new Headers())
  return t === undefined ? undefined : [t.provider, t.path, t.dialect, t.byModel]
}

describe("proxy/mod", () => {
  it("routes_prefixed_and_v1_paths", () => {
    expect(at("/claude/v1/messages?beta=true")).toEqual(["claude", "/v1/messages?beta=true", "messages", true])
    expect(at("/claude/v1/messages/count_tokens")).toEqual(["claude", "/v1/messages/count_tokens", "messages", true])
    expect(at("/codex/responses")).toEqual(["codex", "/responses", "responses", true])
    expect(at("/codex/models?client_version=1")).toEqual(["codex", "/models?client_version=1", "responses", false])
    expect(at("/v1/messages?beta=true")).toEqual(["claude", "/v1/messages?beta=true", "messages", true])
    expect(at("/v1/responses")).toEqual(["codex", "/responses", "responses", true])
    expect(at("/v1/chat/completions")).toEqual([undefined, "/chat/completions", "chat", true])
    expect(at("/v1/models?client_version=0.159.3")).toEqual([
      "codex",
      "/models?client_version=0.159.3",
      "responses",
      false,
    ])
    expect(at("/v1/models?limit=1000")).toEqual(["claude", "/v1/models?limit=1000", "messages", false])
    expect(at("/v1/messagesx")).toEqual(["claude", "/v1/messagesx", "messages", false])
    expect(at("/codexx/responses")).toBeUndefined()
    expect(at("/other")).toBeUndefined()
  })

  it("client_keys_reach_the_proxy_but_not_the_admin_api", () => {
    const config: Config = {
      ...Config.default(),
      apiKey: "sm-owner",
      keys: [{ name: "laptop", key: "sm-laptop", models: ["gpt-*"] }],
    }
    const headers = new Headers({ authorization: "Bearer sm-laptop" })
    const who = caller(config, headers)
    expect(who?._tag === "Client" && who.key.name === "laptop").toBe(true)
    expect(authorized(config, headers)).toBe(false)
    headers.set("authorization", "Bearer sm-owner")
    expect(caller(config, headers)?._tag).toBe("Owner")
    headers.set("authorization", "Bearer sm-other")
    expect(caller(config, headers)).toBeUndefined()
  })

  it("auth_accepts_bearer_or_api_key", () => {
    const config: Config = { ...Config.default(), apiKey: "sm-key" }
    const headers = new Headers()
    expect(authorized(config, headers)).toBe(false)
    headers.set("authorization", "Bearer sm-key")
    expect(authorized(config, headers)).toBe(true)
    headers.set("authorization", "Bearer nope")
    expect(authorized(config, headers)).toBe(false)
    expect(authorized(config, new Headers({ "x-api-key": "sm-key" }))).toBe(true)
  })

  it("forwardable_drops_only_credentials_and_hop_by_hop", () => {
    const client = new Headers({
      authorization: "Bearer sm-key",
      connection: "keep-alive",
      "accept-encoding": "gzip, br",
      "x-app": "cli",
    })
    const out = forwardable(client)
    expect(out.has("authorization")).toBe(false)
    expect(out.has("connection")).toBe(false)
    expect(out.get("accept-encoding")).toBe("gzip, br")
    expect(out.get("x-app")).toBe("cli")
  })
})

describe("proxy/mod, beyond the Rust tests", () => {
  it("only Bearer and bearer are read from authorization, and a bearer token wins over x-api-key", () => {
    const config: Config = { ...Config.default(), apiKey: "sm-key" }
    expect(authorized(config, new Headers({ authorization: "bearer sm-key" }))).toBe(true)
    expect(authorized(config, new Headers({ authorization: "BEARER sm-key" }))).toBe(false)
    expect(authorized(config, new Headers({ authorization: "Bearer  sm-key  " }))).toBe(true)
    // A bearer token that is wrong is not rescued by a right x-api-key.
    expect(authorized(config, new Headers({ authorization: "Bearer nope", "x-api-key": "sm-key" }))).toBe(false)
    // An authorization header that is not a bearer token leaves x-api-key to decide.
    expect(authorized(config, new Headers({ authorization: "Basic abc", "x-api-key": "sm-key" }))).toBe(true)
  })

  it("forwardable drops slopmax's own headers, host, length, keys, and cookies; returnable drops lengths and cookies", () => {
    const client = new Headers({
      "x-slopmax-affinity": "off",
      host: "127.0.0.1",
      "content-length": "3",
      "x-api-key": "k",
      cookie: "a=b",
      te: "trailers",
      upgrade: "websocket",
      "anthropic-beta": "x",
    })
    expect([...forwardable(client).keys()]).toEqual(["anthropic-beta"])
    const upstream = new Headers({
      "content-length": "3",
      "set-cookie": "a=b",
      "transfer-encoding": "chunked",
      "x-r": "1",
    })
    expect([...returnable(upstream).keys()]).toEqual(["x-r"])
  })

  it("the affinity header says on, off, or nothing", () => {
    expect(affinity(new Headers({ "x-slopmax-affinity": " Yes " }))).toBe(true)
    expect(affinity(new Headers({ "x-slopmax-affinity": "OFF" }))).toBe(false)
    expect(affinity(new Headers({ "x-slopmax-affinity": "maybe" }))).toBeUndefined()
    expect(affinity(new Headers())).toBeUndefined()
  })
})
