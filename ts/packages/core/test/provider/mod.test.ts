import { describe, expect } from "bun:test"

import { it } from "@slopmax/test"
import { Effect, Result, Schema } from "effect"

import { Client } from "@slopmax/net"
import type { json } from "@slopmax/wire"

import { Account, Tokens } from "../../src/account.ts"
import { PROVIDERS } from "../../src/index.ts"
import { Refusal } from "../../src/limits.ts"
import { Credential, matches, ProviderId, ProviderIdSchema, Spec, usageBody, Verdict } from "../../src/provider/mod.ts"
import { json as reply, Mock, noEnv, reply as text } from "../../src/testkit.ts"

describe("provider", () => {
  it("patterns_match_with_wildcards", () => {
    expect(matches("claude-*", "claude-opus-5-5")).toBe(true)
    expect(matches("claude-*", "gpt-6-sol")).toBe(false)
    expect(matches("gpt-*", "gpt-6-sol")).toBe(true)
    expect(matches("o3*", "o3")).toBe(true)
    expect(matches("*-coder", "qwen3-coder")).toBe(true)
    expect(matches("a*b*c", "a-x-b-y-c")).toBe(true)
    expect(matches("a*b*c", "a-x-c")).toBe(false)
    expect(matches("exact", "exact")).toBe(true)
    expect(matches("exact", "exactly")).toBe(false)
    expect(matches("*", "anything")).toBe(true)
  })

  it("registry_ids_are_unique_and_round_trip", () => {
    expect(PROVIDERS.map((p) => p.spec.id)).toEqual([...ProviderId.ALL])
    for (const provider of ProviderId.ALL) {
      expect(ProviderId.parse(ProviderId.asStr(provider))).toEqual(Result.succeed(provider))
      expect(JSON.stringify(Schema.encodeSync(ProviderIdSchema)(provider))).toBe(`"${provider}"`)
    }
    // Metered providers back up a subscription, never another key.
    for (const provider of ProviderId.ALL) {
      const billing = ProviderId.spec(provider).billing
      if (billing._tag === "Metered" && billing.backs !== undefined) {
        expect(Spec.isSubscription(ProviderId.spec(billing.backs))).toBe(true)
      }
    }
  })

  it("unknown_ids_list_the_known_ones", () => {
    expect(ProviderId.parse("grok")).toEqual(
      Result.fail('expected one of claude, codex, anthropic, openai, xai, compat, got "grok"'),
    )
  })

  it("edge_patterns", () => {
    expect(matches("", "")).toBe(true)
    expect(matches("", "x")).toBe(false)
    expect(matches("a*", "a")).toBe(true)
    expect(matches("*abc", "bc")).toBe(false)
    expect(matches("*", "")).toBe(true)
    // A trailing part may not overlap a middle one.
    expect(matches("ab*b*ab", "abab")).toBe(false)
  })

  it("specs_say_how_accounts_sign_in_and_pay", () => {
    expect(Spec.isSubscription(ProviderId.spec("claude"))).toBe(true)
    expect(Spec.isSubscription(ProviderId.spec("openai"))).toBe(false)
    expect(Spec.deviceLogin(ProviderId.spec("codex"))).toBe(true)
    expect(Spec.deviceLogin(ProviderId.spec("compat"))).toBe(false)
    expect(ProviderId.spec("compat").credential).toEqual(Credential.Key(true))
    expect(ProviderId.asStr("xai")).toBe("xai")
  })

  it("refusals_become_verdicts", () => {
    const at = 5_000_000
    expect(Verdict.fromRefusal(Refusal.Exhausted(at, "m"))).toEqual(Verdict.Exhausted(at, "m"))
    expect(Verdict.fromRefusal(Refusal.Throttled(at))).toEqual(Verdict.Throttled(at))
    expect(Verdict.ofStatus(404)).toEqual(Verdict.Final)
  })

  it.effect("subscriptions_without_a_catalog_list_nothing", () =>
    Effect.gen(function* () {
      const account = Account.make("claude", Tokens.empty(), 0)
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      const claude = ProviderId.get("claude")
      expect(yield* claude.catalog(http, account, "")).toEqual([])
      expect(claude.rebind(new TextEncoder().encode("{}"))).toBeUndefined()
      const body: json.Json = { max_tokens: 1 }
      claude.shape("messages", body)
      expect(body).toEqual({ max_tokens: 1 })
    }),
  )
})

