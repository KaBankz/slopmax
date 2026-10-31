import { describe, expect, it as plain } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { accountFrom, ClaudeCode, type SavedLogin } from "../../src/agent/claude-code.ts"
import { Config } from "../../src/config.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { json, Mock, reply, Seen } from "../../src/testkit.ts"
import { tempDirs } from "../support/temp.ts"

const tempDir = tempDirs()

const config = (): Config => ({ ...Config.default(), apiKey: "sm-test" })

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const ua = (value: string) => new Headers({ "user-agent": value })

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"))

const ORIGINS = ["https://platform.claude.com", "https://api.anthropic.com"]

const anthropic = () =>
  Mock.start((seen) => {
    const route = Seen.route(seen)
    const auth = Seen.header(seen, "authorization")
    if (route === "/v1/oauth/token") return json(200, { access_token: "fresh-access", expires_in: 3600 })
    if (route === "/api/oauth/profile" && (auth === "Bearer fresh-access" || auth === "Bearer live-access")) {
      return json(200, {
        account: { uuid: "acct-1", email: "me@x.com" },
        organization: { uuid: "org-1", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
      })
    }
    return reply(401, "")
  })

const login = (access: string, refresh: string | undefined, expiresInSecs: number): SavedLogin => ({
  accessToken: access,
  ...(refresh === undefined ? {} : { refreshToken: refresh }),
  expiresAt: Timestamp.asMillisecond(Timestamp.add(Timestamp.nowUnsafe(), SignedDuration.fromSecs(expiresInSecs))),
})

describe("agent/claude_code", () => {
  plain("session_id_comes_from_header_then_metadata", () => {
    const headers = new Headers()
    const body = bytes('{"metadata":{"user_id":"{\\"session_id\\":\\"from-body\\"}"}}')
    expect(ClaudeCode.session(headers, body)).toBe("from-body")
    headers.set("x-claude-code-session-id", "from-header")
    expect(ClaudeCode.session(headers, body)).toBe("from-header")
    const legacy = bytes('{"metadata":{"user_id":"user_abc_account_def_session_s-1"}}')
    expect(ClaudeCode.session(new Headers(), legacy)).toBe("s-1")
  })

  plain("detects_every_claude_code_entrypoint", () => {
    expect(ClaudeCode.detect(ua("claude-cli/2.1.287 (external, cli)"))).toBe(true)
    expect(ClaudeCode.detect(ua("claude-cli/2.1.287 (external, sdk-ts, agent-sdk/0.3.1)"))).toBe(true)
    expect(ClaudeCode.detect(ua("claude-code/2.1.287"))).toBe(true)
    expect(ClaudeCode.detect(ua("OpenAI/Python 2.4.0"))).toBe(false)
    expect(ClaudeCode.detect(new Headers())).toBe(false)
  })

  plain("env_points_at_the_proxy", () => {
    const script = ClaudeCode.env(config(), "slopmax")
    expect(script).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:7567")
    expect(script).toContain("export ANTHROPIC_AUTH_TOKEN=sm-test")
    expect(script).toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1")
    expect(script).toContain("unset ANTHROPIC_API_KEY")
  })

  it.live("setup_round_trips_and_keeps_other_settings", () =>
    Effect.gen(function* () {
      const file = join(tempDir("claude-code"), "settings.json")
      const original = {
        theme: "auto",
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_API_KEY: "sk-x", OTHER: "1" },
      }
      writeFileSync(file, JSON.stringify(original))

      const saved = yield* ClaudeCode.setup(config(), file, undefined)
      const wired = readJson(file) as { theme: string; env: Record<string, string> }
      expect(wired.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7567")
      expect(wired.env.ANTHROPIC_AUTH_TOKEN).toBe("sm-test")
      expect(wired.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(wired.env.OTHER).toBe("1")
      expect(wired.theme).toBe("auto")

      // A second setup keeps the original backup.
      const again = yield* ClaudeCode.setup(config(), file, saved)
      expect(again).toEqual(saved)
      if (again === undefined) throw new Error("setup saved nothing")
      yield* ClaudeCode.undo(file, again)
      expect(readJson(file)).toEqual(original)
    }),
  )

  plain("the_command_runs_claude_through_the_proxy_without_an_api_key", () => {
    const command = ClaudeCode.command(config(), ["-p", "hi"])
    expect(command.program).toBe("claude")
    expect(command.args).toEqual(["-p", "hi"])
    expect(command.envRemove).toContain("ANTHROPIC_API_KEY")
    expect(command.env.ANTHROPIC_AUTH_TOKEN).toBe("sm-test")
    expect(command.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7567")
  })

  it.live("settings_that_are_not_an_object_are_refused", () =>
    Effect.gen(function* () {
      const file = join(tempDir("claude-code-bad"), "settings.json")
      writeFileSync(file, "[1, 2]")
      const error = yield* Effect.flip(ClaudeCode.setup(config(), file, undefined))
      expect(error.message.endsWith("is not a JSON object")).toBe(true)

      writeFileSync(file, '{"env": "nope"}')
      const env = yield* Effect.flip(ClaudeCode.setup(config(), file, undefined))
      expect(env.message).toBe("settings.json `env` is not an object")

      const garbage = yield* Effect.flip(ClaudeCode.undo(file, "garbage"))
      expect(garbage.message).toBe("the saved Claude Code settings are unreadable")
    }),
  )

  it.live("setup_on_a_fresh_machine_creates_settings_and_undo_empties_them", () =>
    Effect.gen(function* () {
      const file = join(tempDir("claude-code-fresh"), "settings.json")
      const saved = yield* ClaudeCode.setup(config(), file, undefined)
      const wired = readJson(file) as { env: Record<string, string> }
      expect(wired.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1")
      if (saved === undefined) throw new Error("setup saved nothing")
      yield* ClaudeCode.undo(file, saved)
      expect(readJson(file)).toEqual({ env: {} })

      // Undo after the user dropped `env` altogether leaves the file be.
      writeFileSync(file, '{"theme":"dark"}')
      yield* ClaudeCode.undo(file, { ANTHROPIC_BASE_URL: "x" })
      expect(readJson(file)).toEqual({ theme: "dark" })
    }),
  )

  it.live("a_live_login_is_imported_with_its_profile", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic()
      const account = yield* accountFrom(yield* mock.client(ORIGINS), login("live-access", "r-1", 3600))
      expect(account.tokens.accessToken).toBe("live-access")
      expect(account.tokens.refreshToken).toBe("r-1")
      expect(account.email).toBe("me@x.com")
      expect(account.plan).toBe("max 20x")
      expect(account.id.startsWith("claude-")).toBe(true)
      expect(mock.seenAt("/v1/oauth/token")).toEqual([])
    }),
  )

  it.live("an_expired_login_is_refreshed_first_and_keeps_its_refresh_token", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic()
      const account = yield* accountFrom(yield* mock.client(ORIGINS), login("old-access", "r-1", -60))
      expect(account.tokens.accessToken).toBe("fresh-access")
      // The answer rotated no refresh token, so the one in hand stays.
      expect(account.tokens.refreshToken).toBe("r-1")
      const refreshed = mock.seenAt("/v1/oauth/token")
      expect(refreshed.length).toBe(1)
      expect(refreshed[0] && (Seen.json(refreshed[0]) as Record<string, unknown>).refresh_token).toBe("r-1")
    }),
  )

  it.live("logins_that_cannot_be_read_are_errors", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic()
      const http = yield* mock.client(ORIGINS)
      const expired = yield* Effect.flip(accountFrom(http, login("old", undefined, -60)))
      expect(expired.message).toBe("login expired; log in again")
      const rejected = yield* Effect.flip(accountFrom(http, login("rejected", undefined, 3600)))
      expect(rejected.message).toBe("could not read the Claude profile")
    }),
  )
})

