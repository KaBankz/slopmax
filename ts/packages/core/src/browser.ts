// Opening an address in the person's browser, for signing in and for the
// dashboard. Over SSH or in a container there is no browser to open, so the
// caller prints the address instead.
import { Config, Effect, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** What decides whether this machine shows a browser. */
export interface Desktop {
  readonly platform: NodeJS.Platform
  /** `DISPLAY` or `WAYLAND_DISPLAY` is set: a graphical session on Linux and the other Unixes. */
  readonly display: boolean
}

/** macOS and Windows always have a desktop; elsewhere only a graphical session does. */
export const hasBrowser = (desktop: Desktop): boolean =>
  desktop.platform === "darwin" || desktop.platform === "win32" || desktop.display

/** The program that opens an address in the default browser. */
export const opener = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open"

const isSet = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.exists((value) => value !== "")),
    Effect.orElseSucceed(() => false),
  )

/** This machine, as the environment describes it. */
export const desktop: Effect.Effect<Desktop> = Effect.gen(function* () {
  const display = (yield* isSet("DISPLAY")) || (yield* isSet("WAYLAND_DISPLAY"))
  return { platform: process.platform, display }
})

/**
 * Opens `url` in the default browser, detached and with its output
 * dropped. True when the opener started; false without a browser or when
 * it could not run.
 */
export const open = (
  url: string,
  on?: Desktop,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const machine = on ?? (yield* desktop)
    if (!hasBrowser(machine)) return false
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make(opener(machine.platform), [url], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    return yield* Effect.scoped(Effect.flatMap(spawner.spawn(command), (handle) => handle.unref)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  }).pipe(Effect.withSpan("browser.open"))
