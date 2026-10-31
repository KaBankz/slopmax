// The login service: slopmax's proxy started by the system's own service
// manager when people log in, and restarted if it fails. A user unit for
// systemd on Linux, a launch agent for launchd on macOS. Nothing here runs
// as root or touches system-wide files.
//
// Setting SLOPMAX_NO_SERVICE hides the manager altogether, so demos and tests
// never install anything into the person's own systemd or launchd.
import { Config, Data, Duration, Effect, FileSystem, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { causeText, envDir, type FileError, Home } from "./home.ts"

/** A program could not be started at all. */
export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly program: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `could not start ${this.program}: ${causeText(this.cause)}`
  }
}

/** A program ran and failed. */
export class ExitFailed extends Data.TaggedError("ExitFailed")<{
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly code: number
  readonly stderr: string
}> {
  override get message(): string {
    const said = this.stderr.trim()
    const why = said === "" ? `exit code ${this.code}` : said
    return `${[this.program, ...this.args].join(" ")} failed: ${why}`
  }
}

/** This system has no service manager slopmax can use (or SLOPMAX_NO_SERVICE is set). */
export class NoServiceManager extends Data.TaggedError("NoServiceManager")<{}> {
  override get message(): string {
    return "this system has no login service slopmax can install (systemd or launchd)"
  }
}

/** Uninstalling found nothing installed. */
export class ServiceNotInstalled extends Data.TaggedError("ServiceNotInstalled")<{ readonly file: string }> {
  override get message(): string {
    return "no service installed"
  }
}

/** What a program printed and how it ended. */
export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/**
 * How long a helper program (systemctl, launchctl, loginctl, lsof) may take.
 * Each answers in a moment; one that hangs (a stuck D-Bus, say) must not
 * hang the doctor or `slopmax service status` with it.
 */
const programWait = Duration.seconds(15)

/** What a program that ran out of time reads as: killed, with the exit code `timeout(1)` uses. */
const timedOut = (): Ran => ({ code: 124, stdout: "", stderr: `did not finish within ${Duration.format(programWait)}` })

/** Runs a program to its end, reading what it prints; one that runs out of time is stopped. */
export const runProgram = Effect.fn("runProgram")(function* (
  program: string,
  args: ReadonlyArray<string>,
): Effect.fn.Return<Ran, SpawnFailed, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "ignore", detached: false }))
      const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
        concurrency: "unbounded",
      })
      return { code: Number(code), stdout, stderr }
    }),
  ).pipe(
    Effect.mapError((cause) => new SpawnFailed({ program, cause })),
    // Closing the scope on the timeout kills the program.
    Effect.timeoutOrElse({ duration: programWait, orElse: () => Effect.succeed(timedOut()) }),
  )
})

