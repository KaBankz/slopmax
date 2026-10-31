import { afterEach, describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { agentFacts, AgentId, providerFacts, ProviderId } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import { ConfigProvider, Duration, Effect, Fiber, FileSystem, Layer } from "effect"
import {
  type Agent,
  NothingToUndo,
  onPath,
  servable,
  servedBy,
  shellQuote,
  wiresToSlopmax,
} from "../../src/agents/agent.ts"
import { claudeCode } from "../../src/agents/claude-code.ts"
import { agentList, agents, connect, detect, disconnect, session, wiring } from "../../src/agents/index.ts"
import { runAgent } from "../../src/agents/agent.ts"
import { Home } from "../../src/home.ts"
import { Lock } from "../../src/lock.ts"
import { SpawnFailed } from "../../src/service.ts"
import { SettingsService } from "../../src/settings.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

const encode = (text: string) => new TextEncoder().encode(text)

describe("the agent registry", () => {
  it("has one agent per subscription, and every agent a provider is limited to exists", () => {
    expect(new Set(agentList.map((agent) => agent.id)).size).toBe(agentList.length)
    for (const provider of ProviderId.literals) {
      const facts = providerFacts[provider]
      const native = agentList.filter((agent) => agent.provider === provider)
      expect(native.length).toBe(facts.billing === "subscription" ? 1 : 0)
      const only: { readonly agentOnly?: AgentId } = facts
      if (only.agentOnly !== undefined) expect(agents[only.agentOnly].id).toBe(only.agentOnly)
    }
    for (const id of AgentId.literals) expect(agents[id]).toMatchObject(agentFacts[id])
    expect(agents.codex.title).toBe("Codex")
  })

  it("detects the first agent whose requests match, and no agent for other clients", () => {
    expect(detect(new Headers({ "user-agent": "claude-cli/2.1.0 (external, cli)" }))?.id).toBe("claude-code")
    expect(detect(new Headers({ "user-agent": "codex_cli_rs/0.50" }))?.id).toBe("codex")
    expect(detect(new Headers({ "user-agent": "OpenAI/Python 1.0" }))).toBeUndefined()
  })

  it("sessions come from the agent's own rule, or from ids other clients commonly send", () => {
    expect(session(undefined, new Headers({ "x-session-id": "s-1" }), encode("{}"))).toBe("s-1")
    expect(session(undefined, new Headers({ session_id: "s-2" }), encode("{}"))).toBe("s-2")
    expect(session(undefined, new Headers(), encode('{"prompt_cache_key":"pck"}'))).toBe("pck")
    expect(session(undefined, new Headers(), encode('{"nested":{"prompt_cache_key":"no"}}'))).toBeUndefined()
    expect(session(undefined, new Headers(), encode("{}"))).toBeUndefined()
    // An agent's own rule wins: Claude Code does not read x-session-id.
    expect(session(agents["claude-code"], new Headers({ "x-session-id": "s-1" }), encode("{}"))).toBeUndefined()
  })

  it("quotes words for the shell only when they need it", () => {
    expect(shellQuote("plain-value_1.2/x:y=z@w")).toBe("plain-value_1.2/x:y=z@w")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("two words")).toBe("'two words'")
    expect(shellQuote("")).toBe("''")
  })

  it("an agent is servable by its own provider's accounts or by API keys that back it", () => {
    expect(servedBy(agents["claude-code"])).toEqual(["claude", "anthropic"])
    expect(servedBy(agents.codex)).toEqual(["codex", "openai"])
    expect(servable(agents.codex, [{ provider: "openai" }])).toBe(true)
    expect(servable(agents.codex, [{ provider: "anthropic" }, { provider: "xai" }])).toBe(false)
    expect(servable(agents["claude-code"], [{ provider: "claude" }])).toBe(true)
    expect(servable(agents["claude-code"], [])).toBe(false)
  })

  it("an agent sent to this proxy's address, or to a provider named for slopmax, goes through slopmax", () => {
    expect(wiresToSlopmax("http://127.0.0.1:7567/claude", "http://127.0.0.1:7567")).toBe(true)
    expect(wiresToSlopmax("slopmax (http://10.0.0.2:7567/codex)", "http://127.0.0.1:7567")).toBe(true)
    expect(wiresToSlopmax("https://gateway.example", "http://127.0.0.1:7567")).toBe(false)
  })
})

const root = "/home/me/.slopmax"

