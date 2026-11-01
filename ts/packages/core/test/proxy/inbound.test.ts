import { describe, expect } from "bun:test"
import { AccountId, Settings, strict } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Result, Schema } from "effect"
import { authenticate, Caller, heldKey, keyRing, presentedKey } from "../../src/proxy/auth.ts"
import { routeFor } from "../../src/proxy/classify.ts"
import { estimate } from "../../src/proxy/count-tokens.ts"
import { inspect, isInspectable, keyRefusal, maxBody, readBody, stepsFor } from "../../src/proxy/inbound.ts"

const settings = Schema.decodeUnknownSync(Settings)(
  {
    apiKey: "sm-owner",
    keys: [
      { name: "laptop", key: "sm-laptop", models: ["gpt-*"] },
      { name: "ci", key: "sm-ci" },
    ],
  },
  strict,
)
const ring = keyRing(settings)
const as = (headers: Record<string, string>) => authenticate(new Headers(headers), ring)
const laptop = as({ authorization: "Bearer sm-laptop" })
const owner: Caller = Caller.Owner()

const utf8 = new TextEncoder()

const inbound = (
  target: string,
  body: string,
  options: { readonly caller?: Caller; readonly headers?: Record<string, string>; readonly method?: string } = {},
) => {
  const headers = new Headers({ "content-type": "application/json", ...options.headers })
  const route = routeFor(options.method ?? "POST", target, headers)
  if (route === undefined) throw new Error(`no route for ${target}`)
  return inspect(route, headers, utf8.encode(body), options.caller ?? owner, 0)
}

/** What a request asking for affinity `value` gets. */
const ask = (value: string) =>
  inbound("/v1/chat/completions", '{"model":"m"}', { headers: { "x-slopmax-affinity": value } }).affinity

/** A Codex step asking for `model`. */
const step = (model: string) => ({ provider: "codex" as const, model, accounts: [AccountId.make("codex-a")] })

describe("reading the key a request presents", () => {
  it("takes a bearer token, spelled Bearer or bearer, else x-api-key, trimmed", () => {
    expect(presentedKey(new Headers({ authorization: "Bearer  sm-key " }))).toBe("sm-key")
    expect(presentedKey(new Headers({ authorization: "bearer sm-key" }))).toBe("sm-key")
    expect(presentedKey(new Headers({ authorization: "BEARER sm-key" }))).toBeUndefined()
    expect(presentedKey(new Headers({ "x-api-key": " sm-key\t" }))).toBe("sm-key")
    expect(presentedKey(new Headers({ authorization: "Bearer sm-a", "x-api-key": "sm-b" }))).toBe("sm-a")
    expect(presentedKey(new Headers({ authorization: "Basic abc", "x-api-key": "sm-b" }))).toBe("sm-b")
    expect(presentedKey(new Headers())).toBeUndefined()
  })

  it("accepts the owner key as a bearer token or x-api-key, and nothing else", () => {
    expect(as({})).toBeUndefined()
    expect(as({ authorization: "Bearer sm-owner" })).toEqual(owner)
    expect(as({ "x-api-key": "sm-owner" })).toEqual(owner)
    expect(as({ authorization: "Bearer nope" })).toBeUndefined()
    expect(as({ authorization: "Bearer " })).toBeUndefined()
    expect(as({ authorization: "Bearer sm-owne" })).toBeUndefined()
  })

  it("tells a client key from the owner key, and holds it to its models only when it names some", () => {
    expect(laptop?._tag).toBe("Client")
    expect(laptop?._tag === "Client" ? String(laptop.key.name) : undefined).toBe("laptop")
    expect(laptop === undefined ? undefined : String(heldKey(laptop)?.name)).toBe("laptop")
    const ci = as({ "x-api-key": "sm-ci" })
    expect(ci?._tag).toBe("Client")
    expect(ci === undefined ? "missing" : heldKey(ci)).toBeUndefined()
    expect(heldKey(owner)).toBeUndefined()
    expect(as({ authorization: "Bearer sm-other" })).toBeUndefined()
  })

  it("works the key ring out once per settings value", () => {
    expect(keyRing(settings)).toBe(ring)
  })
})

describe("reading a request's body", () => {
  it.effect("reads the body whole, and an empty request as no bytes", () =>
    Effect.gen(function* () {
      const body = yield* readBody(new Request("http://x/", { method: "POST", body: '{"a":1}' }))
      expect(new TextDecoder().decode(body)).toBe('{"a":1}')
      expect((yield* readBody(new Request("http://x/"))).length).toBe(0)
    }),
  )

  it.effect("refuses a body declared past 256 MiB before reading it", () =>
    Effect.gen(function* () {
      const request = new Request("http://x/", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(maxBody + 1) },
      })
      const read = yield* Effect.result(readBody(request))
      expect(Result.isFailure(read) ? read.failure.message : "read").toBe("request body is too large")
    }),
  )

  it.effect("counts a body sent in chunks with no length, and gives it up past 256 MiB", () =>
    Effect.gen(function* () {
      const mebibyte = new Uint8Array(1024 * 1024)
      let sent = 0
      const endless = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          sent++
          controller.enqueue(mebibyte)
        },
      })
      const read = yield* Effect.result(readBody(new Request("http://x/", { method: "POST", body: endless })))
      expect(Result.isFailure(read) ? read.failure.message : "read").toBe("request body is too large")
      expect(sent).toBeLessThan(maxBody / mebibyte.length + 4)
      const parts = ['{"a":', "1}"].map((part) => new TextEncoder().encode(part))
      const small = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          const part = parts.shift()
          if (part === undefined) controller.close()
          else controller.enqueue(part)
        },
      })
      const whole = yield* readBody(new Request("http://x/", { method: "POST", body: small }))
      expect(new TextDecoder().decode(whole)).toBe('{"a":1}')
    }),
  )

  it.effect("says why a body could not be read", () =>
    Effect.gen(function* () {
      const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("reset")) })
      const read = yield* Effect.result(readBody(new Request("http://x/", { method: "POST", body: broken })))
      expect(Result.isFailure(read) ? read.failure.message : "read").toBe("could not read the request body: reset")
    }),
  )
})

