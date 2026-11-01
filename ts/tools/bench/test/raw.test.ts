import { describe, expect, test } from "bun:test"
import { it } from "@slopmax/test"
import { Effect } from "effect"
import { handleRaw, rawTarget, splitAddress } from "../raw.ts"
import { serveMock } from "../src/mock.ts"

describe("the raw probe", () => {
  test("sends Claude Code's paths to the provider's root and Codex's as they are, as slopmax does", () => {
    expect(rawTarget("/claude/v1/messages", "http://mock")).toBe("http://mock/v1/messages")
    expect(rawTarget("/codex/responses", "http://mock")).toBe("http://mock/codex/responses")
    expect(rawTarget("/v1/messages", "http://mock")).toBeUndefined()
  })

  test("reads host:port, with port 0 when there is none", () => {
    expect(splitAddress("127.0.0.1:9101")).toEqual({ hostname: "127.0.0.1", port: 9101 })
    expect(splitAddress("localhost")).toEqual({ hostname: "localhost", port: 0 })
  })

  it.live("relays the provider's stream byte for byte, keeping the query and the headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const upstream = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
        const direct = yield* Effect.promise(() =>
          fetch(`${upstream}/v1/messages`, { method: "POST", body: "{}" }).then((answer) => answer.text()),
        )
        const relayed = yield* Effect.promise(() =>
          handleRaw(
            new Request("http://probe/claude/v1/messages?beta=true", {
              method: "POST",
              body: "{}",
              headers: { "content-type": "application/json" },
            }),
            upstream,
          ),
        )
        expect(relayed.status).toBe(200)
        expect(relayed.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed")
        expect(yield* Effect.promise(() => relayed.text())).toBe(direct)
        const missing = yield* Effect.promise(() => handleRaw(new Request("http://probe/nowhere"), upstream))
        expect(missing.status).toBe(404)
        const health = yield* Effect.promise(() => handleRaw(new Request("http://probe/healthz"), upstream))
        expect(health.status).toBe(200)
      }),
    ),
  )
})
