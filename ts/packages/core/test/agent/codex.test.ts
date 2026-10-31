import { describe, expect, it as plain } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client } from "@slopmax/net"

import { accountFrom, argv, Codex, overrides } from "../../src/agent/codex.ts"
import { encodeUnsigned } from "../../src/auth/jwt.ts"
import { Config } from "../../src/config.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { noEnv } from "../../src/testkit.ts"
import { tempDirs } from "../support/temp.ts"

const tempDir = tempDirs()

const config = (): Config => ({ ...Config.default(), apiKey: "sm-test" })

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe("agent/codex", () => {
  plain("overrides_define_a_custom_provider", () => {
    const args = overrides(config()).join(" ")
    expect(args).toContain('-c model_provider="slopmax"')
    expect(args).toContain('model_providers.slopmax.base_url="http://127.0.0.1:7567/codex"')
    expect(args).toContain('model_providers.slopmax.env_key="SLOPMAX_API_KEY"')
    expect(args).toContain('model_providers.slopmax.name="OpenAI"')
  })

  plain("overrides_sit_at_the_users_level", () => {
    // Session subcommands take the overrides after the subcommand, next
    // to the user's own `-c` flags.
    const args = argv(config(), ["exec", "-c", 'model="m"', "hi"])
    expect(args[0]).toBe("exec")
    expect(args[1]).toBe("-c")
    expect(args[2]?.startsWith("model_provider=")).toBe(true)
    expect(args.slice(-3)).toEqual(["-c", 'model="m"', "hi"])
    // The interactive TUI (optionally with a prompt) takes them at the root.
    const root = argv(config(), ["fix the bug"])
    expect(root[0]).toBe("-c")
    expect(root.at(-1)).toBe("fix the bug")
  })

  plain("env_hands_off_to_run", () => {
    expect(Codex.env(config(), "/opt/my tools/slopmax")).toBe("codex() { '/opt/my tools/slopmax' run codex \"$@\"; }\n")
  })

  plain("session_prefers_header_then_metadata_then_cache_key", () => {
    const body = bytes('{"prompt_cache_key":"pck"}')
    expect(Codex.session(new Headers(), body)).toBe("pck")
    const meta = new Headers({ "x-codex-turn-metadata": '{"session_id":"meta","thread_id":"t"}' })
    expect(Codex.session(meta, body)).toBe("meta")
    expect(Codex.session(new Headers({ "session-id": "sid" }), body)).toBe("sid")
  })

  it.live("imports_the_codex_login", () =>
    Effect.gen(function* () {
      const dir = tempDir("codex-auth")
      const idToken = encodeUnsigned({
        email: "me@x.dev",
        "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus" },
      })
      const access = encodeUnsigned({ exp: 1_900_000_000 })
      const path = join(dir, "auth.json")
      writeFileSync(
        path,
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { id_token: idToken, access_token: access, refresh_token: "rt", account_id: "ws-1" },
          last_refresh: "2026-10-01T00:00:00Z",
        }),
      )
      const account = yield* accountFrom(path)
      expect(account.email).toBe("me@x.dev")
      expect(account.plan).toBe("plus")
      expect(Timestamp.asSecond(account.tokens.expiresAt ?? 0)).toBe(1_900_000_000)
    }),
  )

  it.live("api_key_logins_are_not_imported", () =>
    Effect.gen(function* () {
      const path = join(tempDir("codex-key"), "auth.json")
      writeFileSync(path, '{"OPENAI_API_KEY":"sk-local"}')
      expect((yield* Effect.result(accountFrom(path)))._tag).toBe("Failure")
    }),
  )

  it.live("setup_round_trips_and_keeps_comments", () =>
    Effect.gen(function* () {
      const dir = tempDir("codex")
      const file = join(dir, "config.toml")
      const original =
        '# my config\nmodel_provider = "cliproxyapi"\nmodel = "gpt-6-sol"\n\n[model_providers.cliproxyapi]\nname = "cliproxyapi"\n'
      writeFileSync(file, original)

      const saved = yield* Codex.setup(config(), file, undefined)
      let wired = readFileSync(file, "utf8")
      expect(wired.startsWith("# my config")).toBe(true)
      expect(wired).toContain('model_provider = "slopmax"')
      expect(wired).toContain("[model_providers.slopmax]")
      expect(wired).toContain('base_url = "http://127.0.0.1:7567/codex"')
      expect(wired).toContain('experimental_bearer_token = "sm-test"')
      expect(wired).toContain("[model_providers.cliproxyapi]")
      // Not signed in to Codex.
      expect(wired).not.toContain("requires_openai_auth")

      // Signed in: the desktop app keeps its account screens.
      writeFileSync(join(dir, "auth.json"), "{}")
      const again = yield* Codex.setup(config(), file, saved)
      wired = readFileSync(file, "utf8")
      expect(wired).toContain("requires_openai_auth = true")

      if (again === undefined) throw new Error("setup saved nothing")
      yield* Codex.undo(file, again)
      const restored = readFileSync(file, "utf8")
      expect(restored).toContain('model_provider = "cliproxyapi"')
      expect(restored).not.toContain("slopmax")
    }),
  )
})

