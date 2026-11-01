import { describe, expect } from "bun:test"
import { agentFacts, agentOrder, providerOrder, slopmaxVersion } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, FileSystem, Layer, Option, Path, Stdio, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestConsole } from "effect/testing"
import { type Actions, agentChoices, argsFor, providerChoices } from "../src/cli.ts"
import { CliFailure, ExitWith } from "../src/failure.ts"
import { program } from "../src/program.ts"

/** What effect/cli runs on, with nothing behind it: these tests only parse. */
const environment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
)

type Call = readonly [string, ...ReadonlyArray<unknown>]

/** Actions that only record what they were given. */
const recorder = (calls: Array<Call>, fail?: unknown): Actions<unknown, never> => {
  const done = (...call: Call) =>
    Effect.suspend(() => {
      calls.push(call)
      return fail === undefined ? Effect.void : Effect.fail(fail)
    })
  return {
    bare: done("bare"),
    setup: (input) => done("setup", input),
    status: (input) => done("status", input),
    login: (input) => done("login", input),
    import: (input) => done("import", input),
    own: (account) => done("own", account),
    use: (account) => done("use", account),
    label: (account, label) => done("label", account, label),
    priority: (account, value) => done("priority", account, value),
    enable: (account) => done("enable", account),
    disable: (account) => done("disable", account),
    remove: (account) => done("remove", account),
    redeem: (input) => done("redeem", input),
    serve: (log) => done("serve", log),
    start: (json) => done("start", json),
    stop: done("stop"),
    service: (action, json) => done("service", action, json),
    run: (agent, args) => done("run", agent, args),
    env: (agent) => done("env", agent),
    config: (input) => done("config", input),
    usage: (input) => done("usage", input),
    keyList: done("keyList"),
    keyAdd: (name, models) => done("keyAdd", name, models),
    keyRemove: (name) => done("keyRemove", name),
    logs: (input) => done("logs", input),
    notify: done("notify"),
    dashboard: (print) => done("dashboard", print),
    doctor: (json) => done("doctor", json),
  }
}

/** Runs `argv`, giving the exit status, the action called, and what was printed. */
const parse = (argv: ReadonlyArray<string>, fail?: unknown) =>
  Effect.gen(function* () {
    const calls: Array<Call> = []
    const code = yield* program(recorder(calls, fail), argv).pipe(Effect.provide(environment))
    return {
      code,
      calls,
      out: (yield* TestConsole.logLines).join("\n"),
      err: (yield* TestConsole.errorLines).join("\n"),
    }
  })

