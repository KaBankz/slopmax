import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { it, MemoryFileSystem } from "@slopmax/test"
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect"
import { Home } from "../../src/home.ts"
import {
  detectKind,
  ExitFailed,
  launchdDomain,
  launchdPlist,
  launchdTarget,
  makeServiceManager,
  type ManagerKind,
  mustRun,
  runProgram,
  selfCommand,
  serviceFile,
  ServiceNotInstalled,
  SpawnFailed,
  succeeds,
  systemdUnit,
} from "../../src/service.ts"
import { type Answer, recordingSpawner, type Script } from "./recording-spawner.ts"

const root = "/home/me/.slopmax"

/** A home in memory and a spawner that answers from `script`. */
const machine = (script?: Script) => {
  const spawner = recordingSpawner(script)
  const layer = Layer.mergeAll(Home.layerAt(root), spawner.layer).pipe(Layer.provideMerge(MemoryFileSystem.layer))
  return { layer, calls: spawner.calls }
}

const manager = (kind: ManagerKind | undefined, user?: string) =>
  makeServiceManager({
    kind: Option.fromUndefinedOr(kind),
    file: serviceFile(kind ?? "systemd", { user: "/home/me" }),
    spec: { exe: ["/opt/slopmax/bin/slopmax"], log: `${root}/slopmax.log` },
    uid: 501,
    user: Option.fromUndefinedOr(user),
  })

describe("service files", () => {
  it("the systemd unit runs serve, restarts on failure and appends its output to the log", () => {
    const unit = systemdUnit({ exe: ["/opt/slopmax"], log: "/home/me/.slopmax/slopmax.log" })
    expect(unit).toContain('ExecStart="/opt/slopmax" serve\n')
    expect(unit).toContain("Restart=on-failure\nRestartSec=5\n")
    expect(unit).toContain("StandardOutput=append:/home/me/.slopmax/slopmax.log\n")
    expect(unit).toContain("StandardError=append:/home/me/.slopmax/slopmax.log\n")
    expect(unit).toContain("WantedBy=default.target\n")
    expect(unit).not.toContain("Environment=")
  })

  it("the systemd unit carries a moved home and quotes every word of the command", () => {
    const unit = systemdUnit({ exe: ["/usr/bin/bun", "/src/my app/main.ts"], log: "/l", home: "/data/slop 100%" })
    expect(unit).toContain('ExecStart="/usr/bin/bun" "/src/my app/main.ts" serve\n')
    expect(unit).toContain('Environment="SLOPMAX_HOME=/data/slop 100%%"\n')
  })

  it("the launchd plist escapes paths", () => {
    const plist = launchdPlist({ exe: ["/Apps/R&D <x>/slopmax"], log: "/logs/a&b.log" })
    expect(plist).toContain("<string>/Apps/R&amp;D &lt;x&gt;/slopmax</string>")
    expect(plist).toContain("<string>/logs/a&amp;b.log</string>")
    expect(plist).toContain("<string>dev.slopmax</string>")
    expect(plist).toContain("    <string>serve</string>\n")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>")
    expect(plist.endsWith("</dict>\n</plist>\n")).toBe(true)
    expect(plist).not.toContain("EnvironmentVariables")
  })

  it("the launchd plist sets SLOPMAX_HOME when the home was moved", () => {
    const plist = launchdPlist({ exe: ["/x"], log: "/l", home: "/data/slopmax" })
    expect(plist).toContain(
      "<key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>/data/slopmax</string>\n  </dict>",
    )
  })

  it("service files live where each manager looks, honouring only an absolute XDG_CONFIG_HOME", () => {
    expect(serviceFile("systemd", { user: "/home/me" })).toBe("/home/me/.config/systemd/user/slopmax.service")
    expect(serviceFile("systemd", { user: "/home/me", xdgConfigHome: "/xdg" })).toBe(
      "/xdg/systemd/user/slopmax.service",
    )
    expect(serviceFile("systemd", { user: "/home/me", xdgConfigHome: "relative" })).toBe(
      "/home/me/.config/systemd/user/slopmax.service",
    )
    expect(serviceFile("launchd", { user: "/Users/me" })).toBe("/Users/me/Library/LaunchAgents/dev.slopmax.plist")
  })

  it("launchd targets the user's gui domain", () => {
    expect(launchdDomain(501)).toBe("gui/501")
    expect(launchdTarget(501)).toBe("gui/501/dev.slopmax")
  })
})