describe("agent/codex, beyond the Rust tests", () => {
  it.live("setup writes what toml_edit writes, privately, and undo removes what it added", () =>
    Effect.gen(function* () {
      const dir = tempDir("codex-exact")
      const file = join(dir, "config.toml")
      const saved = yield* Codex.setup(config(), file, undefined)
      expect(saved).toEqual({ model_provider: null })
      expect(readFileSync(file, "utf8")).toBe(
        'model_provider = "slopmax"\n\n[model_providers.slopmax]\nname = "OpenAI"\n' +
          'base_url = "http://127.0.0.1:7567/codex"\nwire_api = "responses"\nexperimental_bearer_token = "sm-test"\n' +
          "supports_websockets = true\n",
      )
      expect(statSync(file).mode & 0o777).toBe(0o600)
      // A repeated setup counts slopmax itself as nothing to restore.
      expect(yield* Codex.setup(config(), file, undefined)).toEqual({ model_provider: null })
      yield* Codex.undo(file, { model_provider: null })
      expect(readFileSync(file, "utf8")).toBe("")

      writeFileSync(file, "model_providers = 1\n")
      const notTable = yield* Effect.flip(Codex.setup(config(), file, undefined))
      expect(notTable.message).toBe("`model_providers` in config.toml is not a table")
      writeFileSync(file, "= nope")
      const unparsable = yield* Effect.flip(Codex.setup(config(), file, undefined))
      expect(unparsable.message).toBe(`parsing ${file}`)
    }),
  )

  it.live("dotted model_providers keys are edited where toml_edit edits them", () =>
    Effect.gen(function* () {
      // Outputs from toml_edit 0.25.15 running the Rust setup and undo.
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        [
          'model_providers.other.name = "o"\n[features]\na = true\n',
          'model_providers.other.name = "o"\nmodel_provider = "slopmax"\n\n[model_providers.slopmax]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:7567/codex"\nwire_api = "responses"\nexperimental_bearer_token = "sm-test"\nsupports_websockets = true\n[features]\na = true\n',
          'model_providers.other.name = "o"\n[features]\na = true\n',
        ],
        [
          'model_providers.slopmax.name = "x"\n[features]\na = true\n',
          'model_provider = "slopmax"\n\n[model_providers.slopmax]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:7567/codex"\nwire_api = "responses"\nexperimental_bearer_token = "sm-test"\nsupports_websockets = true\n[features]\na = true\n',
          "[features]\na = true\n",
        ],
        [
          'x = 1\n[features]\na = true\n[model_providers]\nslopmax.name = "x"\nother.name = "o"\n',
          'x = 1\nmodel_provider = "slopmax"\n[features]\na = true\n[model_providers]\nother.name = "o"\n\n[model_providers.slopmax]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:7567/codex"\nwire_api = "responses"\nexperimental_bearer_token = "sm-test"\nsupports_websockets = true\n',
          'x = 1\n[features]\na = true\n[model_providers]\nother.name = "o"\n',
        ],
        [
          '[features]\na = true\n[model_providers.other]\nname = "o"\n',
          'model_provider = "slopmax"\n[features]\na = true\n[model_providers.other]\nname = "o"\n\n[model_providers.slopmax]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:7567/codex"\nwire_api = "responses"\nexperimental_bearer_token = "sm-test"\nsupports_websockets = true\n',
          '[features]\na = true\n[model_providers.other]\nname = "o"\n',
        ],
      ]
      const file = join(tempDir("codex-dotted"), "config.toml")
      for (const [input, afterSetup, afterUndo] of cases) {
        writeFileSync(file, input)
        yield* Codex.setup(config(), file, undefined)
        expect(readFileSync(file, "utf8")).toBe(afterSetup)
        yield* Codex.undo(file, { model_provider: null })
        expect(readFileSync(file, "utf8")).toBe(afterUndo)
      }
    }),
  )

  it.live("the login, the import, and where the config points are read from CODEX_HOME", () =>
    Effect.gen(function* () {
      const dir = tempDir("codex-home")
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ CODEX_HOME: dir, HOME: dir }))
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      expect(yield* Codex.hasLogin.pipe(Effect.provide(env))).toBe(false)
      expect(yield* Codex.import(http).pipe(Effect.provide(env))).toBeUndefined()
      expect(yield* Codex.wiredTo.pipe(Effect.provide(env))).toBeUndefined()

      writeFileSync(join(dir, "auth.json"), '{"tokens":{"access_token":"not-a-jwt"}}')
      expect(yield* Codex.hasLogin.pipe(Effect.provide(env))).toBe(true)
      const found = yield* Codex.import(http).pipe(Effect.provide(env))
      expect(found?.origin).toBe(join(dir, "auth.json"))
      expect(found?.account._tag).toBe("Success")

      writeFileSync(join(dir, "auth.json"), '{"tokens":null}')
      expect(yield* Codex.hasLogin.pipe(Effect.provide(env))).toBe(false)
      const keyOnly = yield* Codex.import(http).pipe(Effect.provide(env))
      expect(keyOnly?.account._tag === "Failure" && keyOnly.account.failure.message).toBe(
        "not a ChatGPT login (API key or proxy auth)",
      )
      writeFileSync(join(dir, "auth.json"), "{")
      const broken = yield* Codex.import(http).pipe(Effect.provide(env))
      expect(broken?.account._tag === "Failure" && broken.account.failure.message).toBe(
        `reading ${join(dir, "auth.json")}`,
      )

      writeFileSync(
        join(dir, "config.toml"),
        'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "http://p"\n',
      )
      expect(yield* Codex.wiredTo.pipe(Effect.provide(env))).toBe("proxy (http://p)")
      writeFileSync(join(dir, "config.toml"), 'model_provider = "oss"\n')
      expect(yield* Codex.wiredTo.pipe(Effect.provide(env))).toBe("oss")
      expect(Codex.command(config(), ["e", "x"])).toEqual({
        program: "codex",
        args: argv(config(), ["e", "x"]),
        env: { SLOPMAX_API_KEY: "sm-test" },
        envRemove: [],
      })
      expect(overrides({ ...config(), websockets: false }).join(" ")).not.toContain("supports_websockets")
      expect(overrides(config()).at(-1)).toBe("model_providers.slopmax.supports_websockets=true")
    }),
  )
})
