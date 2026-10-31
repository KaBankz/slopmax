import { describe, expect, it } from "bun:test"

import { Result } from "effect"

import type { Dialect } from "@slopmax/wire"

import { Account } from "../src/account.ts"
import type { ProviderId } from "../src/provider/mod.ts"
import { NoRoute, plan, type Request, type Table } from "../src/route.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"

const account = (provider: ProviderId, key: string): Account => ({
  ...Account.make(provider, { accessToken: key, refreshToken: key }, 0),
  label: key,
})

const compat = (label: string, dialect: Dialect, models: ReadonlyArray<string>): Account =>
  Account.assignId({ ...account("compat", label), endpoint: { baseUrl: `http://${label}/v1`, dialect, models } })

class Fixture {
  aliases: Record<string, string> = {}
  fallbacks: Record<string, ReadonlyArray<string>> = {}
  paidOverflow = false

  constructor(readonly accounts: ReadonlyArray<Account>) {}

  table(): Table {
    return {
      accounts: this.accounts,
      aliases: this.aliases,
      fallbacks: this.fallbacks,
      paidOverflow: this.paidOverflow,
    }
  }

  plan(model: string, dialect: Dialect, agent: string | undefined): Result.Result<Planned, NoRoute> {
    const fallback: ProviderId | undefined =
      dialect === "messages" ? "claude" : dialect === "responses" ? "codex" : undefined
    const request: Request = { model, dialect, agent, default: fallback }
    return Result.map(plan(this.table(), request), (steps) => steps.map((s) => [s.provider, s.model] as const))
  }
}

type Planned = Array<readonly [ProviderId, string]>

const ok = (...steps: Planned): Result.Result<Planned, NoRoute> => Result.succeed(steps)

describe("route", () => {
  it("subscriptions_come_first_and_keys_only_as_paid_overflow", () => {
    const f = new Fixture([
      account("codex", "chatgpt"),
      account("openai", "key"),
      account("claude", "max"),
      account("anthropic", "ant"),
    ])
    const codex = "codex"
    expect(f.plan("gpt-6-sol", "responses", codex)).toEqual(ok(["codex", "gpt-6-sol"]))
    expect(f.plan("claude-opus-5-5", "messages", "claude")).toEqual(ok(["claude", "claude-opus-5-5"]))
    f.paidOverflow = true
    expect(f.plan("gpt-6-sol", "responses", codex)).toEqual(ok(["codex", "gpt-6-sol"], ["openai", "gpt-6-sol"]))
    // Without a subscription to back up, a key serves directly.
    const keys = new Fixture([account("openai", "key")])
    expect(keys.plan("gpt-6-sol", "responses", codex)).toEqual(ok(["openai", "gpt-6-sol"]))
  })

  it("claude_models_serve_claude_code_only", () => {
    const f = new Fixture([account("claude", "max"), account("anthropic", "ant")])
    expect(f.plan("claude-opus-5-5", "messages", undefined)).toEqual(
      Result.fail(NoRoute.Refused("claude", "Claude Code")),
    )
    // And never in another format.
    expect(f.plan("claude-opus-5-5", "chat", "claude")).toEqual(Result.fail(NoRoute.Unserved("claude-opus-5-5")))
  })

  it("models_find_their_provider_in_the_clients_format", () => {
    const f = new Fixture([
      account("codex", "chatgpt"),
      account("xai", "grok"),
      compat("local", "chat", ["qwen3-*"]),
      compat("kimi", "messages", ["kimi-*"]),
    ])
    expect(f.plan("grok-4", "chat", undefined)).toEqual(ok(["xai", "grok-4"]))
    expect(f.plan("qwen3-coder", "chat", undefined)).toEqual(ok(["compat", "qwen3-coder"]))
    // Claude Code may use another vendor's Messages endpoint.
    expect(f.plan("kimi-k2", "messages", "claude")).toEqual(ok(["compat", "kimi-k2"]))
    // Codex sends unclaimed models to ChatGPT, as before routing.
    expect(f.plan("o5-mini", "responses", "codex")).toEqual(ok(["codex", "o5-mini"]))
    // Other formats reach ChatGPT by translation, never Messages APIs.
    expect(f.plan("gpt-6-sol", "messages", "claude")).toEqual(ok(["codex", "gpt-6-sol"]))
    expect(f.plan("gpt-6-sol", "chat", undefined)).toEqual(ok(["codex", "gpt-6-sol"]))
    expect(f.plan("kimi-k2", "chat", undefined)).toEqual(Result.fail(NoRoute.Unserved("kimi-k2")))
    expect(f.plan("nope", "chat", undefined)).toEqual(Result.fail(NoRoute.Unserved("nope")))
  })

  it("selectors_aliases_and_fallbacks", () => {
    const f = new Fixture([
      account("codex", "work"),
      account("codex", "home"),
      account("openai", "key"),
      compat("router", "chat", ["qwen/*"]),
    ])
    const codex = "codex"
    // A provider selector opts into a key for one request.
    expect(f.plan("openai/gpt-6-sol", "responses", codex)).toEqual(ok(["openai", "gpt-6-sol"]))
    // An account selector pins one account.
    const steps = plan(f.table(), { model: "home/gpt-6-sol", dialect: "responses", agent: codex, default: "codex" })
    expect(Result.getOrThrow(steps)[0]?.accounts).toEqual([f.accounts[1]?.id ?? ""])
    // A model id with a slash is a model when an account serves it.
    expect(f.plan("qwen/qwen3-coder", "chat", undefined)).toEqual(ok(["compat", "qwen/qwen3-coder"]))

    f.aliases.fast = "gpt-6-sol-mini"
    f.fallbacks["gpt-6-sol"] = ["openai/gpt-6-sol"]
    expect(f.plan("fast", "responses", codex)).toEqual(ok(["codex", "gpt-6-sol-mini"]))
    expect(f.plan("gpt-6-sol", "responses", codex)).toEqual(ok(["codex", "gpt-6-sol"], ["openai", "gpt-6-sol"]))
  })
})

describe("route, beyond the Rust tests", () => {
  it("fallbacks_dedupe_and_skip_the_path_default", () => {
    const f = new Fixture([account("codex", "chatgpt")])
    // The same step from a fallback is not tried twice.
    f.fallbacks["gpt-6-sol"] = ["gpt-6-sol", "fast"]
    f.aliases.fast = "gpt-6-sol"
    expect(f.plan("gpt-6-sol", "responses", "codex")).toEqual(ok(["codex", "gpt-6-sol"]))
    // The path's provider takes unclaimed models for the first model only.
    f.fallbacks["o5-mini"] = ["o6-mini"]
    expect(f.plan("o5-mini", "responses", "codex")).toEqual(ok(["codex", "o5-mini"]))
    // A model and its fallbacks that no one serves are unserved under the client's name.
    f.aliases.nope = "nada"
    expect(f.plan("nope", "chat", undefined)).toEqual(Result.fail(NoRoute.Unserved("nope")))
  })

  it("a_provider_selector_with_no_accounts_is_no_step", () => {
    const f = new Fixture([account("codex", "chatgpt")])
    expect(f.plan("openai/gpt-6-sol", "chat", undefined)).toEqual(Result.fail(NoRoute.Unserved("openai/gpt-6-sol")))
    // A prototype key is not an alias.
    expect(f.plan("constructor", "chat", undefined)).toEqual(Result.fail(NoRoute.Unserved("constructor")))
  })
})
