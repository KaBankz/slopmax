import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Redacted, Result, Schema } from "effect"
import {
  AgentId,
  agentFacts,
  isSubscription,
  matchesAny,
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
    expect(matchesAny(["claude-*"], "claude-opus-5-5")).toBe(true)
    expect(matchesAny(["claude-*"], "gpt-6-sol")).toBe(false)
    expect(matchesAny(["gpt-*"], "gpt-6-sol")).toBe(true)
    expect(matchesAny(["o3*"], "o3")).toBe(true)
    expect(matchesAny(["*-coder"], "qwen3-coder")).toBe(true)
    expect(matchesAny(["a*b*c"], "a-x-b-y-c")).toBe(true)
    expect(matchesAny(["a*b*c"], "a-x-c")).toBe(false)
    expect(matchesAny(["exact"], "exact")).toBe(true)
    expect(matchesAny(["exact"], "exactly")).toBe(false)
    expect(matchesAny(["*"], "anything")).toBe(true)
    expect(matchesAny(["grok-*", "gpt-*"], "gpt-6")).toBe(true)
    expect(matchesAny([], "gpt-6")).toBe(false)
  })

  it("matches the edge cases of patterns: empty, a bare star, and parts that may not overlap", () => {
    expect(matchesAny([""], "")).toBe(true)
    expect(matchesAny([""], "x")).toBe(false)
    expect(matchesAny(["a*"], "a")).toBe(true)
    expect(matchesAny(["*abc"], "bc")).toBe(false)
    expect(matchesAny(["*"], "")).toBe(true)
    // The last part may not reuse characters a middle part matched.
    expect(matchesAny(["ab*b*ab"], "abab")).toBe(false)
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
    expect(providerFacts.xai.backs).toBe("grok")
    expect(providerFacts.compat.backs).toBeUndefined()
  })

  it("lists the known providers when an id is none of them", () => {
    expect(parseProviderId("gemini")).toEqual(
      Result.fail('expected one of claude, codex, grok, anthropic, openai, xai, compat, got "gemini"'),
    )
  })
})

describe("agents", () => {
  it("has one agent per subscription, each naming its provider", () => {
    expect(new Set(AgentId.literals).size).toBe(AgentId.literals.length)
    for (const provider of providerOrder) {
      const native = AgentId.literals.some((id) => agentFacts[id].provider === provider)
      expect(native).toBe(isSubscription(provider))
      const only = providerFacts[provider].agentOnly
      if (only !== undefined) expect(AgentId.literals).toContain(only)
    }
    expect(agentFacts.codex.title).toBe("Codex")
    expect(agentFacts["claude-code"].title).toBe("Claude Code")
    expect(agentFacts["grok-build"].program).toBe("grok")
    expect(providerFacts.grok.agentOnly).toBe("grok-build")
    expect(AgentId.literals).toEqual(["claude-code", "codex", "grok-build"])
  })
})
