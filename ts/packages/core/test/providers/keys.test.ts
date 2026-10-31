import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Layer, Logger, Option, Redacted } from "effect"
import {
  anthropic,
  checkKey,
  keyHeaderFor,
  meteredVerdict,
  modelIds,
  openai,
  withKey,
  xai,
} from "../../src/providers/keys.ts"
import { Verdict } from "../../src/providers/provider.ts"
import { at, downUpstream, json, keyAccount, mockUpstream, reply, signInServices } from "./support.ts"

const utf8 = new TextEncoder()
const refusal = (status: number, body: string, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
  body: utf8.encode(body),
  now: at(1_000),
})

/** A vendor listing two models for the right credential, 401 for any other, and 500 for the key `flaky`. */
const vendor = () =>
  mockUpstream((seen) => {
    const bearer = seen.headers.get("authorization")
    const xKey = seen.headers.get("x-api-key")
    const list = { data: [{ id: "m-1" }, { id: "m-2" }] }
    if (!seen.url.pathname.endsWith("/models")) return reply(404)
    if (bearer === "Bearer sk-good" && xKey === null) return json(200, list)
    if (xKey === "sk-ant-good" && seen.headers.get("anthropic-version") === "2023-06-01") return json(200, list)
    if (bearer === "Bearer flaky") return reply(500)
    if (bearer === "Bearer garbled") return reply(200, "not json")
    if (bearer === null && xKey === null) return json(200, { data: [] })
    return reply(401)
  })

/** Log lines, collected. */
const collectLogs = () => {
  const lines: Array<string> = []
  const layer = Logger.layer([Logger.make(({ message }) => void lines.push(String(message)))])
  return { lines, layer }
}

