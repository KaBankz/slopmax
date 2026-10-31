import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Option, Path, Result } from "effect"
import type { WireSettings } from "../../src/agents/agent.ts"
import { claudeCode } from "../../src/agents/claude-code.ts"
import { pathsFor } from "../../src/home.ts"

const settings: WireSettings = { baseUrl: "http://127.0.0.1:7567", apiKey: "sm-test", websockets: true }
const paths = Effect.runSync(
  Effect.map(Path.Path, (path) => pathsFor(path, { root: "/home/me/.slopmax", user: "/home/me" })).pipe(
    Effect.provide(Path.layer),
  ),
)
const none = Option.none<string>()
const some = (text: string) => Option.some(text)
const ok = <A>(result: Result.Result<A, string>): A => {
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}
const json = (text: string): unknown => JSON.parse(text)

const from = (agent: string) => claudeCode.detect(new Headers({ "user-agent": agent }))
const body = (userId: string) => new TextEncoder().encode(JSON.stringify({ model: "x", metadata: { user_id: userId } }))

describe("Claude Code requests", () => {
  it("is recognised from every entrypoint's user agent", () => {
    expect(from("claude-cli/2.1.0 (external, cli)")).toBe(true)
    expect(from("claude-cli/2.1.0 (external, sdk-ts)")).toBe(true)
    expect(from("claude-code/2.1.0")).toBe(true)
    expect(from("codex_cli_rs/0.50.0")).toBe(false)
    expect(from("curl/8")).toBe(false)
    expect(claudeCode.detect(new Headers())).toBe(false)
  })

  it("takes the session from its header, then from metadata.user_id as JSON, then in the older text form", () => {
    expect(claudeCode.session(new Headers({ "x-claude-code-session-id": "head" }), body("user_a_session_b"))).toBe(
      "head",
    )
    expect(claudeCode.session(new Headers(), body(JSON.stringify({ device_id: "d", session_id: "from-json" })))).toBe(
      "from-json",
    )
    expect(claudeCode.session(new Headers(), body("user_abc_account_1-2_session_s-9"))).toBe("s-9")
    expect(claudeCode.session(new Headers(), body("just-a-user"))).toBeUndefined()
    expect(claudeCode.session(new Headers(), new TextEncoder().encode("{}"))).toBeUndefined()
  })
})

describe("running Claude Code through the proxy", () => {
  it("points it at the proxy's /claude address with the owner key, and drops any API key", () => {
    const launch = claudeCode.launch(settings, ["--resume", "x"])
    expect(launch.command).toBe("claude")
    expect(launch.args).toEqual(["--resume", "x"])
    expect(launch.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude",
      ANTHROPIC_AUTH_TOKEN: "sm-test",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_API_KEY: undefined,
    })
    expect(Object.keys(launch.env)).toContain("ANTHROPIC_API_KEY")
  })

  it("prints shell lines that export the same environment and unset the API key", () => {
    expect(claudeCode.shell({ ...settings, apiKey: "sm-it's" }, ["/bin/slopmax"])).toBe(
      [
        "export ANTHROPIC_BASE_URL=http://127.0.0.1:7567/claude",
        "export ANTHROPIC_AUTH_TOKEN='sm-it'\\''s'",
        "export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1",
        "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
        "unset ANTHROPIC_API_KEY",
        "",
      ].join("\n"),
    )
  })

  it("edits settings.json in Claude Code's directory", () => {
    expect(claudeCode.configFile(paths)).toBe("/home/me/.claude/settings.json")
  })
})

describe("wiring settings.json", () => {
  const original = `${JSON.stringify(
    {
      model: "opus",
      env: { KEEP: "me", ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_API_KEY: "sk-ant" },
      permissions: { allow: ["Bash"] },
    },
    null,
    2,
  )}\n`

  it("sets the proxy's address and key, keeps other settings, and undo restores what was there", () => {
    const wired = ok(claudeCode.setup(some(original), settings, { signedIn: false }))
    expect(json(wired.text)).toEqual({
      model: "opus",
      env: {
        KEEP: "me",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude",
        ANTHROPIC_AUTH_TOKEN: "sm-test",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
      permissions: { allow: ["Bash"] },
    })
    expect(wired.backup).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: null,
      ANTHROPIC_API_KEY: "sk-ant",
    })
    expect(claudeCode.wiredTo(some(wired.text))).toBe("http://127.0.0.1:7567/claude")
    const undone = ok(claudeCode.undo(some(wired.text), wired.backup))
    expect(json(undone)).toEqual(json(original))
    expect(claudeCode.wiredTo(some(undone))).toBe("https://gateway.example")
  })

  it("on a fresh machine creates the settings, and undo leaves an empty env", () => {
    const wired = ok(claudeCode.setup(none, settings, { signedIn: false }))
    expect(json(wired.text)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude",
        ANTHROPIC_AUTH_TOKEN: "sm-test",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      },
    })
    expect(wired.text.endsWith("}\n")).toBe(true)
    expect(ok(claudeCode.undo(some(wired.text), wired.backup))).toBe('{\n  "env": {}\n}\n')
  })

  it("refuses settings that are not an object, an env that is not one, and an unreadable backup", () => {
    expect(claudeCode.setup(some("[1, 2]"), settings, { signedIn: false })).toEqual(
      Result.fail("it is not a JSON object"),
    )
    expect(claudeCode.setup(some("{ nope"), settings, { signedIn: false })).toEqual(Result.fail("it is not valid JSON"))
    expect(claudeCode.setup(some('{"env": "x"}'), settings, { signedIn: false })).toEqual(
      Result.fail("its `env` is not an object"),
    )
    expect(claudeCode.undo(some("{}"), "not an object")).toEqual(
      Result.fail("the saved Claude Code settings are unreadable"),
    )
  })

  it("undo leaves the file's settings as they are when its env is gone", () => {
    const backup = { ANTHROPIC_BASE_URL: "https://old" }
    expect(json(ok(claudeCode.undo(some('{"model": "opus"}'), backup)))).toEqual({ model: "opus" })
  })

  it("the doctor checks the wiring against this proxy and its key", () => {
    const at = (env: Record<string, string>) => claudeCode.inspect(some(JSON.stringify({ env })), settings)
    expect(at({ ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude", ANTHROPIC_AUTH_TOKEN: "sm-test" })).toEqual([
      { level: "ok", text: "wired through settings.json, for the CLI and the apps that run it" },
    ])
    expect(at({ ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude", ANTHROPIC_AUTH_TOKEN: "sm-old" })).toEqual([
      { level: "warn", text: "settings.json points at slopmax with a different key", fix: "slopmax setup claude" },
    ])
    expect(at({ ANTHROPIC_BASE_URL: "https://gateway.example" })).toEqual([
      {
        level: "warn",
        text: "settings.json sends Claude Code to https://gateway.example",
        fix: "slopmax setup claude",
      },
    ])
    expect(claudeCode.inspect(none, settings)).toEqual([
      {
        level: "info",
        text: "not wired in settings.json (`slopmax run claude` still works)",
        fix: "slopmax setup claude",
      },
    ])
  })
})
