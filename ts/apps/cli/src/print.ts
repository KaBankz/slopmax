// How the CLI writes for people: styles that appear only on a terminal that
// wants them, padding by what the eye sees, and bars. Everything here
// is plain functions over strings; `Print` decides once per process whether
// colors are on, from the terminal and NO_COLOR, and is what commands write
// through, so tests read exactly what a person would.
import type { Tone } from "@slopmax/domain"
import { Console, Context, Effect, Layer } from "effect"
import { TerminalCapabilities } from "effect/cli"

/** Styles for text, each a no-op when colors are off. */
export interface Paint {
  readonly color: boolean
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly red: (text: string) => string
  readonly green: (text: string) => string
  readonly yellow: (text: string) => string
  readonly cyan: (text: string) => string
  /** The style every front end gives a tone: good, muted, accent, warn, bad. */
  readonly tone: (tone: Tone, text: string) => string
}

const sgr = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const plain = (text: string) => text

/** Styles for a terminal with colors (`color`), or none at all. */
export const paint = (color: boolean): Paint => {
  const style = (code: number) => (color ? sgr(code) : plain)
  const bold = style(1)
  const dim = style(2)
  const red = style(31)
  const green = style(32)
  const yellow = style(33)
  const cyan = style(36)
  const tones: { readonly [K in Tone]: (text: string) => string } = {
    good: green,
    muted: dim,
    accent: cyan,
    warn: yellow,
    bad: red,
  }
  return { color, bold, dim, red, green, yellow, cyan, tone: (tone, text) => tones[tone](text) }
}

// oxlint-disable-next-line no-control-regex -- the escapes are what is being stripped
const escapes = /\x1b\[[0-9;]*m/g

/** What the eye sees of `text`: its characters outside color escapes, one column per character. */
export const visibleWidth = (text: string): number => [...text.replace(escapes, "")].length

/** `text` padded with spaces to `width` visible columns. */
export const padEnd = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - visibleWidth(text)))

/** `text` right-aligned in `width` visible columns. */
export const padStart = (text: string, width: number): string =>
  " ".repeat(Math.max(0, width - visibleWidth(text))) + text

/** `text` cut to at most `width` characters (by character, never inside one). */
export const cut = (text: string, width: number): string => {
  const chars = [...text]
  return chars.length <= width ? text : chars.slice(0, width).join("")
}

/** `text` cut to `width` characters, ending in `…` when anything was cut off. */
export const ellipsis = (text: string, width: number): string => {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`
}

/** A bar `width` cells long, filled in proportion to `percent` (0–100), in the tone of how full it is. */
export const bar = (percent: number, width: number, tone: Tone, style: Paint): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return style.tone(tone, "█".repeat(filled) + "░".repeat(width - filled))
}

/** `count word`, with an `s` unless the count is one. */
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** Where commands write: stdout for what was asked for, stderr for everything said along the way. */
export class Print extends Context.Service<
  Print,
  {
    readonly paint: Paint
    /** A line on stdout. */
    readonly out: (line?: string) => Effect.Effect<void>
    /** A line on stderr. */
    readonly err: (line?: string) => Effect.Effect<void>
  }
>()("slopmax/Print") {
  /** Colors on a terminal that shows them and has no NO_COLOR set. */
  static readonly layer: Layer.Layer<Print> = Layer.effect(
    Print,
    Effect.gen(function* () {
      const capabilities = yield* TerminalCapabilities.TerminalCapabilities
      return Print.over(capabilities.canColor)
    }),
  )

  static readonly over = (color: boolean) => ({
    paint: paint(color),
    out: (line = "") => Console.log(line),
    err: (line = "") => Console.error(line),
  })
}