/** A machine in memory: slopmax's home, Claude Code's and Codex's files, and `PATH`. */
const machine = (files: MemoryFileSystem.Options["files"] = {}, spawner = recordingSpawner()) =>
  Layer.mergeAll(
    Home.layerAt(root),
    Lock.layerMemory,
    SettingsService.layerValue({ apiKey: "sm-test" }),
    spawner.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ PATH: "/usr/local/bin:/opt/codex/bin" })),
  ).pipe(Layer.provideMerge(MemoryFileSystem.layerWith({ files })))

const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path))

describe("setup and undo on disk", () => {
  it.effect("setup writes the agent's settings privately, keeps a backup, and undo restores the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const result = yield* connect("claude-code")
      expect(result.path).toBe("/home/me/.claude/settings.json")
      expect(result.note).toStartWith("Restart Claude Code")
      expect((yield* fs.stat(result.path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(yield* read(result.path))).toMatchObject({
        theme: "dark",
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude", ANTHROPIC_AUTH_TOKEN: "sm-test" },
      })
      expect(JSON.parse(yield* read(`${root}/backups.json`))).toEqual({
        "claude-code": {
          ANTHROPIC_BASE_URL: null,
          ANTHROPIC_AUTH_TOKEN: null,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: null,
          ANTHROPIC_API_KEY: "sk-ant-mine",
        },
      })
      const wired = yield* wiring("claude-code")
      expect(wired).toMatchObject({ wired: true, backedUp: true, wiredTo: "http://127.0.0.1:7567/claude" })

      expect(yield* disconnect("claude-code")).toEqual({ path: result.path })
      expect(JSON.parse(yield* read(result.path))).toEqual({ theme: "dark", env: { ANTHROPIC_API_KEY: "sk-ant-mine" } })
      expect(JSON.parse(yield* read(`${root}/backups.json`))).toEqual({})
      expect(yield* wiring("claude-code")).toMatchObject({ wired: false, backedUp: false })
    }).pipe(
      Effect.provide(
        machine({ "/home/me/.claude/settings.json": '{"theme":"dark","env":{"ANTHROPIC_API_KEY":"sk-ant-mine"}}' }),
      ),
    ),
  )

  it.effect("a second setup keeps the first backup, so undo still restores what was there before slopmax", () =>
    Effect.gen(function* () {
      yield* connect("codex")
      yield* connect("codex")
      expect(JSON.parse(yield* read(`${root}/backups.json`))).toEqual({ codex: { modelProvider: "azure" } })
      yield* disconnect("codex")
      expect(yield* read("/home/me/.codex/config.toml")).toBe('model_provider = "azure" # mine\n')
    }).pipe(Effect.provide(machine({ "/home/me/.codex/config.toml": 'model_provider = "azure" # mine\n' }))),
  )

  it.effect("Codex's table asks for its own login when Codex is signed in", () =>
    Effect.gen(function* () {
      yield* connect("codex")
      expect(yield* read("/home/me/.codex/config.toml")).toContain("requires_openai_auth = true")
    }).pipe(Effect.provide(machine({ "/home/me/.codex/auth.json": '{"tokens":{"access_token":"at"}}' }))),
  )

  it.effect("setting up Claude Code never reads its login, so the macOS keychain is never asked", () => {
    const spawner = recordingSpawner()
    return Effect.gen(function* () {
      expect(agents["claude-code"].hasLogin).toBeUndefined()
      yield* connect("claude-code")
      expect(spawner.calls).toEqual([])
    }).pipe(Effect.provide(machine({ "/home/me/.claude/.credentials.json": "{}" }, spawner)))
  })

  it.effect("setup edits a symlinked settings file where it lives, and keeps the link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/home/me/.claude", { recursive: true })
      yield* fs.symlink("/home/me/dotfiles/claude.json", "/home/me/.claude/settings.json")
      const result = yield* connect("claude-code")
      expect(result.path).toBe("/home/me/dotfiles/claude.json")
      expect(yield* fs.readLink("/home/me/.claude/settings.json")).toBe("/home/me/dotfiles/claude.json")
      expect(yield* read("/home/me/dotfiles/claude.json")).toContain("ANTHROPIC_BASE_URL")
    }).pipe(Effect.provide(machine({ "/home/me/dotfiles/claude.json": "{}" }))),
  )

  it.effect("undo with no setup to undo says so and changes nothing", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(disconnect("codex"))
      expect(failed).toBeInstanceOf(NothingToUndo)
      expect(failed.message).toBe("no Codex setup to undo")
      expect(yield* read("/home/me/.codex/config.toml")).toBe('model = "x"\n')
    }).pipe(Effect.provide(machine({ "/home/me/.codex/config.toml": 'model = "x"\n' }))),
  )

  it.effect("a settings file slopmax cannot edit is reported with its path, and no backup is kept", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(connect("claude-code"))
      expect(failed.message).toBe("cannot edit /home/me/.claude/settings.json: it is not a JSON object")
      expect(yield* (yield* FileSystem.FileSystem).exists(`${root}/backups.json`)).toBe(false)
    }).pipe(Effect.provide(machine({ "/home/me/.claude/settings.json": "[]" }))),
  )

  it.effect("wiring reports whether the program is on PATH and where its settings send it", () =>
    Effect.gen(function* () {
      expect(yield* wiring("codex")).toMatchObject({
        id: "codex",
        title: "Codex",
        installed: true,
        configPath: "/home/me/.codex/config.toml",
        wiredTo: "azure",
        wired: false,
        backedUp: false,
      })
      expect((yield* wiring("claude-code")).installed).toBe(false)
    }).pipe(
      Effect.provide(
        machine({ "/opt/codex/bin/codex": "#!/bin/sh\n", "/home/me/.codex/config.toml": 'model_provider = "azure"\n' }),
      ),
    ),
  )

  it.effect("programs are looked up on PATH by their exact name, as files", () =>
    Effect.gen(function* () {
      expect(yield* onPath("codex")).toBe(true)
      expect(yield* onPath("claude")).toBe(false)
      expect(yield* onPath("cod")).toBe(false)
      expect(yield* onPath("bin")).toBe(false)
    }).pipe(Effect.provide(machine({ "/opt/codex/bin/codex": "", "/usr/local/bin/claude/readme": "" }))),
  )
})