const row = (id: ProviderId) => {
  const s = ProviderId.spec(id)
  return [s.title, s.api, s.dialects, s.models, s.billing, s.agentOnly, s.refreshLead, s.credential]
}

describe("provider, beyond the Rust tests", () => {
  it("the Spec table", () => {
    expect(row("claude")).toEqual([
      "Claude",
      "https://api.anthropic.com",
      ["messages"],
      ["claude-*"],
      { _tag: "Subscription" },
      "claude",
      3_600_000,
      Credential.OAuth(false),
    ])
    expect(row("codex")).toEqual([
      "ChatGPT",
      "https://chatgpt.com/backend-api/codex",
      ["responses"],
      ["gpt-*", "codex-*", "o1*", "o3*", "o4*"],
      { _tag: "Subscription" },
      undefined,
      86_400_000,
      Credential.OAuth(true),
    ])
    expect(row("anthropic")).toEqual([
      "Anthropic API",
      "https://api.anthropic.com",
      ["messages"],
      ["claude-*"],
      { _tag: "Metered", backs: "claude" },
      "claude",
      0,
      Credential.Key(false),
    ])
    expect(row("openai")).toEqual([
      "OpenAI API",
      "https://api.openai.com/v1",
      ["responses", "chat"],
      ["gpt-*", "codex-*", "o1*", "o3*", "o4*"],
      { _tag: "Metered", backs: "codex" },
      undefined,
      0,
      Credential.Key(false),
    ])
    expect(row("xai")).toEqual([
      "xAI API",
      "https://api.x.ai/v1",
      ["chat"],
      ["grok-*"],
      { _tag: "Metered", backs: undefined },
      undefined,
      0,
      Credential.Key(false),
    ])
    expect(row("compat")).toEqual([
      "Compatible API",
      "",
      [],
      [],
      { _tag: "Metered", backs: undefined },
      undefined,
      0,
      Credential.Key(true),
    ])
    expect(ProviderId.ALL.toSorted(ProviderId.compare)).toEqual([...ProviderId.ALL])
    expect(Verdict.ofStatus(401)).toEqual(Verdict.Unauthorized)
    expect(Verdict.ofStatus(403)).toEqual(Verdict.Forbidden)
  })

  it.effect("the trait's defaults", () =>
    Effect.gen(function* () {
      const key = ProviderId.get("openai")
      const account = Account.make("openai", { accessToken: "sk" }, 0)
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      expect((yield* Effect.flip(key.refresh(http, "rt"))).message).toBe(
        "OpenAI API keys cannot be refreshed; log in again",
      )
      expect((yield* Effect.flip(key.usage(http, account))).message).toBe("OpenAI API has no usage windows")
      expect(yield* key.identify(http, account)).toEqual(account)
      expect(key.api(account)).toBe("https://api.openai.com/v1")
      expect(key.dialects(account)).toEqual(["responses", "chat"])
      expect([key.serves(account, "gpt-6-sol"), key.serves(account, "claude-x")]).toEqual([true, false])
      expect(key.limits(new Headers(), 0)).toBeUndefined()
      expect(key.credits()).toBeUndefined()
      const headers = new Headers({ a: "1" })
      key.showPool([], headers)
      expect(headers.get("a")).toBe("1")
    }),
  )

  it.live("usage bodies: 401 asks for a refresh; other failures carry the start of the body", () =>
    Effect.gen(function* () {
      const long = "x".repeat(300)
      const mock = yield* Mock.start((seen) => {
        if (seen.path === "/401") return text(401, "")
        if (seen.path === "/500") return text(500, long)
        if (seen.path === "/html") return text(200, "<html>")
        return reply(200, { ok: true })
      })
      const http = yield* mock.client([])
      const body = (path: string) => Effect.flatMap(Effect.orDie(http.get(`${mock.url}${path}`).send()), usageBody)
      expect((yield* Effect.flip(body("/401")))._tag).toBe("Unauthorized")
      const failed = yield* Effect.flip(body("/500"))
      expect(failed.message).toBe(`usage endpoint returned 500 Internal Server Error: ${"x".repeat(200)}`)
      expect((yield* Effect.flip(body("/html")))._tag).toBe("Failure")
      expect(yield* body("/ok")).toEqual({ ok: true })
    }),
  )
})
