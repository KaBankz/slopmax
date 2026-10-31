// Terminal output: colors, usage bars, and column padding. Durations and
// counts come from `human` in @slopmax/core; input is read by `term.ts`.
//
// Also the CLI's `print!`/`println!`/`eprint!`/`eprintln!`, as Effects that
// write to the process's own stdout and stderr.
import process from "node:process"
import { isatty } from "node:tty"

import { Config, Effect, Option } from "effect"

import { num, report } from "@slopmax/core"

type Tone = report.Tone

let enabled = false

/**
 * Decides, once for the process, whether output is colored: only when
 * `NO_COLOR` is unset (an empty one counts as set) and stdout is a
 * terminal. Text for stderr follows the same decision, as in the Rust.
 * Until this runs, nothing is colored.
 */
export const init: Effect.Effect<void> = Effect.gen(function* () {
  const noColor = yield* Config.option(Config.String("NO_COLOR")).pipe(Effect.orElseSucceed(() => Option.none()))
  enabled = Option.isNone(noColor) && isatty(1)
})

/** Turns colors on or off directly (tests). */
export const setColor = (on: boolean): void => {
  enabled = on
}

const paint = (code: string, text: string): string => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text)

export const bold = (text: string): string => paint("1", text)

export const dim = (text: string): string => paint("2", text)

export const red = (text: string): string => paint("31", text)

export const green = (text: string): string => paint("32", text)

export const yellow = (text: string): string => paint("33", text)

export const cyan = (text: string): string => paint("36", text)

/** Colors `text` by how much of a quota is used. */
export const byLevel = (percent: number, text: string): string => toned(report.Tone.ofUse(percent), text)

/** Colors `text` in a shared tone. */
export const toned = (tone: Tone, text: string): string => {
  switch (tone) {
    case "good":
      return green(text)
    case "muted":
      return dim(text)
    case "accent":
      return cyan(text)
    case "warn":
      return yellow(text)
    case "bad":
      return red(text)
  }
}

// `f64::round` (half away from zero), then `as usize` (saturating; NaN is 0).
const roundToUsize = (x: number): number => {
  if (Number.isNaN(x) || x <= 0) return 0
  return num.round(x)
}

/** A fixed-width usage bar such as `██████░░░░`. */
export const bar = (percent: number, width: number): string => {
  const filled = Math.min(width, roundToUsize((Math.min(100, Math.max(0, percent)) / 100) * width))
  const body = `${"█".repeat(filled)}${"░".repeat(width - filled)}`
  return byLevel(percent, body)
}

/** Pads `text` to `width` columns, ignoring ANSI escapes when measuring. */
export const pad = (text: string, width: number): string => {
  const visible = visibleWidth(text)
  return `${text}${" ".repeat(Math.max(0, width - visible))}`
}

/** Display width of `text` with ANSI color escapes stripped: one column per character. */
export const visibleWidth = (text: string): number => {
  let width = 0
  let inEscape = false
  for (const c of text) {
    if (!inEscape && c === "\x1b") inEscape = true
    else if (inEscape && c === "m") inEscape = false
    else if (!inEscape) width += 1
  }
  return width
}

// Writes go straight to the descriptors' streams. Bun writes to files and
// pipes synchronously, and `flush` waits for anything still queued (a
// terminal), so nothing is lost when the process exits.
const write = (stream: NodeJS.WriteStream, text: string): void => {
  if (text !== "") stream.write(text)
}

/** `print!`. */
export const print = (text: string): Effect.Effect<void> => Effect.sync(() => write(process.stdout, text))

/** `println!`. */
export const println = (text = ""): Effect.Effect<void> => Effect.sync(() => write(process.stdout, `${text}\n`))

/** `eprint!`. */
export const eprint = (text: string): Effect.Effect<void> => Effect.sync(() => write(process.stderr, text))

/** `eprintln!`. */
export const eprintln = (text = ""): Effect.Effect<void> => Effect.sync(() => write(process.stderr, `${text}\n`))

/** Waits until what was written to stdout and stderr has been handed to the system. */
export const flush: Effect.Effect<void> = Effect.promise(() =>
  Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.writableLength === 0) resolve()
          else stream.write("", () => resolve())
        }),
    ),
  ).then(() => undefined),
)
