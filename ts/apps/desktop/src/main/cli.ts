// The slopmax command line the app runs the proxy with. The app holds no
// engine of its own: it starts and stops the proxy, reads the report and the
// doctor while the proxy is stopped, and manages the login service, all by
// running the CLI it ships with, so the terminal, the login service and the
// app always run the same program.
import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { Report, Section } from "@slopmax/domain"
import { ServiceView, StartedProxy } from "@slopmax/domain/desktop"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** The CLI could not do what the app asked; the message says why, for people. */
export class CliFailed extends Data.TaggedError("CliFailed")<{ readonly message: string }> {}

/** Where to look for the CLI. */
export interface Where {
  /** Electron's resources directory: the packaged app carries the CLI in `bin/` there. */
  readonly resources: string
  /** The app's own executable: a CLI installed beside it comes next. */
  readonly executable: string
  readonly platform: string
}

export const missingMessage =
  "cannot find the slopmax command line, which the app runs the proxy with; reinstall the app"

/**
 * Where the CLI may be, in the order the app tries them: inside the app, beside
 * its executable, then each directory on `PATH` in turn.
 */
export const cliCandidates = (where: Where, searchPath: string, path: Path.Path): ReadonlyArray<string> => {
  const windows = where.platform === "win32"
  const name = windows ? "slopmax.exe" : "slopmax"
  const onPath = searchPath
    .split(windows ? ";" : ":")
    .filter((dir) => dir !== "")
    .map((dir) => path.join(dir, name))
  return [path.join(where.resources, "bin", name), path.join(path.dirname(where.executable), name), ...onPath]
}

/** A file a program can be run from: a regular file, and executable where files carry the bit. */
const runnable = (fs: FileSystem.FileSystem, platform: string) => (file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0)),
    Effect.orElseSucceed(() => false),
  )

/**
 * Finds the CLI, or says it is missing. `SLOPMAX_CLI` names one directly, for
 * development; `PATH` is the one the app was started with, for a CLI installed
 * on its own.
 */
export const findCli = Effect.fn("Cli.find")(function* (where: Where) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const named = yield* Config.option(Config.NonEmptyString("SLOPMAX_CLI")).pipe(
    Effect.orElseSucceed(() => Option.none()),
  )
  const searchPath = yield* Config.String("PATH").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  )
  const candidates = Option.match(named, {
    onNone: () => cliCandidates(where, searchPath, path),
    onSome: (file) => [file],
  })
  const found = yield* Effect.findFirst(candidates, runnable(fs, where.platform))
  return yield* Option.match(found, {
    onNone: () => Effect.fail(new CliFailed({ message: missingMessage })),
    onSome: Effect.succeed,
  })
})

/** What a run printed and how it ended. */
export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * What a failed run says to people: the CLI's own last line of complaint
 * (it writes `error: …`), else that it failed with its exit code.
 */
export const failureText = (args: ReadonlyArray<string>, ran: Ran): string => {
  const said = ran.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1)
  if (said !== undefined) return said.replace(/^error:\s*/, "")
  return `slopmax ${args.join(" ")} exited with ${ran.code}`
}

/** `slopmax 0.4.0` → `0.4.0`. */
export const parseVersion = (stdout: string): Option.Option<string> => {
  const found = /^slopmax\s+(\S+)/.exec(stdout.trim())
  return Option.fromNullishOr(found?.[1])
}

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/**
 * How long a run may take. `start` waits up to about 5 seconds for the proxy
 * to answer, `doctor` checks every account; none should take longer than this,
 * and one that hangs must not leave the app waiting forever.
 */
export const runWait = Duration.seconds(45)

const notUnderstood = (what: string) =>
  new CliFailed({
    message: `the slopmax command line printed ${what} this app does not understand; it may be from another release, so reinstall the app`,
  })