describe("agent/claude_code, beyond the Rust tests", () => {
  it.live("the saved login, its import, and where settings point are read from CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const dir = tempDir("claude-config")
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ CLAUDE_CONFIG_DIR: dir, HOME: dir }))
      expect(yield* ClaudeCode.configFile.pipe(Effect.provide(env))).toBe(join(dir, "settings.json"))
      expect(yield* ClaudeCode.hasLogin.pipe(Effect.provide(env))).toBe(false)
      expect(yield* ClaudeCode.wiredTo.pipe(Effect.provide(env))).toBeUndefined()

      writeFileSync(join(dir, "settings.json"), '{"env":{"ANTHROPIC_BASE_URL":"http://gateway"}}')
      expect(yield* ClaudeCode.wiredTo.pipe(Effect.provide(env))).toBe("http://gateway")

      const mock = yield* anthropic()
      const http = yield* mock.client(ORIGINS)
      expect(yield* ClaudeCode.import(http).pipe(Effect.provide(env))).toBeUndefined()
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "live-access", refreshToken: "r", expiresAt: null } }),
      )
      expect(yield* ClaudeCode.hasLogin.pipe(Effect.provide(env))).toBe(true)
      const found = yield* ClaudeCode.import(http).pipe(Effect.provide(env))
      expect(found?.origin).toBe("claude code")
      expect(found?.account._tag === "Success" && found.account.success.email).toBe("me@x.com")

      // `expires_at` is an `i64`: serde refuses a float, even a whole one, and text.
      for (const expiresAt of ["1700000000000.0", '"1700000000000"']) {
        writeFileSync(
          join(dir, ".credentials.json"),
          `{"claudeAiOauth":{"accessToken":"live-access","expiresAt":${expiresAt}}}`,
        )
        expect(yield* ClaudeCode.hasLogin.pipe(Effect.provide(env))).toBe(false)
      }
      writeFileSync(
        join(dir, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"a","expiresAt":12345678901234567}}',
      )
      expect(yield* ClaudeCode.hasLogin.pipe(Effect.provide(env))).toBe(true)
    }),
  )

  it.live("setup records what it replaces, writes privately, and the order matches serde_json's", () =>
    Effect.gen(function* () {
      const dir = tempDir("claude-code-order")
      mkdirSync(dir, { recursive: true })
      const file = join(dir, "settings.json")
      writeFileSync(file, '{"env":{"ANTHROPIC_API_KEY":"sk-x","A":"1","B":2.0}}')
      const saved = yield* ClaudeCode.setup(config(), file, undefined)
      expect(saved).toEqual({
        ANTHROPIC_BASE_URL: null,
        ANTHROPIC_AUTH_TOKEN: null,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: null,
        ANTHROPIC_API_KEY: "sk-x",
      })
      // serde_json's ordered map swap-removes: the last key takes the removed one's place.
      expect(readFileSync(file, "utf8")).toBe(
        '{\n  "env": {\n    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",\n    "A": "1",\n    "B": 2.0,\n' +
          '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7567",\n    "ANTHROPIC_AUTH_TOKEN": "sm-test"\n  }\n}\n',
      )
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(ClaudeCode.setupNote).toBe(
        "Restart Claude Code and the apps that run it. The Claude desktop app's Code tab and Cowork keep using the app's own login.",
      )
    }),
  )
})
