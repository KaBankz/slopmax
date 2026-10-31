import { describe, expect, it as plain } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Result } from "effect"

import { Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"

import { type Account, Store, Tokens } from "../src/account.ts"
import { encodeUnsigned } from "../src/auth/jwt.ts"
import { httpClient } from "../src/auth/mod.ts"
import { discover, fromCliproxyapi, linkedTokens, type Saved, save, Source } from "../src/import.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../src/provider/registry.ts"
import { noEnv } from "../src/testkit.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const savedAs = (saved: Saved | undefined): readonly [Account, boolean] => {
  if (saved === undefined || saved.account._tag === "Failure") throw new Error("the login was not saved")
  return saved.account.success
}

describe("import", () => {
  it.live("reads_cliproxyapi_files", () =>
    Effect.gen(function* () {
      const dir = tempDir("import-cpa")
      const claude = {
        type: "claude",
        access_token: "sk-ant-oat01-x",
        refresh_token: "sk-ant-ort01-y",
        expired: "2000-01-01T00:00:00Z",
        email: "me@x.dev",
        account_uuid: "acct",
        organization_uuid: "org-1",
        organization_name: "Org",
        claude_device_ids: ["abc"],
        priority: "3",
        disabled: false,
      }
      const codex = {
        type: "codex",
        access_token: "not-a-jwt",
        account_id: "ws-9",
        email: "c@x.dev",
        plan_type: "pro",
        expired: "2000-01-01T00:00:00+08:00",
      }
      writeFileSync(join(dir, "claude-a.json"), JSON.stringify(claude))
      writeFileSync(join(dir, "codex-b.json"), JSON.stringify(codex))
      writeFileSync(join(dir, "xai-c.json"), '{"type":"xai"}')
      writeFileSync(join(dir, "config.yaml"), "port: 1")

      const http = yield* httpClient(new Origins()).pipe(Effect.provide(noEnv))
      const found = yield* fromCliproxyapi(http, dir)
      const accounts: Array<Account> = found.map((f) => Result.getOrThrow(f.account))
      expect(accounts.length).toBe(2)
      const [first, second] = accounts
      expect(first?.orgId).toBe("org-1")
      const link = first?.link
      // CLIProxyAPI logins are linked.
      expect(link?.tool).toBe("cliproxyapi")
      expect(link?.path).toBe(join(dir, "claude-a.json"))
      expect(first?.priority).toBe(3)
      expect(second?.accountId).toBe("ws-9")
      expect(second?.plan).toBe("pro")
      expect(second !== undefined && Tokens.isExpired(second.tokens, Timestamp.nowUnsafe())).toBe(true)
    }),
  )
})

describe("import, beyond the Rust tests", () => {
  it.live("a priority is an integer or integer text, as serde_json reads it", () =>
    Effect.gen(function* () {
      const dir = tempDir("import-priority")
      const http = yield* httpClient(new Origins()).pipe(Effect.provide(noEnv))
      // `as_i64` refuses `3.0`; text parses; Rust's `as i32` keeps the low 32 bits.
      for (const [priority, expected] of [
        ["3.0", 0],
        ['"+4"', 4],
        ["-2", -2],
        ["4294967301", 5],
        ["9007199254740993", 1],
        ["null", 0],
      ] as const) {
        writeFileSync(
          join(dir, "codex.json"),
          `{"type":"codex","access_token":"not-a-jwt","account_id":"ws","priority":${priority}}`,
        )
        const [found] = yield* fromCliproxyapi(http, dir)
        expect(found === undefined ? undefined : Result.getOrThrow(found.account).priority).toBe(expected)
      }
    }),
  )

  plain("sources are named as on the command line", () => {
    expect(Result.getOrThrow(Source.parse("claude-code"))).toBe("claude-code")
    expect(Result.getOrThrow(Source.parse("all"))).toBe("all")
    const unknown = Source.parse("gemini")
    expect(unknown._tag === "Failure" && unknown.failure).toBe('unknown source "gemini"')
  })

  it.live("found logins are saved, linked unless owned, and broken ones reported", () =>
    Effect.gen(function* () {
      const home = tempDir("import-home")
      const cpa = join(home, ".cli-proxy-api")
      mkdirSync(cpa)
      const access = encodeUnsigned({
        exp: 4_000_000_000,
        "https://api.openai.com/auth": { chatgpt_account_id: "ws-1" },
      })
      writeFileSync(join(cpa, "b.json"), JSON.stringify({ type: "codex", access_token: access, priority: 2 ** 32 + 5 }))
      writeFileSync(join(cpa, "a.json"), JSON.stringify({ type: "claude", expired: "2000-01-01T00:00:00Z" }))
      writeFileSync(join(cpa, "broken.json"), "{")
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, CLAUDE_CONFIG_DIR: join(home, "c") }))
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      const found = yield* discover(http, "all").pipe(Effect.provide(env))
      expect(found.map((f) => f.origin)).toEqual([join(cpa, "a.json"), join(cpa, "b.json")])
      expect(found[0]?.account._tag === "Failure" && found[0].account.failure.message).toBe("no access token")
      const codex = found[1]?.account
      // `as i32` keeps the low 32 bits.
      expect(codex?._tag === "Success" && codex.success.priority).toBe(5)
      expect(yield* discover(http, "codex").pipe(Effect.provide(env))).toEqual([])

      const store = Store.at(join(home, "accounts"))
      const linked = yield* save(store, found, false)
      expect(linked[0]?.account._tag).toBe("Failure")
      const [account, fresh] = savedAs(linked[1])
      expect(fresh).toBe(true)
      expect(account.link?.tool).toBe("cliproxyapi")
      const owned = yield* save(store, found.slice(1), true)
      const [ownedAccount, again] = savedAs(owned[0])
      expect(again).toBe(false)
      expect(ownedAccount.link).toBeUndefined()
      expect((yield* store.get(account.id))?.link).toBeUndefined()

      const tokens = yield* linkedTokens({ tool: "cliproxyapi", path: join(cpa, "b.json") })
      expect(tokens.accessToken).toBe(access)
      const other = yield* Effect.flip(linkedTokens({ tool: "elsewhere", path: "x" }))
      expect(other.message).toBe("cannot follow logins from elsewhere")
    }),
  )
})