export interface Shape {
  /** Where the CLI is. */
  readonly program: Effect.Effect<string, CliFailed>
  /** Runs it with `args` to its end. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<Ran, CliFailed>
  /** The bundled CLI's version, asked until it answers once. */
  readonly version: Effect.Effect<string, CliFailed>
  /** Makes sure the proxy runs, and says where and with which key. */
  readonly start: Effect.Effect<StartedProxy, CliFailed>
  readonly stop: Effect.Effect<void, CliFailed>
  /** The report built from the files, as `status --json` prints it. */
  readonly status: Effect.Effect<Report, CliFailed>
  /** The doctor's findings; a run that found failures still answers them. */
  readonly doctor: Effect.Effect<ReadonlyArray<Section>, CliFailed>
  readonly serviceStatus: Effect.Effect<ServiceView, CliFailed>
  readonly serviceInstall: Effect.Effect<void, CliFailed>
  readonly serviceUninstall: Effect.Effect<void, CliFailed>
}

/**
 * `effect`'s first success, kept: until then each call runs it again, so a
 * CLI installed after the app started is found, and a `--version` that timed
 * out once under load is asked again instead of turning the release check off.
 */
export const keptOnceFound = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Effect.Effect<A, E>> =>
  Effect.map(SynchronizedRef.make(Option.none<A>()), (held) =>
    SynchronizedRef.modifyEffect(held, (found) =>
      Option.match(found, {
        onSome: (value) => Effect.succeed([value, found] as const),
        onNone: () => Effect.map(effect, (value) => [value, Option.some(value)] as const),
      }),
    ),
  )

const make = Effect.fn("Cli.make")(function* (where: Where) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const program = yield* keptOnceFound(Effect.provideContext(findCli(where), context))

  const run: Shape["run"] = Effect.fn("Cli.run")(function* (args: ReadonlyArray<string>) {
    yield* Effect.annotateCurrentSpan("args", args.join(" "))
    const cli = yield* program
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(cli, args, { stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
          concurrency: "unbounded",
        })
        return { code: Number(code), stdout, stderr }
      }),
    ).pipe(
      Effect.mapError(() => new CliFailed({ message: `could not run ${cli}` })),
      // Closing the scope on the timeout stops the run.
      Effect.timeoutOrElse({
        duration: runWait,
        orElse: () =>
          Effect.fail(
            new CliFailed({ message: `slopmax ${args.join(" ")} did not finish within ${Duration.format(runWait)}` }),
          ),
      }),
    )
  })

  /** Runs and answers what it printed, failing with the CLI's own words unless it exits with one of `codes`. */
  const output = (args: ReadonlyArray<string>, codes: ReadonlyArray<number> = [0]) =>
    Effect.flatMap(run(args), (ran) =>
      codes.includes(ran.code)
        ? Effect.succeed(ran.stdout)
        : Effect.fail(new CliFailed({ message: failureText(args, ran) })),
    )

  const json = <A, I>(
    schema: Schema.Codec<A, I>,
    args: ReadonlyArray<string>,
    what: string,
    codes?: ReadonlyArray<number>,
  ) =>
    Effect.flatMap(output(args, codes), (stdout) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(
        Effect.mapError(() => notUnderstood(what)),
      ),
    )

  const version = yield* keptOnceFound(
    Effect.flatMap(output(["--version"]), (stdout) =>
      Option.match(parseVersion(stdout), {
        onNone: () => Effect.fail(notUnderstood("a version")),
        onSome: Effect.succeed,
      }),
    ),
  )

  return {
    program,
    run,
    version,
    start: json(StartedProxy, ["start", "--json"], "where the proxy runs"),
    stop: Effect.asVoid(output(["stop"])),
    status: json(Report, ["status", "--json"], "a report"),
    // The doctor exits 1 when it found a failure; its findings are the answer either way.
    doctor: json(Schema.Array(Section), ["doctor", "--json"], "the doctor's findings", [0, 1]),
    serviceStatus: json(ServiceView, ["service", "status", "--json"], "the login service"),
    serviceInstall: Effect.asVoid(output(["service", "install"])),
    serviceUninstall: Effect.asVoid(output(["service", "uninstall"])),
  } satisfies Shape
})

/** The CLI, found once and run as each action needs. */
export class Cli extends Context.Service<Cli, Shape>()("slopmax-desktop/Cli") {
  static readonly layer = (
    where: Where,
  ): Layer.Layer<Cli, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
    Layer.effect(Cli, make(where))
}
