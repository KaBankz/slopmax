import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Layer, Redacted } from "effect"
import { Accounts } from "../../src/accounts.ts"
import { signIn } from "../../src/providers/index.ts"
import { json, mockUpstream, reply, signInServices, storeLayer } from "./support.ts"

const options = (key: string, label?: string) => ({
  endpoint: { baseUrl: "http://gpu.test/v1", dialect: "chat" as const, models: [] },
  key: Redacted.make(key),
  ...(label === undefined ? {} : { label }),
})

describe("signing in", () => {
  it.effect("saves the account, and merges a repeat sign-in into it, keeping its label", () => {
    const api = mockUpstream((seen) =>
      seen.url.pathname === "/v1/models" && seen.headers.get("authorization") === "Bearer key-1"
        ? json(200, { data: [{ id: "qwen3-coder" }] })
        : reply(401),
    )
    return Effect.gen(function* () {
      const accounts = yield* Accounts
      const first = yield* signIn("compat", options("key-1", "local"))
      expect(first.isNew).toBe(true)
      expect(first.account.label).toBe("local")
      expect(first.account.credential).toMatchObject({ models: ["qwen3-coder"] })
      expect(yield* accounts.list).toHaveLength(1)

      const again = yield* signIn("compat", options("key-1"))
      expect(again.isNew).toBe(false)
      expect(again.account.id).toBe(first.account.id)
      // The label given before is kept.
      expect(again.account.label).toBe("local")

      const wrong = yield* Effect.flip(signIn("compat", options("key-2")))
      expect(wrong.message).toContain("rejected the key")
      expect(yield* accounts.list).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(storeLayer(api.layer), signInServices)))
  })
})