describe("the command tree", () => {
  it("offers exactly the registered providers and agents as choices", () => {
    expect(providerChoices.map(([name]) => name)).toEqual([...providerOrder])
    expect([...new Set(agentChoices.map(([, id]) => id))]).toEqual([...agentOrder])
    for (const id of agentOrder) {
      expect(agentChoices).toContainEqual([agentFacts[id].program, id])
      expect(agentChoices).toContainEqual([id, id])
    }
  })

  it("hands everything after `run <agent>` to the agent, flags and all", () => {
    expect(argsFor(["run", "codex", "exec", "--help", "-1"])).toEqual(["run", "codex", "--", "exec", "--help", "-1"])
    expect(argsFor(["run", "--help"])).toEqual(["run", "--help"])
    expect(argsFor(["status", "--json"])).toEqual(["status", "--json"])
  })

  it.effect("parses a typical invocation of every command into what its action gets", () =>
    Effect.gen(function* () {
      const typical: ReadonlyArray<readonly [ReadonlyArray<string>, Call]> = [
        [[], ["bare"]],
        [["status"], ["status", { refresh: false, watch: false, json: false }]],
        [
          ["ls", "-r"],
          ["status", { refresh: true, watch: false, json: false }],
        ],
        [
          ["status", "--watch"],
          ["status", { refresh: false, watch: true, json: false }],
        ],
        [
          ["status", "--json"],
          ["status", { refresh: false, watch: false, json: true }],
        ],
        [
          ["setup"],
          [
            "setup",
            {
              agent: Option.none(),
              undo: false,
              yes: false,
              import: Option.none(),
              login: Option.none(),
              keysFromEnv: false,
              strategy: Option.none(),
              affinity: Option.none(),
              agents: Option.none(),
              noService: false,
            },
          ],
        ],
        [
          [
            "init",
            "-y",
            "--import",
            "cliproxyapi",
            "--strategy",
            "round-robin",
            "--affinity",
            "off",
            "--agents",
            "claude",
            "--no-service",
            "--keys-from-env",
            "--login",
            "codex",
          ],
          [
            "setup",
            {
              agent: Option.none(),
              undo: false,
              yes: true,
              import: Option.some("cliproxyapi"),
              login: Option.some("codex"),
              keysFromEnv: true,
              strategy: Option.some("round-robin"),
              affinity: Option.some(false),
              agents: Option.some("claude"),
              noService: true,
            },
          ],
        ],
        [
          ["setup", "claude", "--undo"],
          ["setup", expect.objectContaining({ agent: Option.some("claude-code"), undo: true })],
        ],
        [
          ["setup", "codex"],
          ["setup", expect.objectContaining({ agent: Option.some("codex"), undo: false })],
        ],
        [
          ["login", "claude"],
          [
            "login",
            {
              provider: "claude",
              device: false,
              noBrowser: false,
              label: Option.none(),
              url: Option.none(),
              dialect: Option.none(),
              models: Option.none(),
            },
          ],
        ],
        [
          ["login", "codex", "--device", "--no-browser", "--label", "work"],
          [
            "login",
            expect.objectContaining({ provider: "codex", device: true, noBrowser: true, label: Option.some("work") }),
          ],
        ],
        [
          [
            "login",
            "compat",
            "--url",
            "http://localhost:11434/v1",
            "--dialect",
            "responses",
            "--models",
            "qwen3,llama4",
          ],
          [
            "login",
            expect.objectContaining({
              provider: "compat",
              url: Option.some("http://localhost:11434/v1"),
              dialect: Option.some("responses"),
              models: Option.some("qwen3,llama4"),
            }),
          ],
        ],
        [
          ["login", "xai"],
          ["login", expect.objectContaining({ provider: "xai" })],
        ],
        [["import"], ["import", { source: "all", own: false }]],
        [
          ["import", "cliproxyapi", "--own"],
          ["import", { source: "cliproxyapi", own: true }],
        ],
        [
          ["own", "all"],
          ["own", "all"],
        ],
        [
          ["use", "2"],
          ["use", "2"],
        ],
        [
          ["use", "auto"],
          ["use", "auto"],
        ],
        [
          ["label", "1", "work"],
          ["label", "1", Option.some("work")],
        ],
        [
          ["label", "1"],
          ["label", "1", Option.none()],
        ],
        [
          ["priority", "3", "-1"],
          ["priority", "3", -1],
        ],
        [
          ["priority", "a@x.dev", "2"],
          ["priority", "a@x.dev", 2],
        ],
        [
          ["enable", "1"],
          ["enable", "1"],
        ],
        [
          ["disable", "1"],
          ["disable", "1"],
        ],
        [
          ["remove", "codex-1a2b"],
          ["remove", "codex-1a2b"],
        ],
        [
          ["redeem", "1", "-y"],
          ["redeem", { account: "1", reset: Option.none(), yes: true }],
        ],
        [
          ["redeem", "1", "credit-7"],
          ["redeem", { account: "1", reset: Option.some("credit-7"), yes: false }],
        ],
        [["serve"], ["serve", Option.none()]],
        [
          ["serve", "--log", "/tmp/slopmax.log"],
          ["serve", Option.some("/tmp/slopmax.log")],
        ],
        [["start"], ["start", false]],
        [
          ["start", "--json"],
          ["start", true],
        ],
        [["stop"], ["stop"]],
        [["service"], ["service", "status", false]],
        [
          ["service", "install"],
          ["service", "install", false],
        ],
        [
          ["service", "uninstall"],
          ["service", "uninstall", false],
        ],
        [
          ["service", "status", "--json"],
          ["service", "status", true],
        ],
        [
          ["run", "claude"],
          ["run", "claude-code", []],
        ],
        [
          ["run", "codex", "exec", "-c", "model=m", "hi"],
          ["run", "codex", ["exec", "-c", "model=m", "hi"]],
        ],
        [
          ["run", "claude", "--", "--resume"],
          ["run", "claude-code", ["--", "--resume"]],
        ],
        [
          ["env", "codex"],
          ["env", "codex"],
        ],
        [
          ["env", "claude-code"],
          ["env", "claude-code"],
        ],
        [["config"], ["config", { name: Option.none(), value: Option.none() }]],
        [
          ["config", "strategy"],
          ["config", { name: Option.some("strategy"), value: Option.none() }],
        ],
        [
          ["config", "strategy", "round-robin"],
          ["config", { name: Option.some("strategy"), value: Option.some("round-robin") }],
        ],
        [["usage"], ["usage", { range: "7d", by: "day", json: false }]],
        [
          ["usage", "today", "-b", "model"],
          ["usage", { range: "today", by: "model", json: false }],
        ],
        [
          ["usage", "all", "--by", "account", "--json"],
          ["usage", { range: "all", by: "account", json: true }],
        ],
        [["key"], ["keyList"]],
        [["key", "list"], ["keyList"]],
        [
          ["key", "add", "laptop", "--models", "gpt-*"],
          ["keyAdd", "laptop", "gpt-*"],
        ],
        [
          ["key", "add", "ci"],
          ["keyAdd", "ci", ""],
        ],
        [
          ["key", "remove", "laptop"],
          ["keyRemove", "laptop"],
        ],
        [["logs"], ["logs", { follow: false, lines: 40 }]],
        [
          ["logs", "-f", "-n", "100"],
          ["logs", { follow: true, lines: 100 }],
        ],
        [["notify"], ["notify"]],
        [["dashboard"], ["dashboard", false]],
        [
          ["dashboard", "--print"],
          ["dashboard", true],
        ],
        [["doctor"], ["doctor", false]],
        [
          ["doctor", "--json"],
          ["doctor", true],
        ],
      ]
      for (const [argv, call] of typical) {
        const ran = yield* parse(argv)
        expect({ argv, code: ran.code, err: ran.err }).toEqual({ argv, code: 0, err: "" })
        expect(ran.calls).toEqual([call])
      }
    }),
  )

  it.effect("prints the version and help without running any command", () =>
    Effect.gen(function* () {
      const version = yield* parse(["--version"])
      expect(version.code).toBe(0)
      expect(version.out).toBe(`slopmax ${slopmaxVersion}`)
      expect(version.calls).toEqual([])
      const help = yield* parse(["--help"])
      expect(help.code).toBe(0)
      expect(help.out).toContain("setup, init")
      expect(help.out).toContain("status, ls")
      expect(help.calls).toEqual([])
      const login = yield* parse(["login", "--help"])
      expect(login.out).toContain("compat")
      const run = yield* parse(["run", "--help"])
      expect(run.out).toContain("Arguments passed to the agent")
      expect(run.calls).toEqual([])
    }),
  )

  it.effect("writes completion scripts for bash, zsh and fish", () =>
    Effect.gen(function* () {
      for (const shell of ["bash", "zsh", "fish"]) {
        const ran = yield* parse(["--completions", shell])
        expect(ran.code).toBe(0)
        expect(ran.out).toContain("slopmax")
        expect(ran.out).toContain("setup")
        expect(ran.calls).toEqual([])
      }
    }),
  )

  it.effect("refuses usage mistakes on stderr with exit status 2, running nothing", () =>
    Effect.gen(function* () {
      const mistakes: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
        [["statsu"], "status"],
        [["label"], "account"],
        [["status", "--frobnicate"], "--frobnicate"],
        [["usage", "fortnight"], "fortnight"],
        [["usage", "--by", "week"], "week"],
        [["logs", "-n", "many"], "many"],
        [["logs", "-n", "-1"], "-1"],
        [["import", "nowhere"], "nowhere"],
        [["login", "gemini"], "gemini"],
        [["setup", "--strategy", "sideways"], "sideways"],
        [["setup", "--affinity", "maybe"], "maybe"],
        [["priority", "1", "high"], "high"],
        [["key", "add"], "name"],
        [["--completions", "tcsh"], "tcsh"],
      ]
      for (const [argv, says] of mistakes) {
        const ran = yield* parse(argv)
        expect({ argv, code: ran.code }).toEqual({ argv, code: 2 })
        expect(ran.err).toContain(says)
        expect(ran.err).toContain("--help")
        expect(ran.calls).toEqual([])
      }
    }),
  )

  it.effect("says why a command failed in one line and exits 1", () =>
    Effect.gen(function* () {
      const ran = yield* parse(
        ["status", "--watch", "--json"],
        new CliFailure({ message: "--json cannot be combined with --watch" }),
      )
      expect(ran.code).toBe(1)
      expect(ran.err).toBe("error: --json cannot be combined with --watch")
    }),
  )

  it.effect("ends with a command's own status, saying nothing more", () =>
    Effect.gen(function* () {
      const ran = yield* parse(["doctor"], new ExitWith({ code: 1 }))
      expect(ran).toMatchObject({ code: 1, err: "" })
      const agent = yield* parse(["run", "codex"], new ExitWith({ code: 7 }))
      expect(agent).toMatchObject({ code: 7, err: "" })
    }),
  )
})
