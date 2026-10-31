import { describe, expect } from "bun:test"
import { parse } from "@decimalturn/toml-patch"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Effect, Option, Path, Result } from "effect"
import type { WireSettings } from "../../src/agents/agent.ts"
import { codex, codexArgs, overrides } from "../../src/agents/codex.ts"
import { pathsFor } from "../../src/home.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

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
const values = (text: string): unknown => parse(text)

describe("Codex requests", () => {
  it("is recognised from its clients' user agents", () => {
    expect(codex.detect(new Headers({ "user-agent": "codex_cli_rs/0.50.0 (Mac OS 15)" }))).toBe(true)
    expect(codex.detect(new Headers({ "user-agent": "codex_exec/0.50.0" }))).toBe(true)
    expect(codex.detect(new Headers({ "user-agent": "claude-cli/2.1.0" }))).toBe(false)
  })

  it("takes the session from its headers, then the turn metadata, then the prompt cache key", () => {
    const body = new TextEncoder().encode('{"model":"gpt-5","prompt_cache_key":"pck"}')
    expect(codex.session(new Headers({ "session-id": "a", session_id: "b" }), body)).toBe("a")
    expect(codex.session(new Headers({ session_id: "b" }), body)).toBe("b")
    expect(
      codex.session(new Headers({ "x-codex-turn-metadata": '{"turn_id":"t","session_id":"from-metadata"}' }), body),
    ).toBe("from-metadata")
    expect(codex.session(new Headers({ "x-codex-turn-metadata": "not json" }), body)).toBe("pck")
    expect(codex.session(new Headers(), new TextEncoder().encode("{}"))).toBeUndefined()
  })
})

describe("running Codex through the proxy", () => {
  it("overrides define a provider of slopmax's own that reads the key from the environment", () => {
    expect(overrides(settings)).toEqual([
      "-c",
      'model_provider="slopmax"',
      "-c",
      'model_providers.slopmax.name="OpenAI"',
      "-c",
      'model_providers.slopmax.base_url="http://127.0.0.1:7567/codex"',
      "-c",
      'model_providers.slopmax.wire_api="responses"',
      "-c",
      'model_providers.slopmax.env_key="SLOPMAX_API_KEY"',
      "-c",
      "model_providers.slopmax.supports_websockets=true",
    ])
    expect(overrides({ ...settings, websockets: false }).join(" ")).not.toContain("supports_websockets")
  })

  it("overrides sit at the level of the user's own: after a session subcommand, else first", () => {
    const flags = overrides(settings)
    expect(codexArgs(settings, ["exec", "--json", "fix it"])).toEqual(["exec", ...flags, "--json", "fix it"])
    for (const command of ["e", "review", "resume", "fork"]) expect(codexArgs(settings, [command])[0]).toBe(command)
    expect(codexArgs(settings, ["-m", "o3", "hello"])).toEqual([...flags, "-m", "o3", "hello"])
    expect(codexArgs(settings, [])).toEqual(flags)
  })

  it("runs codex with the key in SLOPMAX_API_KEY", () => {
    const launch = codex.launch(settings, ["exec", "hi"])
    expect(launch.command).toBe("codex")
    expect(launch.env).toEqual({ SLOPMAX_API_KEY: "sm-test" })
    expect(launch.args[0]).toBe("exec")
  })

  it("env hands off to slopmax run through a shell function", () => {
    expect(codex.shell(settings, ["/opt/slop max/slopmax"])).toBe(
      `codex() { '/opt/slop max/slopmax' run codex "$@"; }\n`,
    )
    expect(codex.shell(settings, ["/usr/bin/bun", "/src/main.ts"])).toBe(
      `codex() { /usr/bin/bun /src/main.ts run codex "$@"; }\n`,
    )
  })

  it("edits config.toml in Codex's home", () => {
    expect(codex.configFile(paths)).toBe("/home/me/.codex/config.toml")
  })
})

