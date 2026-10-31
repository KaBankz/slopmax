import { describe, expect, it } from "bun:test"

import { Result } from "effect"

import { agents, sources, subscriptions } from "../../src/commands/init.ts"

const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(String(result.failure))
  return result.success
}

const error = <A>(result: Result.Result<A, { readonly message: string }>): string => {
  if (Result.isSuccess(result)) throw new Error("should fail")
  return result.failure.message
}

describe("commands/init", () => {
  it("lists_read_as_flags_give_them", () => {
    expect(ok(sources("claude-code, codex"))).toEqual(["claude-code", "codex"])
    expect(ok(sources("none"))).toEqual([])
    expect(Result.isFailure(sources("dropbox"))).toBe(true)
    expect(ok(subscriptions("claude,codex"))).toEqual(["claude", "codex"])
    expect(error(subscriptions("openai"))).toContain("--keys-from-env")
    expect(ok(agents("codex")).map((a) => a.id)).toEqual(["codex"])
    expect(ok(agents("none"))).toEqual([])
    expect(Result.isFailure(agents("cursor"))).toBe(true)
  })
})

describe("commands/init, beyond the Rust tests", () => {
  it("names what it refuses as the Rust does", () => {
    expect(error(sources("dropbox"))).toBe('unknown source "dropbox"')
    expect(error(subscriptions("nope"))).toBe(
      'expected one of claude, codex, anthropic, openai, xai, compat, got "nope"',
    )
    expect(error(subscriptions("xai"))).toBe(
      "--login signs in to subscriptions (claude, codex); add xai keys with --keys-from-env or `slopmax login xai`",
    )
    expect(error(agents("grok"))).toBe('unknown agent "grok"')
    expect(ok(sources(" , none,all"))).toEqual(["all"])
  })
})
