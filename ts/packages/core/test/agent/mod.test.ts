import { describe, expect, it as plain } from "bun:test"
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import process from "node:process"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Fiber } from "effect"

import type { json } from "@slopmax/wire"

import { type Agent, resolve, run, servable, session, setup, shellQuote, undo, wiring } from "../../src/agent/mod.ts"
import { AGENTS, ClaudeCode, detect, find } from "../../src/agent/index.ts"
import { Account } from "../../src/account.ts"
import { Config } from "../../src/config.ts"
import { Failure } from "../../src/error.ts"
import { ProviderId, Spec } from "../../src/provider/index.ts"
import { tempDirs } from "../support/temp.ts"

const tempDir = tempDirs()

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * An agent whose `setup` and `undo` record what they were given, for the
 * shared backup handling in `agent/mod.ts`; `wiredTo` is whatever a test
 * says.
 */
const fakeClaude = (file: string, wiredTo?: string): Agent => ({
  ...ClaudeCode,
  configFile: Effect.succeed(file),
  setup: (config, target, saved) =>
    Effect.sync(() => {
      const text = readFileSync(target, "utf8")
      const doc = JSON.parse(text) as { env?: Record<string, string> }
      const previous: json.Json = saved ?? { ANTHROPIC_BASE_URL: doc.env?.ANTHROPIC_BASE_URL ?? null }
      doc.env = { ...doc.env, ANTHROPIC_BASE_URL: Config.baseUrl(config) }
      writeFileSync(target, JSON.stringify(doc))
      return previous
    }),
  undo: (target, saved) =>
    Effect.sync(() => {
      writeFileSync(target, JSON.stringify({ restored: saved }))
    }),
  wiredTo: Effect.succeed(wiredTo),
})

/** An agent that is a shell script. */
const shell = (script: string): Agent => ({
  ...ClaudeCode,
  command: () => ({ program: "sh", args: ["-c", script], env: {}, envRemove: [] }),
})

describe("agent", () => {
  plain("registry_ids_are_unique_and_cover_every_subscription", () => {
    const ids = AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(AGENTS.length)
    for (const provider of ProviderId.ALL) {
      const native = AGENTS.some((a) => a.provider === provider)
      expect(native).toBe(Spec.isSubscription(ProviderId.spec(provider)))
      const only = ProviderId.spec(provider).agentOnly
      if (only !== undefined) expect(find(only)).toBeDefined()
    }
    expect(find("codex")?.title).toBe("Codex")
    expect(find("gemini")).toBeUndefined()
  })

  plain("sessions_come_from_the_agent_or_common_ids", () => {
    expect(session(undefined, new Headers({ "x-session-id": "s-1" }), bytes("{}"))).toBe("s-1")
    expect(session(undefined, new Headers(), bytes('{"prompt_cache_key":"pck"}'))).toBe("pck")
    expect(session(undefined, new Headers(), bytes("{}"))).toBeUndefined()
  })

  it.live("setup_edits_a_symlinked_config_in_place", () =>
    Effect.gen(function* () {
      const dir = tempDir("symlink")
      const real = join(dir, "dotfiles.json")
      const link = join(dir, "settings.json")
      writeFileSync(real, "{}")
      symlinkSync(real, link)
      const config: Config = { ...Config.default(), apiKey: "sm-test" }
      yield* ClaudeCode.setup(config, yield* resolve(link), undefined)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readFileSync(real, "utf8")).toContain("ANTHROPIC_BASE_URL")
      const missing = join(dir, "absent.json")
      expect(yield* resolve(missing)).toBe(missing)
      rmSync(dir, { recursive: true })
    }),
  )

  plain("shell_quoting", () => {
    expect(shellQuote("plain-value")).toBe("plain-value")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("")).toBe("''")
  })
})

