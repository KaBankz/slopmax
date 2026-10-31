// Running the proxy as a background service that starts at login: a
// systemd user unit on Linux, a launchd agent on macOS.
import { isAbsolute, join } from "node:path"
import process from "node:process"

import { Config, Effect, Option } from "effect"

import { context, Failure } from "./error.ts"
import * as fsx from "./fsx.ts"
import * as paths from "./paths.ts"
import * as proc from "./proc.ts"

const NAME = "slopmax"
const LABEL = "dev.slopmax"

/** The service manager on this machine. */
export type Manager = "systemd" | "launchd"

/** What the service manager knows about slopmax. */
export interface Status {
  readonly installed: boolean
  readonly running: boolean
  /** Linux: whether the user's services keep running after logout. */
  readonly lingering: boolean | undefined
}

/** An environment variable as Rust's `var_os` sees it: set (perhaps empty) or not. */
const env = (name: string): Effect.Effect<string | undefined> =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * The manager available here, if slopmax knows how to use it.
 * `SLOPMAX_NO_SERVICE` set hides it, for a demo or a test whose proxy must
 * not become the user's login service: launchd and systemd are the user's
 * own, whatever directories the environment moves.
 */
export const detect: Effect.Effect<Manager | undefined> = Effect.gen(function* () {
  const hidden = yield* env("SLOPMAX_NO_SERVICE")
  if (hidden !== undefined && hidden !== "") return undefined
  if (process.platform === "darwin") return "launchd"
  if (process.platform === "linux" && (yield* succeeds("systemctl", ["--user", "--version"]))) return "systemd"
  return undefined
})

/** Where the user's configuration lives (`$XDG_CONFIG_HOME` or `~/.config`). */
const configHome: Effect.Effect<string> = Effect.gen(function* () {
  const xdg = yield* env("XDG_CONFIG_HOME")
  if (xdg !== undefined && isAbsolute(xdg)) return xdg
  return join(yield* paths.userHome, ".config")
})

/** The service definition's file. */
export const file = (self: Manager): Effect.Effect<string> =>
  self === "systemd"
    ? Effect.map(configHome, (dir) => join(dir, "systemd/user", `${NAME}.service`))
    : Effect.map(paths.userHome, (home) => join(home, "Library/LaunchAgents", `${LABEL}.plist`))

/** Writes the service definition for `exe`, then enables and starts it. Returns the file. */
export const install = Effect.fn("service.install")(function* (self: Manager, exe: string) {
  const path = yield* file(self)
  const log = yield* paths.logFile
  const home = yield* env("SLOPMAX_HOME")
  const text = self === "systemd" ? systemdUnit(exe, log, home) : launchdPlist(exe, log, home)
  yield* fsx.writePrivate(path, text).pipe(context(`writing ${path}`))
  if (self === "systemd") {
    yield* run("systemctl", ["--user", "daemon-reload"])
    yield* run("systemctl", ["--user", "enable", "--now", NAME])
  } else {
    // Replacing a loaded agent: unload it first (fails if absent).
    yield* Effect.ignore(launchctl(["bootout", yield* launchdTarget]))
    yield* launchctl(["bootstrap", yield* launchdDomain, path])
  }
  return path
})

/** Stops and removes the service. Returns the file it removed. */
export const uninstall = Effect.fn("service.uninstall")(function* (self: Manager) {
  const path = yield* file(self)
  if (self === "systemd") yield* Effect.ignore(run("systemctl", ["--user", "disable", "--now", NAME]))
  else yield* Effect.ignore(launchctl(["bootout", yield* launchdTarget]))
  yield* fsx
    .removeFile(path)
    .pipe(
      Effect.mapError((e) =>
        e.kind === "NotFound"
          ? new Failure({ message: "no service installed" })
          : new Failure({ message: `removing ${path}`, cause: e }),
      ),
    )
  if (self === "systemd") yield* Effect.ignore(run("systemctl", ["--user", "daemon-reload"]))
  return path
})

