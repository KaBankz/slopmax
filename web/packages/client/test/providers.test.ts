import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Redacted, Result, Schema } from "effect"
import {
  AgentId,
  agentFacts,
  agentOrder,
  isSubscription,
  matchesAny,
  matchesModel,
  parseProviderId,
  providerFacts,
  providerOrder,
  Secret,
} from "../src/index.ts"

describe("ids", () => {
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
})
