import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Effect, Layer, Option, Result } from "effect"
import { TestClock } from "effect/testing"
import type { Account } from "../../src/account.ts"
import { Accounts } from "../../src/accounts.ts"
import { discover, type Found, parseSource, priorityOf, save } from "../../src/importers.ts"
import { json, jwt, mockUpstream, reply, storeLayer } from "../providers/support.ts"
import { recordingSpawner, type Script } from "../service/recording-spawner.ts"

const user = "/home/me"
const authClaim = "https://api.openai.com/auth"

/** Anthropic's profile for the token `live` (else 401), and its token endpoint renewing `rt`. */
const anthropic = () =>
  mockUpstream((seen) => {
    if (seen.url.pathname === "/api/oauth/profile") {
      return seen.headers.get("authorization") === "Bearer live"
        ? json(200, {
            account: { uuid: "acct-cc", email: "cc@x.dev" },
            organization: { uuid: "org-cc", organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
          })
        : reply(401)
    }
    if (seen.url.pathname === "/v1/oauth/token") return json(200, { access_token: "live", expires_in: 28_800 })
    return reply(404)
  })

/** A home whose tools left these files, with an upstream and a keychain. */
const machine = (files: Record<string, string>, keychain: Script = () => ({ code: 44 })) => {
  const api = anthropic()
  const spawner = recordingSpawner(keychain)
  const layer = Layer.mergeAll(storeLayer(api.layer, {}, { files, directories: [user] }), spawner.layer)
  return { api, calls: spawner.calls, layer }
}

const accountOf = (found: Found | undefined): Account => {
  if (found === undefined) throw new Error("nothing found")
  return Result.getOrThrowWith(found.account, (error) => new Error(error.message))
}

/** Why a found login could not be brought over, as its tagged error says. */
const failureOf = (
  item: { readonly account: Result.Result<unknown, { readonly _tag: string; readonly message: string }> } | undefined,
) =>
  item !== undefined && Result.isFailure(item.account)
    ? { tag: item.account.failure._tag, message: item.account.failure.message }
    : undefined

const linkOf = (account: Account) => (account.credential._tag === "OAuth" ? account.credential.follows : undefined)

describe("importing logins", () => {
  it("names the sources it reads", () => {
    expect(parseSource("all")).toEqual(Result.succeed("all"))
    expect(parseSource("claude-code")).toEqual(Result.succeed("claude-code"))
    expect(Result.mapError(parseSource("nowhere"), (error) => error.message)).toEqual(
      Result.fail(`unknown source "nowhere"`),
    )
    expect(priorityOf("3")).toBe(3)
    expect(priorityOf(2)).toBe(2)
    expect(priorityOf("high")).toBe(0)
    expect(priorityOf(undefined)).toBe(0)
  })

  it.effect("finds nothing where no tool has signed in, asking the macOS keychain for Claude Code's", () => {
    const home = machine({})
    return Effect.gen(function* () {
      expect(yield* discover("all", { platform: "darwin" })).toEqual([])
      expect(home.calls.map((call) => call.line)).toEqual([
        "security find-generic-password -s Claude Code-credentials -w",
      ])
      expect(yield* discover("all", { platform: "linux" })).toEqual([])
      expect(home.calls).toHaveLength(1)
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("reads CLIProxyAPI's logins, linked to their files, skipping other kinds and what is not a login", () => {
    const dir = `${user}/.cli-proxy-api`
    const home = machine({
      [`${dir}/claude-a.json`]: JSON.stringify({
        type: "claude",
        access_token: "sk-ant-oat01-x",
        refresh_token: "sk-ant-ort01-y",
        expired: "1969-12-31T00:00:00Z",
        email: "me@x.dev",
        account_uuid: "acct",
        organization_uuid: "org-1",
        organization_name: "Org",
        claude_device_ids: ["abc"],
        priority: "3",
        disabled: false,
      }),
      [`${dir}/codex-b.json`]: JSON.stringify({
        type: "codex",
        access_token: "not-a-jwt",
        account_id: "ws-9",
        email: "c@x.dev",
        plan_type: "pro",
        label: "cpa-b",
        expired: "1969-12-31T00:00:00+08:00",
      }),
      [`${dir}/xai-c.json`]: `{"type":"xai"}`,
      [`${dir}/broken.json`]: "{",
      [`${dir}/empty.json`]: `{"type":"codex"}`,
      [`${dir}/config.yaml`]: "port: 1",
    })
    return Effect.gen(function* () {
      const found = yield* discover("cliproxyapi")
      expect(found.map((item) => item.origin)).toEqual([
        `${dir}/claude-a.json`,
        `${dir}/codex-b.json`,
        `${dir}/empty.json`,
      ])
      const claude = accountOf(found[0])
      expect(claude.provider).toBe("claude")
      expect(claude.identity).toMatchObject({ orgId: "org-1", accountId: "acct", orgName: "Org", email: "me@x.dev" })
      expect(linkOf(claude)).toMatchObject({ tool: "cliproxyapi", path: `${dir}/claude-a.json` })
      expect(claude.priority).toBe(3)
      expect(claude.disabled).toBe(false)
      const codex = accountOf(found[1])
      expect(codex.identity).toMatchObject({ accountId: "ws-9", plan: "pro", email: "c@x.dev" })
      expect(codex.label).toBe("cpa-b")
      expect(Option.getOrThrow(codex.tokens).isExpired(yield* DateTime.now)).toBe(true)
      expect(failureOf(found[2])).toEqual({ tag: "ImportFailed", message: "no access token" })
      // The Claude token had expired, so its profile was not asked for.
      expect(home.api.seen).toHaveLength(0)
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("fills a live CLIProxyAPI Claude login from its profile", () => {
    const home = machine({
      [`${user}/.cli-proxy-api/claude.json`]: JSON.stringify({
        type: "claude",
        access_token: "live",
        expired: "2099-01-01T00:00:00Z",
      }),
    })
    return Effect.gen(function* () {
      const account = accountOf((yield* discover("cliproxyapi"))[0])
      expect(account.identity).toMatchObject({ email: "cc@x.dev", orgId: "org-cc", plan: "max 5x" })
      expect(account.id).toMatch(/^claude-[0-9a-f]{8}$/)
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("imports Claude Code's login with its profile, renewing an expired token first", () => {
    const home = machine({
      [`${user}/.claude/.credentials.json`]: JSON.stringify({
        claudeAiOauth: { accessToken: "old", refreshToken: "rt", expiresAt: 1_000 },
      }),
    })
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-07T00:00:00Z"))
      const [found] = yield* discover("claude-code", { platform: "darwin" })
      expect(found?.origin).toBe(`${user}/.claude/.credentials.json`)
      const account = accountOf(found)
      expect(account.secret).toBe("live")
      expect(account.identity).toMatchObject({ email: "cc@x.dev", orgId: "org-cc", plan: "max 5x" })
      expect(linkOf(account)).toBeUndefined()
      // A credentials file is there, so the keychain is never asked.
      expect(home.calls).toHaveLength(0)
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("skips an expired Claude Code login that nothing can renew, without the network or the keychain", () => {
    const home = machine({
      [`${user}/.claude/.credentials.json`]: JSON.stringify({
        claudeAiOauth: { accessToken: "old", expiresAt: 1_000 },
      }),
    })
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-07T00:00:00Z"))
      const [found] = yield* discover("all", { platform: "darwin" })
      expect(failureOf(found)).toEqual({ tag: "ImportFailed", message: "login expired; log in again" })
      expect(home.calls).toHaveLength(0)
      expect(home.api.seen).toHaveLength(0)
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("reads Claude Code's login from the macOS keychain when it has no credentials file", () => {
    const home = machine({}, (program) =>
      program === "security"
        ? { stdout: `${JSON.stringify({ claudeAiOauth: { accessToken: "live", expiresAt: 9_999_999_999_999 } })}\n` }
        : "missing",
    )
    return Effect.gen(function* () {
      const [found] = yield* discover("claude-code", { platform: "darwin" })
      expect(found?.origin).toBe("the macOS keychain")
      expect(accountOf(found).identity.email).toBe("cc@x.dev")
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("imports the Codex login, named by its claims", () => {
    const home = machine({
      [`${user}/.codex/auth.json`]: JSON.stringify({
        tokens: {
          id_token: jwt({ email: "me@x.dev", [authClaim]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus" } }),
          access_token: jwt({ exp: 1_900_000_000 }),
          refresh_token: "rt",
        },
        last_refresh: "2026-10-01T00:00:00Z",
      }),
    })
    return Effect.gen(function* () {
      const [found] = yield* discover("codex")
      expect(found?.origin).toBe(`${user}/.codex/auth.json`)
      const account = accountOf(found)
      expect(account.identity).toMatchObject({ email: "me@x.dev", plan: "plus", accountId: "ws-1" })
      const tokens = Option.getOrThrow(account.tokens)
      expect(tokens.expiresAt).toEqual(DateTime.makeUnsafe(1_900_000_000_000))
      expect(tokens.refreshedAt).toEqual(DateTime.makeUnsafe(Date.parse("2026-10-01T00:00:00Z")))
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("reports a Codex login that is an API key instead of a ChatGPT sign-in", () => {
    const home = machine({ [`${user}/.codex/auth.json`]: JSON.stringify({ OPENAI_API_KEY: "sk" }) })
    return Effect.gen(function* () {
      const [found] = yield* discover("codex")
      expect(failureOf(found)).toEqual({
        tag: "ImportFailed",
        message: "not a ChatGPT login (an API key or proxy auth)",
      })
    }).pipe(Effect.provide(home.layer))
  })

  it.effect("saves what it found, merging a second import into the same accounts, and stops following with own", () => {
    const dir = `${user}/.cli-proxy-api`
    const home = machine({
      [`${dir}/codex-a.json`]: JSON.stringify({
        type: "codex",
        access_token: "tok-a",
        refresh_token: "ref-a",
        email: "a@x.dev",
        account_id: "ws-a",
        plan_type: "plus",
        label: "cpa-a",
        priority: "2",
      }),
      [`${dir}/empty.json`]: `{"type":"codex"}`,
    })
    return Effect.gen(function* () {
      const accounts = yield* Accounts
      const first = yield* save(yield* discover("cliproxyapi"), false)
      expect(first.map((item) => Result.isSuccess(item.account))).toEqual([true, false])
      expect(failureOf(first[1])).toEqual({ tag: "ImportFailed", message: "no access token" })
      const [saved] = yield* accounts.list
      expect(saved?.priority).toBe(2)
      expect(saved === undefined ? undefined : linkOf(saved)).toBeDefined()

      const again = yield* save(yield* discover("cliproxyapi"), true)
      expect(
        Option.map(Option.fromUndefinedOr(again[0]), (item) => Result.map(item.account, (result) => result.isNew)),
      ).toEqual(Option.some(Result.succeed(false)))
      const list = yield* accounts.list
      expect(list).toHaveLength(1)
      expect(list[0] === undefined ? "missing" : linkOf(list[0])).toBeUndefined()
    }).pipe(Effect.provide(home.layer))
  })
})