export const status = Effect.fn("service.status")(function* (self: Manager) {
  const installed = yield* fsx.exists(yield* file(self))
  if (self === "systemd") {
    const running = installed && (yield* succeeds("systemctl", ["--user", "is-active", "--quiet", NAME]))
    return { installed, running, lingering: yield* lingering } satisfies Status
  }
  const running = installed && (yield* Effect.isSuccess(launchctl(["print", yield* launchdTarget])))
  return { installed, running, lingering: undefined } satisfies Status
})

export const start = (self: Manager): Effect.Effect<void, Failure> =>
  self === "systemd"
    ? run("systemctl", ["--user", "start", NAME])
    : Effect.flatMap(launchdTarget, (target) => launchctl(["kickstart", target]))

/** @internal The systemd unit that runs `exe serve`, exported for tests. */
export const systemdUnit = (exe: string, log: string, home: string | undefined): string => {
  const environment = home === undefined ? "" : `Environment="SLOPMAX_HOME=${home}"\n`
  return (
    "[Unit]\n" +
    "Description=slopmax account pool for Claude Code and Codex\n" +
    "After=network-online.target\n" +
    "Wants=network-online.target\n" +
    "\n" +
    "[Service]\n" +
    `ExecStart="${exe}" serve\n` +
    environment +
    "Restart=on-failure\n" +
    "RestartSec=5\n" +
    `StandardOutput=append:${log}\n` +
    `StandardError=append:${log}\n` +
    "\n" +
    "[Install]\n" +
    "WantedBy=default.target\n"
  )
}

const xml = (path: string): string => path.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** @internal The launchd agent that runs `exe serve`, exported for tests. */
export const launchdPlist = (exe: string, log: string, home: string | undefined): string => {
  const environment =
    home === undefined
      ? ""
      : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>${xml(home)}</string>\n  </dict>\n`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(exe)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
${environment}</dict>
</plist>
`
}

/** @internal Linux: whether user services outlive the login session. */
export const lingering: Effect.Effect<boolean | undefined> = Effect.gen(function* () {
  const user = yield* env("USER")
  if (user === undefined) return undefined
  const output = yield* Effect.option(proc.output("loginctl", ["show-user", user, "--property=Linger"]))
  if (Option.isNone(output)) return undefined
  return proc.text(output.value.stdout).trim() === "Linger=yes"
})

/** @internal `gui/<uid>`, the user's launchd domain. */
export const launchdDomain: Effect.Effect<string> = Effect.gen(function* () {
  const output = yield* Effect.option(proc.output("id", ["-u"]))
  const uid = Option.isSome(output) ? proc.text(output.value.stdout).trim() : ""
  return `gui/${uid}`
})

/** @internal The launchd target of slopmax's agent. */
export const launchdTarget: Effect.Effect<string> = Effect.map(launchdDomain, (domain) => `${domain}/${LABEL}`)

const launchctl = (args: ReadonlyArray<string>): Effect.Effect<void, Failure> => run("launchctl", args)

/** @internal Whether `program` started and exited successfully. */
export const succeeds = (program: string, args: ReadonlyArray<string>): Effect.Effect<boolean> =>
  proc.output(program, args).pipe(
    Effect.map((o) => proc.ExitStatus.success(o.status)),
    Effect.orElseSucceed(() => false),
  )

/** @internal Runs `program`, failing with its stderr when it fails. */
export const run = Effect.fn("service.run")(function* (program: string, args: ReadonlyArray<string>) {
  const output = yield* proc.output(program, args).pipe(context(`running ${program}`))
  if (!proc.ExitStatus.success(output.status)) {
    const stderr = proc.text(output.stderr).trim()
    return yield* Effect.fail(new Failure({ message: `${program} ${args.join(" ")} failed: ${stderr}` }))
  }
})
