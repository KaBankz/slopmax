// The programs the bench runs: the measuring tools from mise, the Bun
// canary that compiles ahead of time, and the processes under test, each
// in a cleared environment so nothing on this machine leaks into a run.
import { Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** The measuring tools, at the versions ts/mise.toml's bench tasks pin. */
export const toolVersions = { oha: "1.16", hyperfine: "1.20" } as const
export type Tool = keyof typeof toolVersions

/** Whether this Bun is a canary build, which is the one that compiles ahead of time. */
export const isCanary = (versionWithSha: string): boolean => versionWithSha.includes("canary")

/** The Bun that compiles ahead of time: this one when it is canary, else canary through mise. */
export const canaryCommand = (versionWithSha: string, execPath: string): ReadonlyArray<string> =>
  isCanary(versionWithSha) ? [execPath] : ["mise", "exec", "github:oven-sh/bun@canary", "--", "bun"]

/** A program the bench ran failed. */
export class ProgramFailed extends Data.TaggedError("ProgramFailed")<{
  readonly program: string
  readonly code: number
  readonly stderr: string
}> {
  override get message(): string {
    const said = this.stderr.trim()
    return `${this.program} failed (exit ${this.code})${said === "" ? "" : `: ${said.split("\n").slice(-5).join("\n")}`}`
  }
}

export interface RunOptions {
  readonly cwd?: string | undefined
  /** The whole environment: nothing is inherited. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Show what it prints on this terminal instead of keeping it. */
  readonly inherit?: boolean | undefined
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** Runs `argv` to its end and gives what it printed; fails unless it exits 0. */
export const run = Effect.fn("Bench.run")(function* (argv: ReadonlyArray<string>, options: RunOptions = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [program = "", ...args] = argv
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(program, args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? { extendEnv: true } : { env: options.env, extendEnv: false }),
          stdin: "ignore",
          stdout: options.inherit === true ? "inherit" : "pipe",
          stderr: options.inherit === true ? "inherit" : "pipe",
        }),
      )
      const [stdout, stderr, code] = yield* Effect.all(
        [
          options.inherit === true ? Effect.succeed("") : text(handle.stdout),
          options.inherit === true ? Effect.succeed("") : text(handle.stderr),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      if (Number(code) !== 0) return yield* new ProgramFailed({ program: argv.join(" "), code: Number(code), stderr })
      return stdout
    }),
  )
})

/**
 * Starts `argv` and leaves it running until the scope closes, when it is
 * sent SIGTERM (and killed if it has not stopped within five seconds).
 */
export const start = Effect.fn("Bench.start")(function* (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [program = "", ...args] = argv
  return yield* spawner.spawn(
    ChildProcess.make(program, args, {
      env,
      extendEnv: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "5 seconds",
    }),
  )
})