describe("agent, beyond the Rust tests", () => {
  it.live("setup keeps the first backup, and undo restores it once", () =>
    Effect.gen(function* () {
      const dir = tempDir("backup")
      const file = join(dir, "settings.json")
      writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"https://mine"}}')
      const home = join(dir, "home")
      mkdirSync(home)
      const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ SLOPMAX_HOME: home }))
      const agent = fakeClaude(file)
      const config = Config.default()
      expect(yield* setup(agent, config).pipe(Effect.provide(env))).toBe(file)
      yield* setup(agent, config).pipe(Effect.provide(env))
      const backup = join(home, "setup-backup.json")
      expect(readFileSync(backup, "utf8")).toBe('{\n  "claude": {\n    "ANTHROPIC_BASE_URL": "https://mine"\n  }\n}\n')
      yield* undo(agent).pipe(Effect.provide(env))
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ restored: { ANTHROPIC_BASE_URL: "https://mine" } })
      expect(readFileSync(backup, "utf8")).toBe("{}\n")
      const again = yield* Effect.flip(undo(agent).pipe(Effect.provide(env)))
      expect(again).toBeInstanceOf(Failure)
      expect(again.message).toBe("no Claude Code setup to undo")
      rmSync(dir, { recursive: true })
    }),
  )

  it.live("run returns the agent's exit status, and an interrupted run waits for the agent", () =>
    Effect.gen(function* () {
      const config = Config.default()
      expect(yield* run(shell("exit 7"), config, [])).toBe(7)
      expect(yield* run(shell("kill -TERM $$"), config, [])).toBe(143)
      const failed = yield* Effect.flip(
        run(
          { ...ClaudeCode, command: () => ({ program: "/nonexistent/agent", args: [], env: {}, envRemove: [] }) },
          config,
          [],
        ),
      )
      expect(failed.message).toBe("could not start /nonexistent/agent: No such file or directory (os error 2)")

      const listeners = process.listenerCount("SIGTERM")
      const started = Date.now()
      const fiber = yield* Effect.forkChild(run(shell("sleep 0.4; exit 3"), config, []))
      yield* Effect.sleep("50 millis")
      expect(process.listenerCount("SIGTERM")).toBe(listeners + 1)
      yield* Fiber.interrupt(fiber)
      // The interruption ended only once the agent had.
      expect(Date.now() - started).toBeGreaterThanOrEqual(350)
      expect(process.listenerCount("SIGTERM")).toBe(listeners)
    }),
  )

  it.effect("wiring, servable, and detection", () =>
    Effect.gen(function* () {
      const config = Config.default()
      expect(yield* wiring(fakeClaude("x", "http://127.0.0.1:7567"), config)).toEqual({ _tag: "Slopmax" })
      expect(yield* wiring(fakeClaude("x", "slopmax (http://elsewhere)"), config)).toEqual({ _tag: "Slopmax" })
      expect(yield* wiring(fakeClaude("x", "https://gateway"), config)).toEqual({
        _tag: "Elsewhere",
        target: "https://gateway",
      })
      expect(yield* wiring(fakeClaude("x"), config)).toEqual({ _tag: "Direct" })
      const key = Account.make("anthropic", { accessToken: "k" }, 0)
      const xai = Account.make("xai", { accessToken: "k" }, 0)
      expect(servable(ClaudeCode, [key])).toBe(true)
      expect(servable(ClaudeCode, [xai])).toBe(false)
      expect(detect(new Headers({ "user-agent": "claude-cli/2.1.287 (external, cli)" }))?.id).toBe("claude")
      expect(detect(new Headers({ "user-agent": "codex_cli_rs/0.50.0" }))?.id).toBe("codex")
      expect(detect(new Headers({ "user-agent": "OpenAI/Python 2.4.0" }))).toBeUndefined()
      expect(
        session(ClaudeCode, new Headers(), bytes('{"metadata":{"user_id":"user_abc_account_def_session_9f"}}')),
      ).toBe("9f")
    }),
  )
})