const script: Script = (program) =>
  program === "nope" ? "missing" : program === "bad" ? { code: 3, stderr: "  it broke\n" } : { stdout: "fine\n" }

describe("running programs", () => {
  it.effect("commands report their stderr when they fail", () => {
    const { layer } = machine(script)
    return Effect.gen(function* () {
      const failed = yield* Effect.flip(mustRun("bad", ["--user", "x"]))
      expect(failed).toBeInstanceOf(ExitFailed)
      expect(failed.message).toBe("bad --user x failed: it broke")
      const missing = yield* Effect.flip(mustRun("nope", []))
      expect(missing).toBeInstanceOf(SpawnFailed)
      expect(missing.message).toStartWith("could not start nope")
      expect(yield* mustRun("good", [])).toBe("fine\n")
      expect(yield* succeeds("good", [])).toBe(true)
      expect(yield* succeeds("bad", [])).toBe(false)
      expect(yield* succeeds("nope", [])).toBe(false)
      expect((yield* runProgram("bad", [])).code).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  it.live("a real program's output and exit code are read", () =>
    runProgram("sh", ["-c", "echo out; echo err >&2; exit 4"]).pipe(
      Effect.tap((ran) =>
        Effect.sync(() => {
          expect(ran).toEqual({ code: 4, stdout: "out\n", stderr: "err\n" })
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
})

const ok: Script = () => ({})

describe("the login service", () => {
  it.effect("installing with systemd writes a private unit, reloads systemd and enables it now", () => {
    const { layer, calls } = machine(ok)
    return Effect.gen(function* () {
      const service = yield* manager("systemd")
      const file = yield* service.install
      expect(file).toBe("/home/me/.config/systemd/user/slopmax.service")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(file)).toContain('ExecStart="/opt/slopmax/bin/slopmax" serve')
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
      expect(calls.map((call) => call.line)).toEqual([
        "systemctl --user daemon-reload",
        "systemctl --user enable --now slopmax",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("installing with launchd boots out an old agent, ignoring failure, then bootstraps the new one", () => {
    const { layer, calls } = machine((program, args) => (args[0] === "bootout" ? { code: 113 } : {}))
    return Effect.gen(function* () {
      const service = yield* manager("launchd")
      const file = yield* service.install
      expect(file).toBe("/home/me/Library/LaunchAgents/dev.slopmax.plist")
      expect(calls.map((call) => call.line)).toEqual([
        "launchctl bootout gui/501/dev.slopmax",
        `launchctl bootstrap gui/501 ${file}`,
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a failing step of an install is reported with what the manager said", () => {
    const { layer } = machine((_, args) =>
      args.includes("enable") ? { code: 1, stderr: "Failed to connect to bus" } : {},
    )
    return Effect.gen(function* () {
      const failed = yield* Effect.flip((yield* manager("systemd")).install)
      expect(failed.message).toBe("systemctl --user enable --now slopmax failed: Failed to connect to bus")
    }).pipe(Effect.provide(layer))
  })

  it.effect("uninstalling stops the service, removes its file and reloads systemd", () => {
    const { layer, calls } = machine(ok)
    return Effect.gen(function* () {
      const service = yield* manager("systemd")
      const file = yield* service.install
      calls.length = 0
      expect(yield* service.uninstall).toBe(file)
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false)
      expect(calls.map((call) => call.line)).toEqual([
        "systemctl --user disable --now slopmax",
        "systemctl --user daemon-reload",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("uninstalling with nothing installed says so", () => {
    const { layer } = machine(() => ({ code: 5 }))
    return Effect.gen(function* () {
      const failed = yield* Effect.flip((yield* manager("launchd")).uninstall)
      expect(failed).toBeInstanceOf(ServiceNotInstalled)
      expect(failed.message).toBe("no service installed")
    }).pipe(Effect.provide(layer))
  })

  it.effect("status asks the manager whether the installed service runs", () => {
    const { layer, calls } = machine((program, args) =>
      program === "loginctl" ? { stdout: "Linger=yes\n" } : args.includes("is-active") ? { code: 3 } : {},
    )
    return Effect.gen(function* () {
      const service = yield* manager("systemd", "me")
      const before = yield* service.status
      expect(before.installed).toBe(false)
      expect(before.running).toBe(false)
      expect(calls.some((call) => call.line.includes("is-active"))).toBe(false)
      yield* service.install
      const after = yield* service.status
      expect(after).toEqual({
        installed: true,
        running: false,
        file: "/home/me/.config/systemd/user/slopmax.service",
        lingering: Option.some(true),
      })
      expect(calls.at(-1)?.line).toBe("loginctl show-user me --property=Linger")
    }).pipe(Effect.provide(layer))
  })

  it.effect("launchd's agent runs when launchctl can print it", () => {
    const { layer, calls } = machine(ok)
    return Effect.gen(function* () {
      const service = yield* manager("launchd", "me")
      yield* service.install
      const status = yield* service.status
      expect(status.running).toBe(true)
      expect(calls.at(-1)?.line).toBe("launchctl print gui/501/dev.slopmax")
    }).pipe(Effect.provide(layer))
  })

  it.effect("lingering is a Linux question, answered yes only by exactly Linger=yes", () => {
    const answers: Record<string, Answer> = { yes: { stdout: "Linger=yes\n" }, no: { stdout: "Linger=no\n" } }
    let answer: Answer = answers["yes"] ?? {}
    const { layer } = machine((program) => (program === "loginctl" ? answer : {}))
    return Effect.gen(function* () {
      const systemd = yield* manager("systemd", "me")
      yield* systemd.install
      expect((yield* systemd.status).lingering).toEqual(Option.some(true))
      answer = answers["no"] ?? {}
      expect((yield* systemd.status).lingering).toEqual(Option.some(false))
      answer = "missing"
      expect((yield* systemd.status).lingering).toEqual(Option.none())
      answer = answers["yes"] ?? {}
      expect((yield* (yield* manager("systemd")).status).lingering).toEqual(Option.none())
      expect((yield* (yield* manager("launchd", "me")).status).lingering).toEqual(Option.none())
    }).pipe(Effect.provide(layer))
  })

  it.effect("starting goes through the manager", () => {
    const { layer, calls } = machine(ok)
    return Effect.gen(function* () {
      yield* (yield* manager("systemd")).start
      yield* (yield* manager("launchd")).start
      expect(calls.map((call) => call.line)).toEqual([
        "systemctl --user start slopmax",
        "launchctl kickstart gui/501/dev.slopmax",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("with no manager nothing is installed and nothing runs", () => {
    const { layer, calls } = machine(ok)
    return Effect.gen(function* () {
      const none = yield* manager(undefined)
      expect((yield* none.status).installed).toBe(false)
      expect((yield* Effect.flip(none.install))._tag).toBe("NoServiceManager")
      expect((yield* Effect.flip(none.start))._tag).toBe("NoServiceManager")
      expect(calls).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars))

describe("finding the manager", () => {
  it.effect("SLOPMAX_NO_SERVICE hides the manager without asking the system", () => {
    const { layer, calls } = machine(() => ({}))
    return Effect.gen(function* () {
      expect(yield* detectKind).toEqual(Option.none())
      expect(calls).toEqual([])
    }).pipe(Effect.provide(Layer.merge(layer, env({ SLOPMAX_NO_SERVICE: "1" }))))
  })

  it.effect.skipIf(process.platform !== "linux")("on Linux it is systemd only when systemctl --user works", () => {
    let works = true
    const { layer, calls } = machine(() => (works ? {} : { code: 1 }))
    return Effect.gen(function* () {
      expect(yield* detectKind).toEqual(Option.some("systemd"))
      expect(calls[0]?.line).toBe("systemctl --user --version")
      works = false
      expect(yield* detectKind).toEqual(Option.none())
    }).pipe(Effect.provide(Layer.merge(layer, env({ SLOPMAX_NO_SERVICE: "" }))))
  })
})

describe("this slopmax", () => {
  it.live("the program that starts it again is found: the runtime, and the entry script when not compiled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const words = selfCommand()
      expect(words[0]).toBe(process.execPath)
      for (const word of words) expect(yield* fs.exists(word)).toBe(true)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
