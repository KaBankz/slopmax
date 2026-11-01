// What the bench's runs share: the measuring tools, a cleared environment
// for each process under test, its free ports, and the steps that read a
// figure off a running process.
import { Data, type Duration, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { freePort } from "slopmax/build"
import { fixed } from "@slopmax/domain/format"
import { memoryOf, untilHealthy } from "./measure.ts"
import { canaryCommand, ProgramFailed, run, start, type Tool, toolVersions } from "./programs.ts"

/** A dead proxy: connections to it are refused at once, so nothing under test reaches the internet. */
export const nowhere = "http://127.0.0.1:9"

/** The port CLIProxyAPI listens on by default. The bench never binds or calls it. */
export const cliProxyApiPort = 8317

/** A port the bench may use: never CLIProxyAPI's. */
export const usablePort = (port: number): boolean => port !== cliProxyApiPort

/** A free loopback address, as `host:port`. */
export const freeListen = Effect.map(freePort, (port) => `127.0.0.1:${port}`)

/** The environment a process under test sees: its home, its address, and no way out but the mock. */
export const sandboxEnv = (
  home: Readonly<Record<string, string>>,
  listen: string,
  tmp: Option.Option<string> = Option.none(),
): Record<string, string> => ({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  ...home,
  SLOPMAX_LISTEN: listen,
  SLOPMAX_NO_SERVICE: "1",
  SLOPMAX_CLIPROXYAPI_PORT: "9",
  HTTPS_PROXY: nowhere,
  HTTP_PROXY: nowhere,
  ALL_PROXY: nowhere,
  NO_COLOR: "1",
  ...(Option.isSome(tmp) ? { TMPDIR: tmp.value } : {}),
})

/**
 * The raw probe's environment: no proxy variables, since Bun's `fetch`
 * would send even its loopback calls to the mock through them.
 */
export const probeEnv = (home: Readonly<Record<string, string>>): Record<string, string> => ({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  ...home,
})

/** A load's figures mean nothing unless nearly every request was answered 200. */
export const answeredEnough = 0.99

/** A target under load did not answer, so its figures would measure failures. */
export class NotAnswering extends Data.TaggedError("NotAnswering")<{ readonly target: string; readonly ok: number }> {
  override get message(): string {
    return `the ${this.target} answered only ${fixed(this.ok * 100, 1)}% of requests with 200, so its figures would measure failures`
  }
}

/** Fails unless `ok` (0 to 1) of a load's requests were answered 200. */
export const ensureAnswered = (target: string, ok: number) =>
  ok >= answeredEnough ? Effect.void : Effect.fail(new NotAnswering({ target, ok }))

/** A measuring tool is not installed. */
export class ToolMissing extends Data.TaggedError("ToolMissing")<{ readonly tool: string }> {
  override get message(): string {
    return `${this.tool} is not installed; run this through mise (\`mise run bench\` or \`mise run gates\`), which installs it`
  }
}

/**
 * A tool's absolute path: from mise at its pinned version when mise is
 * there, else from PATH. Absolute, so it runs under any environment.
 */
export const resolveTool = Effect.fn("Bench.resolveTool")(
  function* (tool: Tool) {
    if (Bun.which("mise") !== null) {
      const found = yield* run([
        "mise",
        "exec",
        `${tool}@${toolVersions[tool]}`,
        "--",
        "sh",
        "-c",
        `command -v ${tool}`,
      ])
      const path = found.trim()
      if (path !== "") return path
    }
    const which = Bun.which(tool)
    if (which === null) return yield* new ToolMissing({ tool })
    return which
  },
  (effect, tool) => Effect.catchTag(effect, "ProgramFailed", () => Effect.fail(new ToolMissing({ tool }))),
)

/** The Bun that compiles ahead of time, as an absolute path. */
export const resolveCanary = Effect.gen(function* () {
  const command = canaryCommand(Bun.version_with_sha, process.execPath)
  if (command.length === 1) return command
  const found = yield* run([...command.slice(0, -1), "sh", "-c", "command -v bun"]).pipe(
    Effect.catchTag("ProgramFailed", () => Effect.fail(new ToolMissing({ tool: "Bun canary" }))),
  )
  return [found.trim()]
})

/** The tools every run needs. */
export const resolveTools = Effect.all({ oha: resolveTool("oha"), hyperfine: resolveTool("hyperfine") })

/** The size of `file` compressed with `xz -9`, as the xz budget counts it; fails unless xz finishes. */
export const xzSize = Effect.fn("Bench.xzSize")(function* (file: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const xz = yield* spawner.spawn(ChildProcess.make("xz", ["-9", "-T0", "-c", file], { stdin: "ignore" }))
  const [bytes, stderr, code] = yield* Effect.all(
    [
      xz.stdout.pipe(
        Stream.runFold(
          () => 0,
          (total, chunk: Uint8Array) => total + chunk.length,
        ),
      ),
      xz.stderr.pipe(Stream.decodeText(), Stream.mkString),
      xz.exitCode,
    ],
    { concurrency: "unbounded" },
  )
  // A size from an xz that stopped early would pass the budget on a truncated count.
  if (Number(code) !== 0) return yield* new ProgramFailed({ program: `xz -9 ${file}`, code: Number(code), stderr })
  return bytes
}, Effect.scoped)

const HyperfineReport = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ command: Schema.String, median: Schema.Finite, times: Schema.Array(Schema.Finite) }),
  ),
})
const decodeHyperfine = Schema.decodeUnknownEffect(Schema.fromJsonString(HyperfineReport))

/**
 * Times each command with hyperfine (no shell, after warmup runs) under
 * `env`, writing its report to `exportFile`; gives each command's run
 * times in milliseconds, in the order given.
 */
export const timeCommands = Effect.fn("Bench.timeCommands")(function* (
  hyperfine: string,
  commands: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  exportFile: string,
  runs: number,
) {
  yield* run(
    [
      hyperfine,
      "-N",
      "--style",
      "none",
      "--warmup",
      "5",
      "--runs",
      String(runs),
      "--export-json",
      exportFile,
      ...commands,
    ],
    { env },
  )
  const fs = yield* FileSystem.FileSystem
  const report = yield* Effect.flatMap(fs.readFileString(exportFile), decodeHyperfine)
  yield* fs.remove(exportFile, { force: true })
  return report.results.map((result) => result.times.map((seconds) => seconds * 1000))
})

/**
 * A daemon's memory once it has settled: started, answering, then left
 * alone for `settle`. It is stopped with the scope.
 */
export const settledMemory = Effect.fn("Bench.settledMemory")(function* (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  url: string,
  settle: Duration.Input,
) {
  const handle = yield* start(argv, env)
  yield* untilHealthy(url)
  yield* Effect.sleep(settle)
  return yield* memoryOf(handle.pid)
})
