import { describe, expect, it as plain } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Cause, Effect, Fiber, Queue } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"

import { Account, Store, Tokens } from "../../src/account.ts"
import { connect, ensureFresh } from "../../src/auth/connect.ts"
import { Grant, httpClient, type LoginEvent, LoginOptions, Prompt, RefreshError } from "../../src/auth/mod.ts"
import { json, Mock, noEnv, reply, Seen } from "../../src/testkit.ts"
import { CLIENT_ID } from "../../src/provider/claude/oauth.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { tempDirs } from "../support/temp.ts"

/** Where Claude's token and profile calls go. */
const CLAUDE = ["https://platform.claude.com", "https://api.anthropic.com"]

const http = () => httpClient(new Origins()).pipe(Effect.provide(noEnv))

const claudeAccount = (access: string, refresh: string | undefined, expiresIn: number): Account => {
  const now = Timestamp.nowUnsafe()
  const account = Account.make(
    "claude",
    {
      accessToken: access,
      ...(refresh === undefined ? {} : { refreshToken: refresh }),
      expiresAt: Timestamp.add(now, SignedDuration.fromSecs(expiresIn)),
    },
    now,
  )
  return Account.assignId({ ...account, orgId: "org-1" })
}

const tempDir = tempDirs()

const store = (): Store => Store.at(join(tempDir("auth"), "accounts"))

/** Anthropic's token endpoint answering `status` and `token`, and its profile endpoint naming a Max 5x plan. */
const anthropic = (status: number, token: unknown) =>
  Mock.start((seen) => {
    switch (Seen.route(seen)) {
      case "/v1/oauth/token":
        return json(status, token)
      case "/api/oauth/profile":
        return json(200, {
          account: { uuid: "acct-1", email: "me@x.dev" },
          organization: {
            uuid: "org-1",
            organization_type: "claude_max",
            rate_limit_tier: "default_claude_max_5x",
          },
        })
      default:
        return reply(404, "")
    }
  })

const writeSource = (dir: string, token: string, expired: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "claude-x.json"),
    JSON.stringify({ type: "claude", access_token: token, refresh_token: "rt", expired }),
  )
}

const linked = (dir: string, tool: string, access: string): Account => ({
  ...claudeAccount(access, "rt", 3600 * 4),
  link: { tool, path: join(dir, "claude-x.json") },
})

const revoked = (status: number, body: string) => RefreshError.classify(status, body)._tag === "Revoked"