describe("wiring config.toml", () => {
  const original = [
    "# My Codex settings",
    'model = "gpt-5" # the default model',
    'model_provider = "openai" # was this',
    'approval_policy = "on-request"',
    "",
    "# A provider of my own",
    "[model_providers.other]",
    'name = "Other" # keep me',
    'base_url = "https://other.example/v1"',
    "",
    "[profiles.fast]",
    'model = "o3"',
    "",
  ].join("\n")

  it("sets the provider and its table, keeps comments and every other line, and undo restores the file exactly", () => {
    const wired = ok(codex.setup(some(original), settings, { signedIn: false }))
    expect(wired.text).toBe(
      [
        "# My Codex settings",
        'model = "gpt-5" # the default model',
        'model_provider = "slopmax" # was this',
        'approval_policy = "on-request"',
        "",
        "# A provider of my own",
        "[model_providers.other]",
        'name = "Other" # keep me',
        'base_url = "https://other.example/v1"',
        "",
        "[profiles.fast]",
        'model = "o3"',
        "",
        "[model_providers.slopmax]",
        'name = "OpenAI"',
        'base_url = "http://127.0.0.1:7567/codex"',
        'wire_api = "responses"',
        'experimental_bearer_token = "sm-test"',
        "supports_websockets = true",
        "",
      ].join("\n"),
    )
    expect(wired.backup).toEqual({ modelProvider: "openai" })
    expect(codex.wiredTo(some(wired.text))).toBe("slopmax (http://127.0.0.1:7567/codex)")
    expect(ok(codex.undo(some(wired.text), wired.backup))).toBe(original)
  })

  it("on a missing file writes just the wiring, and undo empties it again", () => {
    const wired = ok(codex.setup(none, { ...settings, websockets: false }, { signedIn: true }))
    expect(wired.text).toStartWith('model_provider = "slopmax"\n\n[model_providers.slopmax]\nname = "OpenAI"\n')
    expect(values(wired.text)).toEqual({
      model_provider: "slopmax",
      model_providers: {
        slopmax: {
          name: "OpenAI",
          base_url: "http://127.0.0.1:7567/codex",
          wire_api: "responses",
          experimental_bearer_token: "sm-test",
          requires_openai_auth: true,
        },
      },
    })
    expect(wired.backup).toEqual({ modelProvider: null })
    expect(ok(codex.undo(some(wired.text), wired.backup))).toBe("")
  })

  it("adds the provider after the last top-level key, so a comment that follows it stays", () => {
    const text = 'model = "x"\n# about the TUI\n\n[tui]\nnotifications = true\n'
    const wired = ok(codex.setup(some(text), settings, { signedIn: false }))
    expect(wired.text.startsWith('model = "x"\nmodel_provider = "slopmax"\n# about the TUI\n\n[tui]\n')).toBe(true)
    expect(ok(codex.undo(some(wired.text), wired.backup))).toBe(text)
  })

  it("replaces a stale slopmax table where it is and leaves the comments around it", () => {
    const text = [
      'model_provider = "slopmax"',
      "",
      "[model_providers.slopmax]",
      'name = "OpenAI"',
      'base_url = "http://127.0.0.1:9999/codex"',
      'experimental_bearer_token = "sm-old"',
      "# about the next table",
      "",
      "[model_providers.other]",
      'name = "o"',
      "",
    ].join("\n")
    const wired = ok(codex.setup(some(text), settings, { signedIn: false }))
    expect(wired.backup).toEqual({ modelProvider: null })
    expect(wired.text).toContain('base_url = "http://127.0.0.1:7567/codex"\n')
    expect(wired.text).toContain("supports_websockets = true\n# about the next table\n\n[model_providers.other]\n")
    expect(wired.text).not.toContain("sm-old")
    const undone = ok(codex.undo(some(wired.text), wired.backup))
    expect(undone).toBe('# about the next table\n\n[model_providers.other]\nname = "o"\n')
  })

  it("handles providers written inline, through the whole-document edit, without losing other providers", () => {
    const text = 'model_providers = { other = { name = "o" } }\n'
    const wired = ok(codex.setup(some(text), settings, { signedIn: false }))
    expect(values(wired.text)).toMatchObject({
      model_provider: "slopmax",
      model_providers: { other: { name: "o" }, slopmax: { base_url: "http://127.0.0.1:7567/codex" } },
    })
    expect(values(ok(codex.undo(some(wired.text), wired.backup)))).toEqual({
      model_providers: { other: { name: "o" } },
    })
  })

  it("keeps Windows line endings", () => {
    const text = 'model = "x"\r\n\r\n[tui]\r\nnotifications = true\r\n'
    const wired = ok(codex.setup(some(text), settings, { signedIn: false }))
    expect(wired.text.replaceAll("\r\n", "")).not.toContain("\n")
    expect(ok(codex.undo(some(wired.text), wired.backup))).toBe(text)
  })

  it("refuses files it cannot edit: broken TOML, a model_providers that is not a table, an unreadable backup", () => {
    expect(Result.isFailure(codex.setup(some("model = = 1"), settings, { signedIn: false }))).toBe(true)
    expect(codex.setup(some('model_providers = "x"'), settings, { signedIn: false })).toEqual(
      Result.fail("its `model_providers` is not a table"),
    )
    expect(codex.undo(some(""), { provider: 1 })).toEqual(Result.fail("the saved Codex settings are unreadable"))
  })

  it("says where Codex is sent: a provider and its address, or just the provider", () => {
    expect(codex.wiredTo(none)).toBeUndefined()
    expect(codex.wiredTo(some('model = "x"'))).toBeUndefined()
    expect(codex.wiredTo(some('model_provider = "azure"'))).toBe("azure")
    expect(codex.wiredTo(some("not toml ="))).toBeUndefined()
  })

  it("the doctor checks the wiring against this proxy and its key", () => {
    const wired = ok(codex.setup(none, settings, { signedIn: false })).text
    expect(codex.inspect(some(wired), settings)).toEqual([
      { level: "ok", text: "wired through config.toml, for the CLI and the desktop app" },
    ])
    expect(codex.inspect(some(wired), { ...settings, apiKey: "sm-new" })[0]?.text).toBe(
      "config.toml's slopmax provider has an old address or key",
    )
    expect(codex.inspect(some('model_provider = "slopmax"'), settings)[0]?.text).toBe(
      "config.toml selects slopmax, but its provider table is gone (the Codex desktop app can rewrite the file)",
    )
    expect(codex.inspect(some('model_provider = "azure"'), settings)).toEqual([
      { level: "warn", text: "config.toml sends Codex to the `azure` provider", fix: "slopmax setup codex" },
    ])
    expect(codex.inspect(none, settings)).toEqual([
      {
        level: "info",
        text: "not wired in config.toml (`slopmax run codex` still works)",
        fix: "slopmax setup codex",
      },
    ])
  })
})

const auth = (content: string) => MemoryFileSystem.layerWith({ files: { "/home/me/.codex/auth.json": content } })

describe("Codex's own login", () => {
  it.effect("is a ChatGPT login when auth.json holds tokens, and not an API key or a broken file", () =>
    Effect.gen(function* () {
      const has = (content: string) => codex.hasLogin(paths).pipe(Effect.provide(auth(content)))
      expect(
        yield* has('{"tokens":{"access_token":"at","refresh_token":"rt"},"last_refresh":"2026-10-01T00:00:00Z"}'),
      ).toBe(true)
      expect(yield* has('{"OPENAI_API_KEY":"sk-x","tokens":null}')).toBe(false)
      expect(yield* has('{"OPENAI_API_KEY":"sk-x"}')).toBe(false)
      expect(yield* has("{ nope")).toBe(false)
      expect(yield* codex.hasLogin(paths).pipe(Effect.provide(MemoryFileSystem.layer))).toBe(false)
    }).pipe(Effect.provide(recordingSpawner().layer)),
  )
})
