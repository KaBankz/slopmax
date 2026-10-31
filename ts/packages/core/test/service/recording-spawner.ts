// A ChildProcessSpawner that runs nothing: each program answers from a
// script, and every call is recorded, so tests check exactly what slopmax
// would have run (systemctl, launchctl, loginctl, security, lsof) without
// touching the machine's own service manager or keychain.
import { Effect, Layer, PlatformError, Redacted, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"

/** What a scripted program does: exit with a code and print, or not exist at all. */
export type Answer = { readonly code?: number; readonly stdout?: string; readonly stderr?: string } | "missing"

export type Script = (program: string, args: ReadonlyArray<string>) => Answer

/** One run: the program and its arguments, as one line. */
export interface Recorded {
  readonly line: string
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly detached: boolean | undefined
}

const encoder = new TextEncoder()
const bytes = (text: string | undefined) =>
  text === undefined || text === "" ? Stream.empty : Stream.make(encoder.encode(text))

/** A spawner over `script`, and the list it records each run into. */
export const recordingSpawner = (
  script: Script = () => ({}),
): { readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>; readonly calls: Array<Recorded> } => {
  const calls: Array<Recorded> = []
  let pid = 40_000
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      if (command._tag !== "StandardCommand") return Effect.die(new Error("piped commands are not scripted"))
      const args = command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg))
      calls.push({
        line: [command.command, ...args].join(" "),
        program: command.command,
        args,
        detached: command.options.detached,
      })
      const answer = script(command.command, args)
      if (answer === "missing") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `${command.command}: not found`,
          }),
        )
      }
      pid += 1
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: bytes(answer.stdout),
          stderr: bytes(answer.stderr),
          all: Stream.concat(bytes(answer.stdout), bytes(answer.stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner), calls }
}