describe("auth", () => {
  it.live("linked_accounts_follow_their_source", () =>
    Effect.gen(function* () {
      const dir = tempDir("link")
      const accounts = Store.at(join(dir, "accounts"))
      writeSource(dir, "old", "2000-01-01T00:00:00Z")
      const parsed = Timestamp.parse("2000-01-01T00:00:00Z")
      const expiresAt = parsed._tag === "Success" ? parsed.success : 0
      const account: Account = {
        ...Account.assignId({
          ...Account.make("claude", { accessToken: "old", refreshToken: "rt", expiresAt }, 0),
          orgId: "org",
        }),
        link: { tool: "cliproxyapi", path: join(dir, "claude-x.json") },
      }
      yield* accounts.save(account)
      const client = yield* http()

      // Not rotated yet: slopmax waits for the source rather than refreshing.
      const waiting = yield* Effect.flip(ensureFresh(client, accounts, account, false))
      expect(waiting._tag).toBe("Transient")

      writeSource(dir, "new", "2099-01-01T00:00:00Z")
      const fresh = yield* ensureFresh(client, accounts, account, false)
      expect(fresh.tokens.accessToken).toBe("new")
      const saved = yield* accounts.get(account.id)
      expect(saved?.tokens.accessToken).toBe("new")
      expect(saved?.link).toBeDefined()
    }),
  )

  plain("classifies_refresh_failures", () => {
    expect(revoked(400, '{"error": "invalid_grant"}')).toBe(true)
    expect(revoked(401, '{"error":{"code":"token_expired"}}')).toBe(true)
    expect(revoked(400, '{"error":{"code":"refresh_token_reused"}}')).toBe(true)
    expect(revoked(429, "slow down")).toBe(false)
    expect(revoked(502, "invalid_grant")).toBe(false)
    expect(revoked(400, "malformed")).toBe(false)
  })

  it.live("fresh_tokens_are_used_without_a_refresh", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, {})
      const account = claudeAccount("live", "rt", 2 * 3600)
      const got = yield* ensureFresh(yield* mock.client(CLAUDE), store(), account, false)
      expect(got.tokens.accessToken).toBe("live")
      expect(mock.seen()).toEqual([])
    }),
  )

  it.live("due_tokens_are_refreshed_identified_and_saved", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, { access_token: "new", refresh_token: "rt2", expires_in: 28800 })
      const accounts = store()
      const account: Account = { ...claudeAccount("old", "rt1", 600), authError: "earlier failure" }
      yield* accounts.save(account)

      const got = yield* ensureFresh(yield* mock.client(CLAUDE), accounts, account, false)
      expect(got.tokens.accessToken).toBe("new")
      expect(got.tokens.refreshToken).toBe("rt2")
      const left = Timestamp.durationSince(got.tokens.expiresAt ?? 0, Timestamp.nowUnsafe())
      expect(left).toBeGreaterThan(SignedDuration.fromHours(7))
      expect(got.tokens.refreshedAt).toBeDefined()
      expect(got.authError).toBeUndefined()
      expect(got.email).toBe("me@x.dev")
      expect(got.plan).toBe("max 5x")

      // Saved before it is handed out: the old refresh token is spent.
      const saved = yield* accounts.get(account.id)
      expect(saved?.tokens.accessToken).toBe("new")
      expect(saved?.tokens.refreshToken).toBe("rt2")
      expect(saved?.plan).toBe("max 5x")

      const sent = mock.seenAt("/v1/oauth/token")
      expect(sent.length).toBe(1)
      const body = sent[0] === undefined ? {} : (Seen.json(sent[0]) as Record<string, unknown>)
      expect(body.grant_type).toBe("refresh_token")
      expect(body.refresh_token).toBe("rt1")
      expect(body.client_id).toBe(CLIENT_ID)
      const profile = mock.seenAt("/api/oauth/profile")
      expect(profile[0] && Seen.header(profile[0], "authorization")).toBe("Bearer new")
      expect(profile[0] && Seen.header(profile[0], "anthropic-beta")).toBe("oauth-2025-04-20")
    }),
  )

  it.live("forced_refreshes_keep_tokens_the_provider_did_not_rotate", () =>
    Effect.gen(function* () {
      // No new refresh token, no expiry, and the profile lookup fails.
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/v1/oauth/token" ? json(200, { access_token: "new" }) : reply(500, "down"),
      )
      const accounts = store()
      const base = claudeAccount("old", "rt1", 6 * 3600)
      const account: Account = { ...base, tokens: { ...base.tokens, idToken: "id" }, email: "kept@x.dev" }
      const got = yield* ensureFresh(yield* mock.client(CLAUDE), accounts, account, true)
      expect(got.tokens.accessToken).toBe("new")
      expect(got.tokens.refreshToken).toBe("rt1")
      expect(got.tokens.idToken).toBe("id")
      expect(got.tokens.expiresAt).toBeUndefined()
      expect(got.email).toBe("kept@x.dev")
      // The account was not stored yet; refreshing saves it.
      expect(yield* accounts.get(account.id)).toBeDefined()
    }),
  )

  it.live("a_token_another_process_rotated_is_reused", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, { access_token: "unwanted" })
      const accounts = store()
      const stale = claudeAccount("old", "rt1", -60)
      const theirs: Account = {
        ...stale,
        tokens: {
          ...stale.tokens,
          accessToken: "theirs",
          expiresAt: Timestamp.add(Timestamp.nowUnsafe(), SignedDuration.fromHours(8)),
        },
      }
      yield* accounts.save(theirs)
      const got = yield* ensureFresh(yield* mock.client(CLAUDE), accounts, stale, false)
      expect(got.tokens.accessToken).toBe("theirs")
      expect(mock.seen()).toEqual([])
    }),
  )

  it.live("a_stored_copy_that_is_no_longer_due_is_not_refreshed", () =>
    Effect.gen(function* () {
      // Same token, but the stored copy says it was extended.
      const mock = yield* anthropic(200, { access_token: "unwanted" })
      const accounts = store()
      const stale = claudeAccount("same", "rt1", 60)
      const stored: Account = {
        ...stale,
        tokens: { ...stale.tokens, expiresAt: Timestamp.add(Timestamp.nowUnsafe(), SignedDuration.fromHours(8)) },
      }
      yield* accounts.save(stored)
      const got = yield* ensureFresh(yield* mock.client(CLAUDE), accounts, stale, false)
      expect(got.tokens.expiresAt).toBe(stored.tokens.expiresAt)
      expect(mock.seen()).toEqual([])
    }),
  )

  it.live("rejected_refresh_tokens_mark_the_account", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(400, { error: "invalid_grant" })
      const accounts = store()
      const account = claudeAccount("old", "rt1", 60)
      yield* accounts.save(account)
      const err = yield* Effect.flip(ensureFresh(yield* mock.client(CLAUDE), accounts, account, false))
      expect(err._tag).toBe("Revoked")
      expect(err.message.endsWith("; log in again")).toBe(true)
      const saved = yield* accounts.get(account.id)
      expect(saved?.authError).toContain("400")
      expect(saved?.tokens.accessToken).toBe("old")
    }),
  )

  it.live("passing_failures_leave_the_account_alone", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/v1/oauth/token" ? reply(503, "overloaded") : reply(404, ""),
      )
      const accounts = store()
      const account = claudeAccount("old", "rt1", 60)
      yield* accounts.save(account)
      const err = yield* Effect.flip(ensureFresh(yield* mock.client(CLAUDE), accounts, account, false))
      expect(err._tag).toBe("Transient")
      expect(err.message).toContain("503")
      expect((yield* accounts.get(account.id))?.authError).toBeUndefined()

      // A success that is not a token answer is passing too.
      const garbled = yield* Mock.start(() => reply(200, "<html>"))
      const again = yield* Effect.flip(ensureFresh(yield* garbled.client(CLAUDE), accounts, account, false))
      expect(again._tag).toBe("Transient")
    }),
  )

  it.live("unreachable_token_endpoints_are_passing_failures", () =>
    Effect.gen(function* () {
      const client = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([["https://platform.claude.com", "http://127.0.0.1:9"]]))
        .build()
        .pipe(Effect.provide(noEnv))
      const account = claudeAccount("old", "rt1", 60)
      const err = yield* Effect.flip(ensureFresh(client, store(), account, false))
      expect(err._tag).toBe("Transient")
    }),
  )

  it.live("accounts_without_a_refresh_token_must_log_in_again", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, {})
      const account = claudeAccount("old", undefined, 60)
      const err = yield* Effect.flip(ensureFresh(yield* mock.client(CLAUDE), store(), account, false))
      if (err._tag !== "Revoked") throw new Error("expected revoked")
      expect(err.reason).toBe("no refresh token stored")
      expect(mock.seen()).toEqual([])
    }),
  )

  it.live("api_keys_cannot_be_refreshed", () =>
    Effect.gen(function* () {
      const account = Account.make("openai", { accessToken: "sk", refreshToken: "rt" }, Timestamp.nowUnsafe())
      const err = yield* Effect.flip(ensureFresh(yield* http(), store(), account, true))
      expect(err.message).toBe("OpenAI API keys cannot be refreshed; log in again")
    }),
  )

  it.live("linked_accounts_wait_for_their_source_when_forced", () =>
    Effect.gen(function* () {
      const dir = tempDir("link-force")
      writeFileSync(
        join(dir, "claude-x.json"),
        JSON.stringify({ type: "claude", access_token: "same", refresh_token: "rt", expired: "2099-01-01T00:00:00Z" }),
      )
      const accounts = Store.at(join(dir, "accounts"))
      const account = linked(dir, "cliproxyapi", "same")
      yield* accounts.save(account)
      const client = yield* http()
      const err = yield* Effect.flip(ensureFresh(client, accounts, account, true))
      expect(err.message).toContain("cliproxyapi has not refreshed this login yet")
      expect(err.message).toBe("cliproxyapi has not refreshed this login yet (`slopmax own` lets slopmax refresh it)")

      // Due but not expired, for an account removed meanwhile: the copy in
      // hand serves until the source refreshes.
      const gone = Store.at(join(dir, "elsewhere"))
      const soon: Account = {
        ...account,
        tokens: {
          ...account.tokens,
          accessToken: "older",
          expiresAt: Timestamp.add(Timestamp.nowUnsafe(), SignedDuration.fromMins(30)),
        },
      }
      const got = yield* ensureFresh(client, gone, soon, false)
      expect(got.tokens.accessToken).toBe("older")
    }),
  )

  it.live("links_to_unknown_tools_fail_softly", () =>
    Effect.gen(function* () {
      const dir = tempDir("link-unknown")
      const account = linked(dir, "mystery", "x")
      const err = yield* Effect.flip(ensureFresh(yield* http(), store(), account, true))
      expect(err._tag).toBe("Transient")
      expect(err.message).toContain("cannot follow logins from mystery")
    }),
  )

  it.live("connect_signs_in_and_merges_repeat_logins", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/v1/models" && Seen.header(seen, "authorization") === "Bearer key-1"
          ? json(200, { data: [{ id: "qwen3-coder" }] })
          : reply(401, ""),
      )
      const accounts = store()
      const options = (key: string): LoginOptions => ({
        ...LoginOptions.default(),
        endpoint: { baseUrl: `${mock.url}/v1`, dialect: "chat", models: [] },
        key,
      })
      const [account, created] = yield* connect(
        accounts,
        "compat",
        "local",
        options("key-1"),
        Prompt.make(() => {}),
      )
      expect(created).toBe(true)
      expect(account.label).toBe("local")
      expect(account.endpoint?.models).toEqual(["qwen3-coder"])
      expect((yield* accounts.list()).length).toBe(1)

      const [again, createdAgain] = yield* connect(
        accounts,
        "compat",
        undefined,
        options("key-1"),
        Prompt.make(() => {}),
      )
      expect(createdAgain).toBe(false)
      expect(again.id).toBe(account.id)
      // The label set before is kept.
      expect(again.label).toBe("local")

      const err = yield* Effect.flip(
        connect(
          accounts,
          "compat",
          undefined,
          options("key-2"),
          Prompt.make(() => {}),
        ),
      )
      expect(err.message).toContain("rejected the key")
    }),
  )

  it.live("prompts_deliver_events_and_pasted_lines", () =>
    Effect.gen(function* () {
      const events: Array<LoginEvent> = []
      const bare = Prompt.make((e) => events.push(e))
      bare.tell({ _tag: "Notice", text: "hi" })
      expect(yield* bare.pasted).toBeUndefined()
      expect(events).toEqual([{ _tag: "Notice", text: "hi" }])
      expect(String(bare)).toBe("Prompt { pasted: false, .. }")

      const lines = yield* Queue.unbounded<string, Cause.Done>()
      const pasting = Prompt.make(() => {}).withPasted(lines)
      Queue.offerUnsafe(lines, "line")
      yield* Queue.end(lines)
      expect(yield* pasting.pasted).toBe("line")
      expect(yield* pasting.pasted).toBeUndefined()
      expect(String(pasting)).toContain("pasted: true")
    }),
  )

  plain("login_options_never_print_the_key", () => {
    const shown = LoginOptions.debug({ ...LoginOptions.default(), key: "sk-secret", noBrowser: true })
    expect(shown).not.toContain("sk-secret")
    expect(shown).toContain("<redacted>")
    expect(shown).toContain("no_browser: true")
  })

  plain("grants_become_tokens_stamped_now", () => {
    const now = Timestamp.fromSecond(1_000) ?? 0
    const tokens = Grant.intoTokens(
      { accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: Timestamp.add(now, SignedDuration.fromSecs(60)) },
      now,
    )
    expect(tokens.accessToken).toBe("a")
    expect(tokens.refreshToken).toBe("r")
    expect(tokens.idToken).toBe("i")
    expect(tokens.refreshedAt).toBe(now)
    expect(Tokens.isExpired(tokens, now)).toBe(false)
  })

  plain("refresh_errors_read_as_what_to_do", () => {
    expect(RefreshError.classify(401, "").message).toBe("refresh token rejected (401 Unauthorized); log in again")
    expect(RefreshError.classify(502, "upstream").message).toBe("token refresh failed (502 Bad Gateway): upstream")
  })
})

describe("auth, beyond the Rust tests", () => {
  it.live("a refresh the caller abandons still saves the rotated token", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, { access_token: "rotated", refresh_token: "rt2", expires_in: 28800 })
      const accounts = store()
      const account = claudeAccount("old", "rt1", 60)
      yield* accounts.save(account)
      const client = yield* mock.client(CLAUDE)
      const caller = yield* Effect.forkChild(ensureFresh(client, accounts, account, false))
      // The single-use refresh token has gone out; the caller gives up.
      while (mock.seenAt("/v1/oauth/token").length === 0) yield* Effect.sleep("1 millis")
      yield* Fiber.interrupt(caller)
      for (let i = 0; i < 100 && (yield* accounts.get(account.id))?.tokens.accessToken !== "rotated"; i++) {
        yield* Effect.sleep("10 millis")
      }
      expect((yield* accounts.get(account.id))?.tokens.refreshToken).toBe("rt2")
    }),
  )
})
