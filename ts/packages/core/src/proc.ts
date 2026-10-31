// Running other programs: collecting what one printed (Rust's
// `Command::output`), for the service managers and notification commands,
// and starting one detached, for the proxy in the background. The one
// module of the engine's own that starts children (`node:child_process`,
// which Bun implements).
import { spawn } from "node:child_process"
import { open } from "node:fs/promises"
import process from "node:process"

import { Data, Effect } from "effect"

import * as fsx from "./fsx.ts"

/** How a program ended: its exit code, or the signal that killed it. */
export interface ExitStatus {
  readonly code: number | undefined
  readonly signal: string | undefined
}

export const ExitStatus = {
  success: (self: ExitStatus): boolean => self.code === 0,

  /** As Rust prints an `ExitStatus` on Unix: `exit status: 3`, `signal: 9 (SIGKILL)`. */
  display: (self: ExitStatus): string => {
    if (self.code !== undefined) return `exit status: ${self.code}`
    const signal = self.signal ?? "SIGKILL"
    return `signal: ${fsx.signalNumber(signal) ?? 0} (${signal})`
  },
} as const

/** What a program printed, and how it ended. */
export interface Output {
  readonly status: ExitStatus
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

export interface Options {
  /** Variables set on top of this process's environment. */
  readonly env?: Readonly<Record<string, string>>
}

const lossy = new TextDecoder()

/** Bytes as text, invalid UTF-8 replaced (`String::from_utf8_lossy`). */
export const text = (bytes: Uint8Array): string => lossy.decode(bytes)

/**
 * Runs `program` with `args`, stdin empty, and collects its output. Fails
 * only when it cannot be started; interrupting kills it (`kill_on_drop`).
 */
export const output = (
  program: string,
  args: ReadonlyArray<string>,
  options: Options = {},
): Effect.Effect<Output, fsx.IoError> =>
  Effect.callback<Output, fsx.IoError>((resume) => {
    const env = options.env === undefined ? process.env : { ...process.env, ...options.env }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, [...args], { stdio: ["ignore", "pipe", "pipe"], env })
    } catch (error) {
      resume(Effect.fail(fsx.ioError(error)))
      return
    }
    const stdout: Array<Uint8Array> = []
    const stderr: Array<Uint8Array> = []
    child.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk))
    let settled = false
    child.once("error", (error) => {
      if (settled) return
      settled = true
      resume(Effect.fail(fsx.ioError(error)))
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      resume(
        Effect.succeed({
          status: { code: code ?? undefined, signal: signal ?? undefined },
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      )
    })
    return Effect.sync(() => {
      if (!settled) child.kill("SIGKILL")
    })
  })

/**
 * Starts `program` with `args` detached from this process: stdin empty,
 * stdout and stderr appended to `log` (created if missing). It runs in a
 * session of its own (`setsid`, where Rust takes a new process group), so
 * it outlives the terminal and never sees its Ctrl-C. Fails with an
 * `IoError` when the log cannot be opened, and a `StartError` when the
 * program cannot be started.
 */
export const detached = (
  program: string,
  args: ReadonlyArray<string>,
  log: string,
): Effect.Effect<void, fsx.IoError | StartError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(log, "a"), catch: fsx.ioError }),
    (file) =>
      Effect.callback<void, StartError>((resume) => {
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(program, [...args], { stdio: ["ignore", file.fd, file.fd], detached: true })
        } catch (error) {
          resume(Effect.fail(new StartError({ message: fsx.ioError(error).message })))
          return
        }
        child.once("error", (error) => resume(Effect.fail(new StartError({ message: fsx.ioError(error).message }))))
        child.once("spawn", () => {
          child.unref()
          resume(Effect.void)
        })
      }),
    (file) => Effect.promise(() => file.close()),
  )

/** A program could not be started; `message` is the system's reason. */
export class StartError extends Data.TaggedError("StartError")<{ readonly message: string }> {}