/** Runs a program and fails unless it exits 0; its output on success. */
export const mustRun = (
  program: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, SpawnFailed | ExitFailed, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.flatMap(runProgram(program, args), (ran) =>
    ran.code === 0 ? Effect.succeed(ran.stdout) : Effect.fail(new ExitFailed({ program, args, ...ran })),
  )

/** Whether a program starts and exits 0. */
export const succeeds = (
  program: string,
  args: ReadonlyArray<string>,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runProgram(program, args).pipe(
    Effect.map((ran) => ran.code === 0),
    Effect.orElseSucceed(() => false),
  )

// --- Files ------------------------------------------------------------------

export type ManagerKind = "systemd" | "launchd"

/** The unit's name for systemd, and the launch agent's label for launchd. */
export const serviceName = "slopmax"
export const launchdLabel = "dev.slopmax"

/** What starts the daemon and where its output goes. */
export interface ServiceSpec {
  /** The program and any leading arguments that start this slopmax. */
  readonly exe: ReadonlyArray<string>
  /** The log file stdout and stderr are appended to. */
  readonly log: string
  /** `SLOPMAX_HOME`, when the installer had it set, so the service uses the same home. */
  readonly home?: string | undefined
}

/** A word for an `ExecStart=` line: quoted, with `\`, `"` and systemd's `%` escaped. */
const systemdWord = (word: string) => `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`

/** The systemd user unit: runs `serve`, restarts after a failure, appends its output to the log. */
export const systemdUnit = (spec: ServiceSpec): string =>
  [
    "[Unit]",
    "Description=slopmax account pool for Claude Code and Codex",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[...spec.exe.map(systemdWord), "serve"].join(" ")}`,
    ...(spec.home === undefined ? [] : [`Environment=${systemdWord(`SLOPMAX_HOME=${spec.home}`)}`]),
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${spec.log}`,
    `StandardError=append:${spec.log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** The launchd agent: runs `serve` at login, restarts it unless it exits cleanly, appends its output to the log. */
export const launchdPlist = (spec: ServiceSpec): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${launchdLabel}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[...spec.exe, "serve"].map((word) => `    <string>${xml(word)}</string>`),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(spec.log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(spec.log)}</string>`,
    ...(spec.home === undefined
      ? []
      : [
          `  <key>EnvironmentVariables</key>`,
          `  <dict>`,
          `    <key>SLOPMAX_HOME</key>`,
          `    <string>${xml(spec.home)}</string>`,
          `  </dict>`,
        ]),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")

/** Where each manager looks for the service file. systemd's directory honours `XDG_CONFIG_HOME` only when it is absolute. */
export const serviceFile = (
  kind: ManagerKind,
  dirs: { readonly user: string; readonly xdgConfigHome?: string | undefined },
): string => {
  if (kind === "launchd") return `${dirs.user}/Library/LaunchAgents/${launchdLabel}.plist`
  const config =
    dirs.xdgConfigHome !== undefined && dirs.xdgConfigHome.startsWith("/") ? dirs.xdgConfigHome : `${dirs.user}/.config`
  return `${config}/systemd/user/${serviceName}.service`
}

/** launchd's domain for this user's agents, and the agent in it. */
export const launchdDomain = (uid: number): string => `gui/${uid}`
export const launchdTarget = (uid: number): string => `${launchdDomain(uid)}/${launchdLabel}`

// --- The manager --------------------------------------------------------------

/** What the doctor and `slopmax service status` show. */
export interface ServiceStatus {
  readonly installed: boolean
  readonly running: boolean
  readonly file: string
  /** Whether it keeps running after logout: systemd's lingering. None where the question does not apply or cannot be answered. */
  readonly lingering: Option.Option<boolean>
}

/** The login service, as one value; every effect needs nothing more. */
export interface ServiceManager {
  /** None with SLOPMAX_NO_SERVICE, or when the system has no manager slopmax can use. */
  readonly kind: Option.Option<ManagerKind>
  readonly status: Effect.Effect<ServiceStatus>
  /** Writes the service file and starts it; the file's path. */
  readonly install: Effect.Effect<string, ExitFailed | SpawnFailed | FileError | NoServiceManager>
  /** Stops the service and removes its file; the file's path. */
  readonly uninstall: Effect.Effect<
    string,
    ExitFailed | SpawnFailed | FileError | NoServiceManager | ServiceNotInstalled
  >
  readonly start: Effect.Effect<void, ExitFailed | SpawnFailed | NoServiceManager>
}

export interface ManagerOptions {
  readonly kind: Option.Option<ManagerKind>
  /** The service file, where the manager looks for it. */
  readonly file: string
  readonly spec: ServiceSpec
  /** The user id, for launchd's domain. */
  readonly uid: number
  /** `$USER`, for systemd's lingering. */
  readonly user: Option.Option<string>
}

/** The manager for these options, with the spawner, file system and home it runs on captured. */
export const makeServiceManager = (
  options: ManagerOptions,
): Effect.Effect<ServiceManager, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Home> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const home = yield* Home
    const on = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
      Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner)
    const systemctl = (...args: ReadonlyArray<string>) => on(mustRun("systemctl", ["--user", ...args]))
    const launchctl = (...args: ReadonlyArray<string>) => on(mustRun("launchctl", args))
    const { file } = options
    const target = launchdTarget(options.uid)

    const kind = Effect.fromOption(options.kind).pipe(Effect.mapError(() => new NoServiceManager()))

    const lingering = (manager: ManagerKind): Effect.Effect<Option.Option<boolean>> => {
      if (manager !== "systemd" || Option.isNone(options.user)) return Effect.succeedNone
      return on(runProgram("loginctl", ["show-user", options.user.value, "--property=Linger"])).pipe(
        Effect.map((ran) => (ran.code === 0 ? Option.some(ran.stdout.trim() === "Linger=yes") : Option.none())),
        Effect.orElseSucceed(() => Option.none<boolean>()),
      )
    }

    const status: ServiceManager["status"] = Effect.gen(function* () {
      if (Option.isNone(options.kind)) {
        return { installed: false, running: false, file, lingering: Option.none() }
      }
      const manager = options.kind.value
      const installed = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
      const running =
        installed &&
        (yield* on(
          manager === "systemd"
            ? succeeds("systemctl", ["--user", "is-active", "--quiet", serviceName])
            : succeeds("launchctl", ["print", target]),
        ))
      return { installed, running, file, lingering: yield* lingering(manager) }
    }).pipe(Effect.withSpan("ServiceManager.status"))

    const install: ServiceManager["install"] = Effect.gen(function* () {
      const manager = yield* kind
      yield* home.writeText(file, manager === "systemd" ? systemdUnit(options.spec) : launchdPlist(options.spec))
      if (manager === "systemd") {
        yield* systemctl("daemon-reload")
        yield* systemctl("enable", "--now", serviceName)
      } else {
        // A loaded agent must be booted out before it can be bootstrapped again.
        yield* Effect.ignore(launchctl("bootout", target))
        yield* launchctl("bootstrap", launchdDomain(options.uid), file)
      }
      return file
    }).pipe(Effect.withSpan("ServiceManager.install"))

    const uninstall: ServiceManager["uninstall"] = Effect.gen(function* () {
      const manager = yield* kind
      yield* Effect.ignore(
        manager === "systemd" ? systemctl("disable", "--now", serviceName) : launchctl("bootout", target),
      )
      if (!(yield* home.remove(file))) return yield* new ServiceNotInstalled({ file })
      if (manager === "systemd") yield* Effect.ignore(systemctl("daemon-reload"))
      return file
    }).pipe(Effect.withSpan("ServiceManager.uninstall"))

    const start: ServiceManager["start"] = Effect.gen(function* () {
      const manager = yield* kind
      yield* manager === "systemd" ? systemctl("start", serviceName) : launchctl("kickstart", target)
    }).pipe(Effect.withSpan("ServiceManager.start"))

    return { kind: options.kind, status, install, uninstall, start }
  })