describe("inspecting a request", () => {
  it("reads only plain JSON bodies, never compressed or broken ones", () => {
    const json = utf8.encode('{"model":"m"}')
    expect(isInspectable(new Headers(), json)).toBe(true)
    expect(isInspectable(new Headers({ "content-encoding": "identity" }), json)).toBe(true)
    expect(isInspectable(new Headers({ "content-encoding": "gzip" }), json)).toBe(false)
    expect(isInspectable(new Headers(), utf8.encode('{"model":'))).toBe(false)
    expect(isInspectable(new Headers(), new Uint8Array(0))).toBe(false)
  })

  it("finds the model, the agent, the session and the affinity a request asks for", () => {
    const seen = inbound(
      "/codex/responses",
      '{"input":[{"model":"inner"}],"model":"gpt-6-sol","prompt_cache_key":"cache-1"}',
      {
        headers: { "user-agent": "codex_cli_rs/0.160.0 (Linux; x86_64)", "x-slopmax-affinity": " OFF " },
      },
    )
    expect(seen.json).toBe(true)
    expect(seen.model).toBe("gpt-6-sol")
    expect(seen.agent?.id).toBe("codex")
    expect(seen.affinity).toBe(false)
    expect(seen.session).toBe("cache-1")
  })

  it("takes the session from the common headers before the body, and none from a body it cannot read", () => {
    expect(
      inbound("/v1/chat/completions", '{"model":"m","prompt_cache_key":"b"}', { headers: { "session-id": "h" } })
        .session,
    ).toBe("h")
    expect(inbound("/v1/chat/completions", '{"model":"m"}', { headers: { "x-session-id": "x" } }).session).toBe("x")
    const zipped = inbound("/v1/chat/completions", '{"model":"m","prompt_cache_key":"b"}', {
      headers: { "content-encoding": "gzip" },
    })
    expect([zipped.json, zipped.model, zipped.session]).toEqual([false, undefined, undefined])
  })

  it("leaves affinity to the settings unless the request says on or off", () => {
    expect([ask("on"), ask("TRUE"), ask("1"), ask("yes")]).toEqual([true, true, true, true])
    expect([ask("off"), ask("false"), ask("0"), ask("No")]).toEqual([false, false, false, false])
    expect(ask("maybe")).toBeUndefined()
  })
})

describe("holding client keys to their models", () => {
  const key = laptop ?? owner
  const asLaptop = (target: string, body: string, method = "POST") =>
    keyRefusal(inbound(target, body, { caller: key, method }))

  it("lets a key use the models it names, and refuses the rest", () => {
    expect(asLaptop("/v1/chat/completions", '{"model":"gpt-6-sol"}')).toBeUndefined()
    expect(asLaptop("/v1/chat/completions", '{"model":"claude-opus-5-5"}')).toBe(
      'the key "laptop" may not use claude-opus-5-5',
    )
  })

  it("refuses a body that names two models, which could route by one and answer by the other", () => {
    expect(asLaptop("/v1/chat/completions", '{"model":"gpt-6-sol","model":"claude-opus-5-5"}')).toBe(
      'the key "laptop" may not send a request that names two models',
    )
  })

  it("refuses a body it cannot read a model from, unless it only lists models", () => {
    expect(asLaptop("/v1/chat/completions", '{"messages":[]}')).toBe(
      'the key "laptop" may use only some models, and this request names none slopmax can read',
    )
    expect(asLaptop("/codex/models?client_version=1", "", "GET")).toBeUndefined()
  })

  it("never holds the owner key or a key that names no models", () => {
    expect(keyRefusal(inbound("/v1/chat/completions", '{"messages":[]}'))).toBeUndefined()
    const ci = as({ "x-api-key": "sm-ci" }) ?? owner
    expect(keyRefusal(inbound("/v1/chat/completions", '{"messages":[]}', { caller: ci }))).toBeUndefined()
  })

  it("drops steps an alias routed past the key, and refuses when none are left", () => {
    const held = laptop === undefined ? undefined : heldKey(laptop)
    expect(stepsFor(held, [step("claude-opus-5-5"), step("gpt-6-sol"), step("")])).toEqual({
      steps: [step("gpt-6-sol"), step("")],
    })
    expect(stepsFor(held, [step("claude-opus-5-5")])).toEqual({
      refused: 'the key "laptop" may not use the models this request is routed to',
    })
    expect(stepsFor(undefined, [step("claude-opus-5-5")])).toEqual({ steps: [step("claude-opus-5-5")] })
  })
})

describe("estimating tokens", () => {
  it("counts about four bytes of a request per token, rounding up", () => {
    expect(estimate(new Uint8Array(0))).toBe(0)
    expect(estimate(new Uint8Array(1))).toBe(1)
    expect(estimate(new Uint8Array(8))).toBe(2)
    expect(estimate(new Uint8Array(9))).toBe(3)
  })
})
