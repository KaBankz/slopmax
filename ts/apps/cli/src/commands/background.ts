// `start`, `stop`, `service`, and `logs`: the background proxy from the
// terminal. The work itself is in the core's `background`.
import { open, stat } from "node:fs/promises"
import process from "node:process"

import { Effect } from "effect"

import { background, Config, Failure, fsx, paths, service as services } from "@slopmax/core"

import * as ui from "../ui.ts"

// `?` on an error that is not a `Failure`: its message (which holds its causes).
export const anyhow = (e: Failure | { readonly message: string }): Failure =>
  e instanceof Failure ? e : new Failure({ message: e.message })

export const start: (config: Config) => Effect.Effect<void, Failure> = Effect.fn("background.start")(function* (
  config: Config,
) {
  if (yield* (yield* background.Daemon.make(config)).isRunning) {
    yield* ui.println(`slopmax is already running on ${Config.baseUrl(config)}`)
    return
  }
  yield* background.launch(config, yield* background.currentExe).pipe(Effect.mapError(anyhow))
  yield* ui.println(`slopmax running on ${Config.baseUrl(config)} ${ui.dim(`(log: ${yield* paths.logFile})`)}`)
})

export const stop: (config: Config) => Effect.Effect<void, Failure> = Effect.fn("background.stop")(function* (
  config: Config,
) {
  const stopped = yield* background.stop(config).pipe(Effect.mapError(anyhow))
  yield* ui.println(stopped ? "slopmax stopped" : "slopmax is not running")
})

/** Starts the proxy unless it already runs. */
export const ensureRunning: (config: Config) => Effect.Effect<void, Failure> = Effect.fn("background.ensureRunning")(
  function* (config: Config) {
    yield* background.ensureRunning(config, yield* background.currentExe).pipe(Effect.mapError(anyhow))
  },
)

export const service: (config: Config, action: string) => Effect.Effect<void, Failure> = Effect.fn(
  "background.service",
)(function* (config: Config, action: string) {
  const manager = yield* services.detect
  if (manager === undefined) {
    return yield* Effect.fail(
      new Failure({
        message:
          "no supported service manager here (systemd user services or launchd); " +
          "run `slopmax start` from a login script instead",
      }),
    )
  }
  switch (action) {
    case "install": {
      const exe = yield* background.currentExe
      const file = yield* background.installService(config, manager, exe).pipe(Effect.mapError(anyhow))
      yield* ui.println(`slopmax now starts at login ${ui.dim(`(${file})`)}`)
      if ((yield* services.status(manager)).lingering === false) {
        yield* ui.println(
          ui.dim("To keep it running after you log out (on a server), run `loginctl enable-linger $USER`."),
        )
      }
      return
    }
    case "uninstall": {
      const file = yield* services.uninstall(manager)
      yield* ui.println(`Removed the service ${ui.dim(`(${file})`)}`)
      return
    }
    default: {
      const status = yield* services.status(manager)
      const state = !status.installed
        ? "not installed"
        : status.running
          ? ui.green("installed and running")
          : ui.yellow("installed, not running")
      yield* ui.println(`service: ${state}`)
      if (status.lingering === false && status.installed) {
        yield* ui.println(ui.dim("It stops when you log out; `loginctl enable-linger $USER` keeps it."))
      }
    }
  }
})

/** How much of the log's end is read to find the last lines. */
const LOG_TAIL = 1024 * 1024

const lossy = new TextDecoder("utf-8", { fatal: false })

const io = <A>(what: () => Promise<A>, path: string): Effect.Effect<A, Failure> =>
  Effect.tryPromise({
    try: what,
    catch: (e) => new Failure({ message: `reading ${path}`, cause: fsx.ioError(e) }),
  })

// The file's size, or 0 when it cannot be read (Rust's `metadata().map_or(0, …)`).
const size = (path: string): Effect.Effect<number> =>
  Effect.promise(() =>
    stat(path).then(
      (s) => s.size,
      () => 0,
    ),
  )

// `bytes` from `position` to `end` of the file at `path`.
const readRange = (path: string, position: number, end: number): Effect.Effect<Uint8Array, Failure> =>
  io(async () => {
    const file = await open(path, "r")
    try {
      const out = new Uint8Array(Math.max(0, end - position))
      let filled = 0
      while (filled < out.length) {
        const { bytesRead } = await file.read(out, filled, out.length - filled, position + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return out.subarray(0, filled)
    } finally {
      await file.close()
    }
  }, path)

/**
 * Prints the last `lines` of the background proxy's log, then, with
 * `follow`, whatever it appends until interrupted.
 */
export const logs: (lines: number, follow: boolean) => Effect.Effect<void, Failure> = Effect.fn("background.logs")(
  function* (lines: number, follow: boolean) {
    const path = yield* paths.logFile
    let len: number
    for (;;) {
      const found = yield* Effect.tryPromise({ try: () => stat(path), catch: (e) => fsx.ioError(e) }).pipe(
        Effect.map((s) => s.size),
        Effect.catchIf(
          (e) => e.kind === "NotFound",
          () => Effect.succeed(undefined),
        ),
        Effect.mapError((e) => new Failure({ message: `reading ${path}`, cause: e })),
      )
      if (found !== undefined) {
        len = found
        break
      }
      if (!follow) {
        yield* ui.println(`No log yet: ${path} is written once the proxy runs in the background.`)
        return
      }
      yield* Effect.sleep("500 millis")
    }
    // The tail may start inside a character; decode leniently.
    const tail = lossy.decode(yield* readRange(path, Math.max(0, len - LOG_TAIL), len))
    const shown = linesOf(tail)
    let out = ""
    for (const line of shown.slice(Math.max(0, shown.length - lines))) out += `${line}\n`
    yield* ui.print(out)
    if (!follow) return
    let position = len
    for (;;) {
      yield* Effect.sleep("500 millis")
      const now = yield* size(path)
      // Truncated or replaced: start over from the top.
      if (now < position) position = 0
      if (now > position) {
        const chunk = yield* readRange(path, position, now)
        yield* Effect.sync(() => process.stdout.write(chunk))
        position = now
      }
    }
  },
)

/** `str::lines`: split on `\n`, a `\r` before it dropped, no empty last line. */
const linesOf = (s: string): Array<string> => {
  if (s === "") return []
  const parts = s.split("\n")
  if (parts.at(-1) === "") parts.pop()
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
}