/** The manager this system has: launchd on macOS, systemd on Linux when `systemctl --user` works. */
export const detectKind: Effect.Effect<
  Option.Option<ManagerKind>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const hidden = yield* envDir("SLOPMAX_NO_SERVICE").pipe(Effect.orElseSucceed(() => Option.none<string>()))
  if (Option.isSome(hidden)) return Option.none()
  if (process.platform === "darwin") return Option.some("launchd" as const)
  if (process.platform === "linux" && (yield* succeeds("systemctl", ["--user", "--version"]))) {
    return Option.some("systemd" as const)
  }
  return Option.none()
})

/**
 * How this slopmax is started again by something else: the binary itself
 * when compiled, else the runtime and the entry script (`bun run`).
 */
export const selfCommand = (): ReadonlyArray<string> => {
  const script = process.argv[1]
  const compiled = script === undefined || script.startsWith("/$bunfs/") || script.startsWith("B:\\~BUN\\")
  return compiled ? [process.execPath] : [process.execPath, script]
}

/** The login service for this system and this home. */
export const detectServiceManager = (
  exe: ReadonlyArray<string> = selfCommand(),
): Effect.Effect<
  ServiceManager,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Home | Path.Path
> =>
  Effect.gen(function* () {
    const home = yield* Home
    const kind = yield* detectKind
    const env = yield* Config.all({
      xdg: envDir("XDG_CONFIG_HOME"),
      slopmaxHome: envDir("SLOPMAX_HOME"),
      user: envDir("USER"),
    }).pipe(
      Effect.orElseSucceed(() => ({
        xdg: Option.none<string>(),
        slopmaxHome: Option.none<string>(),
        user: Option.none<string>(),
      })),
    )
    const file = serviceFile(
      Option.getOrElse(kind, () => "systemd" as const),
      {
        user: home.paths.user,
        xdgConfigHome: Option.getOrUndefined(env.xdg),
      },
    )
    return yield* makeServiceManager({
      kind,
      file,
      spec: { exe, log: home.paths.log, home: Option.getOrUndefined(env.slopmaxHome) },
      uid: process.getuid?.() ?? 0,
      user: env.user,
    })
  })
