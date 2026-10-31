import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Redacted, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import {
  AgentId,
  agentFacts,
  agentOrder,
  compareProviders,
  isSubscription,
  matchesAny,
  matchesModel,
  newHex64,
  newKey,
  newToken,
  newUuid,
  parseAgentId,
  parseProviderId,
  ProviderId,
  providerFacts,
  providerOrder,
  Secret,
  signsInByDevice,
} from "../src/index.ts"

describe("ids", () => {
  it.effect("makes tokens, keys, hex ids and version 4 UUIDs of the right shape", () =>
    Effect.gen(function* () {
      const token = yield* newToken
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const key = yield* newKey
      expect(key).toMatch(/^sm-[A-Za-z0-9_-]{43}$/)
      expect(yield* newHex64).toMatch(/^[0-9a-f]{64}$/)
      const uuid = yield* newUuid
      expect(uuid).toHaveLength(36)
      expect(uuid[14]).toBe("4")
      expect("89ab").toContain(uuid[19] ?? "")
      expect(yield* newUuid).not.toBe(uuid)
      expect(yield* newToken).not.toBe(token)
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  )

  it("keeps secrets as plain text in files and redacted in memory", () => {
    const secret = Schema.decodeUnknownSync(Secret)("sk-live")
    expect(String(secret)).not.toContain("sk-live")
    expect(Redacted.value(secret)).toBe("sk-live")
    expect(Schema.encodeSync(Secret)(secret)).toBe("sk-live")
  })
})

describe("providers", () => {
  it("matches model patterns with wildcards", () => {
    expect(matchesModel("claude-*", "claude-opus-5-5")).toBe(true)
    expect(matchesModel("claude-*", "gpt-6-sol")).toBe(false)
    expect(matchesModel("gpt-*", "gpt-6-sol")).toBe(true)
    expect(matchesModel("o3*", "o3")).toBe(true)
    expect(matchesModel("*-coder", "qwen3-coder")).toBe(true)
    expect(matchesModel("a*b*c", "a-x-b-y-c")).toBe(true)
    expect(matchesModel("a*b*c", "a-x-c")).toBe(false)
    expect(matchesModel("exact", "exact")).toBe(true)
    expect(matchesModel("exact", "exactly")).toBe(false)
    expect(matchesModel("*", "anything")).toBe(true)
    expect(matchesAny(["grok-*", "gpt-*"], "gpt-6")).toBe(true)
    expect(matchesAny([], "gpt-6")).toBe(false)
  })

  it("matches the edge cases of patterns: empty, a bare star, and parts that may not overlap", () => {
    expect(matchesModel("", "")).toBe(true)
    expect(matchesModel("", "x")).toBe(false)
    expect(matchesModel("a*", "a")).toBe(true)
    expect(matchesModel("*abc", "bc")).toBe(false)
    expect(matchesModel("*", "")).toBe(true)
    // The last part may not reuse characters a middle part matched.
    expect(matchesModel("ab*b*ab", "abab")).toBe(false)
  })

  it("lists providers subscriptions first, which is also the order they try and sort in", () => {
    expect(providerOrder).toEqual(["claude", "codex", "anthropic", "openai", "xai", "compat"])
    expect(providerOrder.toReversed().toSorted(compareProviders)).toEqual([...providerOrder])
    for (const id of providerOrder) {
      expect(providerFacts[id].id).toBe(id)
      expect(Schema.decodeUnknownSync(ProviderId)(JSON.parse(JSON.stringify(id)))).toBe(id)
      expect(parseProviderId(id)).toEqual(Result.succeed(id))
    }
  })

  it("lets metered providers back only a subscription", () => {
    for (const id of providerOrder) {
      const backs = providerFacts[id].backs
      if (backs !== undefined) {
        expect(providerFacts[id].billing).toBe("metered")
        expect(isSubscription(backs)).toBe(true)
      }
    }
    expect(providerFacts.anthropic.backs).toBe("claude")
    expect(providerFacts.openai.backs).toBe("codex")
    expect(providerFacts.xai.backs).toBeUndefined()
  })

  it("lists the known providers when an id is none of them", () => {
    expect(parseProviderId("grok")).toEqual(
      Result.fail('expected one of claude, codex, anthropic, openai, xai, compat, got "grok"'),
    )
  })

  it("says how each provider's accounts sign in and pay", () => {
    expect(isSubscription("claude")).toBe(true)
    expect(isSubscription("codex")).toBe(true)
    expect(isSubscription("openai")).toBe(false)
    expect(signsInByDevice("codex")).toBe(true)
    expect(signsInByDevice("claude")).toBe(false)
    expect(signsInByDevice("compat")).toBe(false)
    expect(providerFacts.compat.signIn).toBe("endpoint")
    expect(providerFacts.xai.signIn).toBe("key")
    expect(providerFacts.claude.agentOnly).toBe("claude-code")
    expect(providerFacts.anthropic.agentOnly).toBe("claude-code")
    expect(providerFacts.codex.agentOnly).toBeUndefined()
    expect(providerFacts.claude.hasResets && providerFacts.codex.hasResets).toBe(true)
    expect(providerFacts.openai.dialects).toEqual(["responses", "chat"])
    expect(providerFacts.compat.dialects).toEqual([])
    expect(providerFacts.codex.api).toBe("https://chatgpt.com/backend-api/codex")
    expect(matchesAny(providerFacts.codex.models, "o4-mini")).toBe(true)
    expect(providerFacts.claude.title).toBe("Claude")
    expect(providerFacts.codex.title).toBe("ChatGPT")
  })
})

describe("agents", () => {
  it("has one agent per subscription, each naming its provider", () => {
    expect(new Set(agentOrder).size).toBe(agentOrder.length)
    for (const provider of providerOrder) {
      const native = agentOrder.some((id) => agentFacts[id].provider === provider)
      expect(native).toBe(isSubscription(provider))
      const only = providerFacts[provider].agentOnly
      if (only !== undefined) expect(agentOrder).toContain(only)
    }
    expect(agentFacts.codex.title).toBe("Codex")
    expect(agentFacts["claude-code"].title).toBe("Claude Code")
    expect(AgentId.literals).toEqual(["claude-code", "codex"])
  })

  it("reads an agent by its id or its program, and lists the programs otherwise", () => {
    expect(parseAgentId("claude")).toEqual(Result.succeed("claude-code"))
    expect(parseAgentId("claude-code")).toEqual(Result.succeed("claude-code"))
    expect(parseAgentId("codex")).toEqual(Result.succeed("codex"))
    expect(parseAgentId("gemini")).toEqual(Result.fail('expected one of claude, codex, got "gemini"'))
  })
})
