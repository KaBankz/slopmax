import { describe, expect, it } from "bun:test"
import { classify, type Entry, routeFor, targetOf, wantsModelList } from "../../src/proxy/classify.ts"

const none = new Headers()

/** The parts of a route these tests check. */
const at = (target: string, headers: Headers = none, method = "POST") => {
  const route = routeFor(method, target, headers)
  return route === undefined ? undefined : ([route.pathProvider, route.path, route.dialect, route.byModel] as const)
}

const kind = (method: string, url: string, headers: Record<string, string> = {}): Entry["_tag"] =>
  classify(method, `http://127.0.0.1:8318${url}`, new Headers(headers))._tag

describe("routing paths to providers and formats", () => {
  it("routes the prefixed and the unprefixed /v1 paths", () => {
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

  it("takes a prefix only as a whole path segment", () => {
    expect(at("/claude")).toEqual(["claude", "", "messages", false])
    expect(at("/claude?x=1")).toEqual(["claude", "?x=1", "messages", false])
    expect(at("/claudette/v1/messages")).toBeUndefined()
    expect(at("/v1x/messages")).toBeUndefined()
  })

  it("lists Claude's models for a model list that carries anthropic-version, even with Codex's query", () => {
    expect(at("/v1/models?client_version=1", new Headers({ "anthropic-version": "2023-06-01" }))).toEqual([
      "claude",
      "/v1/models?client_version=1",
      "messages",
      false,
    ])
  })

  it("marks model lists, housekeeping and token counting", () => {
    const list = routeFor("GET", "/codex/models?client_version=1", none)
    expect(list?.listing).toBe(true)
    expect(list?.housekeeping).toBe(true)
    const count = routeFor("POST", "/claude/v1/messages/count_tokens", none)
    expect(count?.countTokens).toBe(true)
    expect(count?.housekeeping).toBe(true)
    expect(count?.listing).toBe(false)
    const work = routeFor("POST", "/claude/v1/messages?beta=true", none)
    expect([work?.countTokens, work?.housekeeping, work?.listing]).toEqual([false, false, false])
    expect(routeFor("POST", "/v1/messages/count_tokens", none)?.countTokens).toBe(true)
  })

  it("reads the request line's target from an absolute URL", () => {
    expect(targetOf("http://127.0.0.1:8318/claude/v1/messages?beta=true")).toBe("/claude/v1/messages?beta=true")
    expect(targetOf("http://[::1]:8318")).toBe("/")
  })
})

describe("telling what a request is", () => {
  it("answers health, then the probes, then slopmax's own paths, then the model list, then the proxy", () => {
    expect(kind("GET", "/healthz")).toBe("Health")
    expect(kind("POST", "/healthz")).toBe("Unknown")
    expect(kind("HEAD", "/healthz")).toBe("Hello")
    expect(kind("GET", "/api/hello")).toBe("Hello")
    expect(kind("POST", "/api/hello")).toBe("Hello")
    expect(kind("HEAD", "/slopmax/api/status")).toBe("Hello")
    expect(kind("HEAD", "/nowhere")).toBe("Hello")
    expect(kind("GET", "/slopmax/")).toBe("Web")
    expect(kind("POST", "/slopmax/api/sync")).toBe("Web")
    expect(kind("GET", "/v0/management/auth-files")).toBe("Web")
    expect(kind("GET", "/v1/models")).toBe("Models")
    expect(kind("POST", "/claude/v1/messages")).toBe("Inference")
    expect(kind("GET", "/nowhere")).toBe("Unknown")
  })

  it("leaves Claude Code's and Codex's model lists to their own providers", () => {
    expect(wantsModelList(none, "limit=20")).toBe(true)
    expect(wantsModelList(none, "client_version=0.159.3")).toBe(false)
    expect(wantsModelList(new Headers({ "anthropic-version": "2023-06-01" }), "")).toBe(false)
    expect(wantsModelList(new Headers({ "user-agent": "claude-cli/2.1.287 (external, cli)" }), "limit=1000")).toBe(
      false,
    )
    expect(kind("GET", "/v1/models?limit=1000", { "user-agent": "claude-cli/2.1.287 (external, cli)" })).toBe(
      "Inference",
    )
    expect(kind("GET", "/v1/models?client_version=0.160.0")).toBe("Inference")
  })

  it("sends WebSocket handshakes on inference paths to the relay, whatever the case of the header", () => {
    expect(kind("GET", "/codex/responses", { upgrade: "websocket" })).toBe("Socket")
    expect(kind("GET", "/v1/responses", { upgrade: "WebSocket" })).toBe("Socket")
    expect(kind("GET", "/claude/v1/messages", { upgrade: "websocket" })).toBe("Socket")
    expect(kind("GET", "/codex/responses", { upgrade: "h2c" })).toBe("Inference")
    expect(kind("GET", "/elsewhere", { upgrade: "websocket" })).toBe("Unknown")
  })
})