describe("API keys", () => {
  it("put the key where slopmax's key was", () => {
    const client = new Headers({ authorization: "Bearer sm-key", "user-agent": "codex_exec/0.160.0" })
    const bearer = withKey(client, "bearer", "sk-test")
    expect(bearer.get("authorization")).toBe("Bearer sk-test")
    expect(bearer.get("user-agent")).toBe("codex_exec/0.160.0")
    const anthropicStyle = withKey(client, "x-api-key", "sk-ant-test")
    expect(anthropicStyle.get("x-api-key")).toBe("sk-ant-test")
    expect(anthropicStyle.has("authorization")).toBe(false)
    expect(withKey(client, "bearer", "").has("authorization")).toBe(false)
  })

  it("tell a key out of funds from a rate limit", () => {
    expect(meteredVerdict(refusal(429, `{"error":{"code":"rate_limit_exceeded"}}`, { "retry-after": "20" }))).toEqual(
      Verdict.Throttled({ until: at(1_020) }),
    )
    expect(meteredVerdict(refusal(429, `{"error":{"code":"insufficient_quota"}}`))).toEqual(Verdict.Exhausted({}))
    expect(meteredVerdict(refusal(400, "Your credit balance is too low to access the API"))).toEqual(
      Verdict.Exhausted({}),
    )
    expect(meteredVerdict(refusal(402, ""))).toEqual(Verdict.Exhausted({}))
    expect(meteredVerdict(refusal(401, ""))).toEqual(Verdict.Unauthorized())
    expect(meteredVerdict(refusal(400, "max_tokens too large"))).toEqual(Verdict.Final())
    // Only the start of a long body is looked at.
    expect(meteredVerdict(refusal(429, `${" ".repeat(5_000)}insufficient_quota`))).toEqual(Verdict.Throttled({}))
  })

  it("throttle briefly on overload, and keep a forbidden key's answer", () => {
    for (const status of [503, 529])
      expect(meteredVerdict(refusal(status, "overloaded"))).toEqual(Verdict.Throttled({}))
    expect(meteredVerdict(refusal(403, ""))).toEqual(Verdict.Forbidden())
    expect(keyHeaderFor("responses")).toBe("bearer")
    expect(keyHeaderFor("chat")).toBe("bearer")
    expect(keyHeaderFor("messages")).toBe("x-api-key")
  })

  it("read model lists in either vendor's shape", () => {
    expect(modelIds({ object: "list", data: [{ id: "grok-4" }, { id: "grok-code-fast-1" }] })).toEqual([
      "grok-4",
      "grok-code-fast-1",
    ])
    expect(modelIds({})).toEqual([])
  })

  it("name key accounts by the key's tail", () => {
    const account = keyAccount("openai", "sk-proj-abcdWXYZ")
    expect(account.name).toBe("OpenAI API key …WXYZ")
  })

  it.effect("check the key with the vendor when signing in", () => {
    const api = vendor()
    return Effect.gen(function* () {
      const account = yield* openai.login({ key: Redacted.make("sk-good") })
      expect(account.provider).toBe("openai")
      expect(account.secret).toBe("sk-good")
      expect(openai.identity(account)).toBe("sk-good")
      expect(account.id).toMatch(/^openai-[0-9a-f]{8}$/)
      expect(api.seen[0]?.url.href).toBe("https://api.openai.com/v1/models")
      expect((yield* anthropic.login({ key: Redacted.make("sk-ant-good") })).provider).toBe("anthropic")
      expect(api.seen[1]?.url.href).toBe("https://api.anthropic.com/v1/models")
      const wrong = yield* Effect.flip(xai.login({ key: Redacted.make("sk-wrong") }))
      expect(wrong.message).toBe("https://api.x.ai/v1/models rejected the key (401 Unauthorized)")
      for (const missing of [undefined, Redacted.make("")]) {
        const error = yield* Effect.flip(openai.login({ key: missing }))
        expect(error.message).toBe("no OpenAI API key entered")
      }
      // A vendor that cannot answer right now does not stop the sign-in.
      expect((yield* openai.login({ key: Redacted.make("flaky") })).secret).toBe("flaky")
    }).pipe(Effect.provide(api.layer), Effect.provide(signInServices))
  })

  it.effect("tolerate outages and open endpoints when checking a key, but not a refusal", () => {
    const api = vendor()
    const logs = collectLogs()
    return Effect.gen(function* () {
      const url = "http://models.test/v1/models"
      expect(yield* checkKey(url, "bearer", "sk-good")).toEqual(Option.some(["m-1", "m-2"]))
      // No key, no credential header.
      expect(yield* checkKey(url, "x-api-key", "")).toEqual(Option.some([]))
      expect(api.seen[1]?.headers.has("x-api-key")).toBe(false)
      expect(yield* checkKey(url, "bearer", "garbled")).toEqual(Option.none())
      expect(yield* checkKey(url, "bearer", "flaky")).toEqual(Option.none())
      expect(logs.lines).toContain(`could not check the key: ${url} answered 500 Internal Server Error`)
      const down = yield* checkKey(url, "bearer", "k").pipe(Effect.provide(downUpstream))
      expect(down).toEqual(Option.none())
      expect(logs.lines.some((line) => line.startsWith(`could not check the key against ${url}:`))).toBe(true)
      const forbidden = yield* Effect.flip(
        checkKey("http://x.test/models", "bearer", "k").pipe(Effect.provide(mockUpstream(() => reply(403)).layer)),
      )
      expect(forbidden.message.endsWith("rejected the key (403 Forbidden)")).toBe(true)
    }).pipe(Effect.provide(Layer.merge(api.layer, logs.layer)))
  })

  it.effect("list the models the key can use", () => {
    const api = vendor()
    return Effect.gen(function* () {
      expect(yield* openai.catalog(keyAccount("openai", "sk-good"), {})).toEqual(["m-1", "m-2"])
      expect(yield* openai.catalog(keyAccount("openai", "flaky"), {})).toEqual([])
      expect((yield* Effect.flip(openai.catalog(keyAccount("openai", "revoked"), {})))._tag).toBe("ProviderFailed")
    }).pipe(Effect.provide(api.layer), Effect.provide(signInServices))
  })

  it.effect("have no usage windows, refreshes, or state bound to an account", () =>
    Effect.gen(function* () {
      const account = keyAccount("xai", "xai-key")
      expect(Option.isNone(xai.usage)).toBe(true)
      const refreshed = yield* Effect.flip(xai.refresh(account))
      expect(refreshed.message).toBe("xAI API keys cannot be refreshed; sign in again")
      expect((yield* xai.identify(account)).identity.email).toBeUndefined()
      expect(xai.apiOf(account)).toBe("https://api.x.ai/v1")
      expect(xai.dialectsOf(account)).toEqual(["chat"])
      expect(xai.serves(account, "grok-4")).toBe(true)
      expect(xai.serves(account, "gpt-6")).toBe(false)
      expect(xai.rebind(utf8.encode("{}"))).toEqual(Option.none())
      expect(xai.shape({ max_tokens: 5 })).toEqual({ max_tokens: 5 })
      expect(xai.limitsFrom(new Headers(), at(0))).toEqual(Option.none())
      expect([...xai.showPool(new Headers(), []).keys()]).toEqual([])
      expect(Option.isNone(xai.resets)).toBe(true)
      expect(Option.isNone(xai.socket)).toBe(true)
      const empty = { client: new Headers(), account, moved: false, agents: {}, codex: {} }
      expect(xai.headers(empty).get("authorization")).toBe("Bearer xai-key")
      expect(anthropic.headers(empty).get("x-api-key")).toBe("xai-key")
      expect(xai.verdict(refusal(402, ""))).toEqual(Verdict.Exhausted({}))
    }).pipe(Effect.provide(downUpstream)),
  )
})