describe("running an agent", () => {
  const settings = SettingsService.layerValue({ apiKey: "sm-test" })
  /** Claude Code's wiring, with `sh` standing in for the program. */
  const shell: Agent = { ...claudeCode, launch: (s, args) => ({ ...claudeCode.launch(s, args), command: "sh" }) }
  const saved = process.env["ANTHROPIC_API_KEY"]
  afterEach(() => {
    if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = saved
  })

  it.live("runs the agent with the proxy's environment, without an API key, and returns its exit code", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-go"
    const check = [
      'test "$ANTHROPIC_BASE_URL" = http://127.0.0.1:7567/claude',
      'test "$ANTHROPIC_AUTH_TOKEN" = sm-test',
      'test -z "${ANTHROPIC_API_KEY+set}"',
      "exit 7",
    ].join(" && ")
    return Effect.gen(function* () {
      expect(yield* runAgent(shell, ["-c", check])).toBe(7)
      expect(yield* runAgent(shell, ["-c", "exit 0"])).toBe(0)
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, settings)))
  })

  it.live("an agent that cannot be started is reported", () =>
    Effect.gen(function* () {
      const missing: Agent = { ...claudeCode, launch: () => ({ command: "slopmax-no-such-agent", args: [], env: {} }) }
      const failed = yield* Effect.flip(runAgent(missing, []))
      expect(failed).toBeInstanceOf(SpawnFailed)
      expect(failed.message).toStartWith("could not start slopmax-no-such-agent")
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, settings))),
  )

  it.live("a terminating signal slopmax receives is passed on, and the agent's end reads as 128 plus the signal", () =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(runAgent(shell, ["-c", "exec sleep 5"]))
      yield* Effect.sleep(Duration.millis(300))
      process.kill(process.pid, "SIGTERM")
      expect(yield* Fiber.join(running)).toBe(143)
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, settings))),
  )

  it.live("while the agent runs, other listeners (the runtime's) are set aside, and put back after", () => {
    const heard: Array<string> = []
    const runtime = () => heard.push("SIGTERM")
    return Effect.gen(function* () {
      process.on("SIGTERM", runtime)
      const running = yield* Effect.forkChild(runAgent(shell, ["-c", "trap '' TERM; sleep 0.5; exit 7"]))
      yield* Effect.sleep(Duration.millis(200))
      process.kill(process.pid, "SIGTERM")
      expect(yield* Fiber.join(running)).toBe(7)
      expect(heard).toEqual([])
      expect(process.listeners("SIGTERM")).toContain(runtime)
    }).pipe(
      Effect.ensuring(Effect.sync(() => process.off("SIGTERM", runtime))),
      Effect.provide(Layer.merge(BunServices.layer, settings)),
    )
  })

  it.live("an agent a signal ends on its own reads as 128 plus that signal", () =>
    Effect.gen(function* () {
      expect(yield* runAgent(shell, ["-c", "kill -KILL $$"])).toBe(137)
      expect(yield* runAgent(shell, ["-c", "kill -TERM $$"])).toBe(143)
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, settings))),
  )
})
