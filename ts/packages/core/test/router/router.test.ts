import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { AccountId, type AgentId, type Dialect, type ProviderId } from "@slopmax/domain"
import { Redacted } from "effect"
import { Account, Credential } from "../../src/account.ts"
import { type Ask, type Plan, plan, planner, refusedText, type Table } from "../../src/router.ts"
import { subscription, ts } from "../pool/fixtures.ts"

/** An account named `label`: a subscription sign-in, or an API key for metered providers. */
const account = (provider: ProviderId, label: string): Account =>
  provider === "claude" || provider === "codex"
    ? new Account({ ...subscription(provider, label), label })
    : new Account({
        id: AccountId.make(`${provider}-${label}`),
        provider,
        credential: Credential.cases.Key.make({ key: Redacted.make(`key-${label}`) }),
        label,
        addedAt: ts(0),
      })

const endpoint = (label: string, dialect: Dialect, models: ReadonlyArray<string>): Account =>
  new Account({
    id: AccountId.make(`compat-${label}`),
    provider: "compat",
    credential: Credential.cases.Endpoint.make({ baseUrl: `http://${label}/v1`, dialect, models }),
    label,
    addedAt: ts(0),
  })

interface Fixture {
  accounts: ReadonlyArray<Account>
  aliases: Record<string, string>
  fallbacks: Record<string, ReadonlyArray<string>>
  paidOverflow: boolean
}

const fixture = (accounts: ReadonlyArray<Account>): Fixture => ({
  accounts,
  aliases: {},
  fallbacks: {},
  paidOverflow: false,
})

const tableOf = (f: Fixture): Table => ({
  accounts: f.accounts,
  settings: { aliases: f.aliases, fallbacks: f.fallbacks, paidOverflow: f.paidOverflow },
})

/** The path an agent's format comes in on: Messages is Claude's, Responses is ChatGPT's. */
const pathOf = (dialect: Dialect): ProviderId | undefined =>
  dialect === "messages" ? "claude" : dialect === "responses" ? "codex" : undefined

const route = (f: Fixture, model: string, dialect: Dialect, agent?: AgentId): Plan =>
  plan(tableOf(f), { model, dialect, agent, pathProvider: pathOf(dialect) })

/** The plan as provider and model per step, or the refusal. */
const steps = (result: Plan) =>
  result._tag === "Steps" ? result.steps.map((step) => [step.provider, step.model]) : result

describe("routing", () => {
  it("subscriptions come first, and keys serve their models only as paid overflow", () => {
    const f = fixture([
      account("codex", "chatgpt"),
      account("openai", "key"),
      account("claude", "max"),
      account("anthropic", "ant"),
    ])
    expect(steps(route(f, "gpt-6-sol", "responses", "codex"))).toEqual([["codex", "gpt-6-sol"]])
    expect(steps(route(f, "claude-opus-5-5", "messages", "claude-code"))).toEqual([["claude", "claude-opus-5-5"]])
    f.paidOverflow = true
    expect(steps(route(f, "gpt-6-sol", "responses", "codex"))).toEqual([
      ["codex", "gpt-6-sol"],
      ["openai", "gpt-6-sol"],
    ])
    // With no subscription to back, a key serves directly.
    expect(steps(route(fixture([account("openai", "key")]), "gpt-6-sol", "responses", "codex"))).toEqual([
      ["openai", "gpt-6-sol"],
    ])
  })

  it("Claude's models serve Claude Code only, and never in another format", () => {
    const f = fixture([account("claude", "max"), account("anthropic", "ant")])
    const refused = route(f, "claude-opus-5-5", "messages")
    expect(refused).toMatchObject({ _tag: "Refused", provider: "claude", agent: "claude-code" })
    expect(refusedText("claude", "claude-code")).toBe("Claude serves Claude Code only")
    expect(route(f, "claude-opus-5-5", "chat", "claude-code")).toMatchObject({
      _tag: "Unserved",
      model: "claude-opus-5-5",
    })
  })

  it("models find their provider in the client's format, or one it can be translated into", () => {
    const f = fixture([
      account("codex", "chatgpt"),
      account("xai", "grok"),
      endpoint("local", "chat", ["qwen3-*"]),
      endpoint("kimi", "messages", ["kimi-*"]),
    ])
    expect(steps(route(f, "grok-4", "chat"))).toEqual([["xai", "grok-4"]])
    expect(steps(route(f, "qwen3-coder", "chat"))).toEqual([["compat", "qwen3-coder"]])
    // Claude Code may use another vendor's Messages endpoint.
    expect(steps(route(f, "kimi-k2", "messages", "claude-code"))).toEqual([["compat", "kimi-k2"]])
    // Codex sends models no provider claims to ChatGPT.
    expect(steps(route(f, "o5-mini", "responses", "codex"))).toEqual([["codex", "o5-mini"]])
    // Other formats reach ChatGPT by translation, but nothing is translated into Messages.
    expect(steps(route(f, "gpt-6-sol", "messages", "claude-code"))).toEqual([["codex", "gpt-6-sol"]])
    expect(steps(route(f, "gpt-6-sol", "chat"))).toEqual([["codex", "gpt-6-sol"]])
    expect(route(f, "kimi-k2", "chat")).toMatchObject({ _tag: "Unserved", model: "kimi-k2" })
    expect(route(f, "nope", "chat")).toMatchObject({ _tag: "Unserved", model: "nope" })
  })

  it("selectors pick a provider or one account, aliases rename, and fallbacks follow", () => {
    const work = account("codex", "work")
    // Real ids are a provider and 8 hex digits; this one names no model pattern.
    const home = new Account({ ...account("codex", "home"), id: AccountId.make("chatgpt-1a2b3c4d") })
    const f = fixture([work, home, account("openai", "key"), endpoint("router", "chat", ["qwen/*"])])
    // A provider selector opts into a key for one request.
    expect(steps(route(f, "openai/gpt-6-sol", "responses", "codex"))).toEqual([["openai", "gpt-6-sol"]])
    // An account selector, by label, id or email, pins one account.
    for (const name of ["home", home.id, "home@x.dev"]) {
      const picked = route(f, `${name}/gpt-6-sol`, "responses", "codex")
      expect(picked._tag === "Steps" ? picked.steps.map((step) => step.accounts) : picked).toEqual([[home.id]])
    }
    // A selector for a provider without accounts serves nothing.
    expect(route(f, "xai/grok-4", "chat")).toMatchObject({ _tag: "Unserved", model: "xai/grok-4" })
    // A model id with a slash stays a model when an account serves it.
    expect(steps(route(f, "qwen/qwen3-coder", "chat"))).toEqual([["compat", "qwen/qwen3-coder"]])
    f.aliases = { fast: "gpt-6-sol-mini", chain: "fast" }
    f.fallbacks = { "gpt-6-sol": ["openai/gpt-6-sol"] }
    expect(steps(route(f, "fast", "responses", "codex"))).toEqual([["codex", "gpt-6-sol-mini"]])
    // Aliases go one level only.
    expect(steps(route(f, "chain", "responses", "codex"))).toEqual([["codex", "fast"]])
    expect(steps(route(f, "gpt-6-sol", "responses", "codex"))).toEqual([
      ["codex", "gpt-6-sol"],
      ["openai", "gpt-6-sol"],
    ])
  })

  it("fallbacks are found by the client's name or the alias target, skip the path's provider, and repeat no step", () => {
    const f = fixture([account("codex", "work"), account("openai", "key")])
    f.aliases = { best: "gpt-6-sol" }
    f.fallbacks = { "gpt-6-sol": ["gpt-6-sol", "openai/gpt-6-sol", "unclaimed"] }
    // The path's provider takes unclaimed models only for the first model, not a fallback.
    expect(steps(route(f, "best", "responses", "codex"))).toEqual([
      ["codex", "gpt-6-sol"],
      ["openai", "gpt-6-sol"],
    ])
  })

  it("a request with neither a model nor a path's provider names no model", () => {
    expect(plan(tableOf(fixture([])), { dialect: "chat" })).toMatchObject({ _tag: "NoModel" })
    // The path's provider serves a request without a model.
    const f = fixture([account("codex", "work")])
    expect(steps(plan(tableOf(f), { dialect: "responses", agent: "codex", pathProvider: "codex" }))).toEqual([
      ["codex", ""],
    ])
  })

  it("the first refusal seen explains a plan with no step left", () => {
    const f = fixture([account("claude", "max"), account("codex", "work")])
    f.fallbacks = { "claude-opus-5-5": ["gpt-6-sol"] }
    // Claude refuses Codex, but the fallback serves it.
    expect(steps(route(f, "claude-opus-5-5", "responses", "codex"))).toEqual([["codex", "gpt-6-sol"]])
    f.fallbacks = {}
    expect(route(f, "claude-opus-5-5", "responses", "codex")).toMatchObject({ _tag: "Refused", provider: "claude" })
  })
})

const ask = (model: string): Ask => ({ model, dialect: "responses", agent: "codex", pathProvider: "codex" })

describe("the planner", () => {
  it("remembers each ask's plan and forgets the oldest past its capacity", () => {
    const f = fixture([account("codex", "work")])
    const plans = planner(tableOf(f), 2)
    const first = plans(ask("a"))
    expect(plans(ask("a"))).toBe(first)
    plans(ask("b"))
    plans(ask("c"))
    expect(plans(ask("a"))).not.toBe(first)
    expect(plans(ask("a"))).toEqual(first)
  })
})
