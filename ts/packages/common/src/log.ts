// A small leveled logger writing to stderr, which the background proxy
// redirects to its log file.
//
// `SLOPMAX_LOG` sets the level: `error`, `warn`, `info`, `debug`, or `off`.
// Filters in the `slopmax=debug` form that earlier versions documented are
// read too.
//
// Code outside Effect calls `error`, `warn`, and `info`; inside Effect,
// `Effect.logWarning` and friends reach the same output once `layer` is
// provided.
import process from "node:process"

import { Cause, Config, Effect, Inspectable, Layer, type LogLevel, Logger, Option, References } from "effect"

import { asciiLowercase, trim } from "./text.ts"
import { Timestamp } from "./time.ts"

export const Level = { Error: 1, Warn: 2, Info: 3, Debug: 4 } as const

/** A level; a lower number is more severe, so `Level.Error < Level.Warn`. */
export type Level = (typeof Level)[keyof typeof Level]

/** The setting that writes nothing. */
export const Off = 0
export type Off = typeof Off

/**
 * A level name, or `Off` for `off` and `none`; undefined when the text
 * names neither.
 */
export const parseLevel = (text: string): Level | Off | undefined => {
  switch (asciiLowercase(trim(text))) {
    case "off":
    case "none":
      return Off
    case "error":
      return Level.Error
    case "warn":
    case "warning":
      return Level.Warn
    case "info":
      return Level.Info
    case "debug":
    case "trace":
      return Level.Debug
    default:
      return undefined
  }
}

/** The five-wide label that starts a line, so messages line up. */
export const label = (level: Level): string => LABELS[level]

/** The ANSI color of the label. */
export const color = (level: Level): string => COLORS[level]

const LABELS = { 1: "ERROR", 2: "WARN ", 3: "INFO ", 4: "DEBUG" } as const satisfies Record<Level, string>
const COLORS = { 1: "31", 2: "33", 3: "32", 4: "2" } as const satisfies Record<Level, string>

// The most verbose level written; `Off` means logging is off.
let maxLevel: Level | Off = Level.Warn
let useColor = false

/**
 * Reads `info` or `slopmax=info,other=warn`; the last directive for
 * slopmax (or without a target) wins.
 */
export const parseFilter = (filter: string): Level | Off | undefined => {
  const directives = filter.split(",")
  for (let i = directives.length - 1; i >= 0; i--) {
    const directive = directives[i] ?? ""
    const eq = directive.indexOf("=")
    if (eq < 0) {
      const level = parseLevel(directive)
      if (level !== undefined) return level
    } else if (trim(directive.slice(0, eq)) === "slopmax") {
      const level = parseLevel(directive.slice(eq + 1))
      if (level !== undefined) return level
    }
  }
  return undefined
}

/** Sets the level and coloring directly; `init` does this from the environment. */
export const configure = (options: { readonly level?: Level | Off; readonly color?: boolean }): void => {
  if (options.level !== undefined) maxLevel = options.level
  if (options.color !== undefined) useColor = options.color
}

/**
 * Sets the level from `SLOPMAX_LOG`, or `fallback` when it is unset or
 * unreadable, and colors labels when stderr is a terminal and `NO_COLOR`
 * is unset. Returns the level set.
 *
 * Effect's default environment provider reads an empty variable as unset;
 * the Rust's `var_os` counts `NO_COLOR=` as set. Provide
 * `ConfigProvider.fromEnv({ preserveEmptyStrings: true })` at the edge to
 * read it as the Rust does.
 */
export const init = Effect.fn("log.init")(function* (fallback: Level) {
  const filter = yield* Config.option(Config.String("SLOPMAX_LOG"))
  const noColor = yield* Config.option(Config.String("NO_COLOR"))
  const level = Option.getOrUndefined(Option.map(filter, parseFilter)) ?? fallback
  configure({ level, color: Option.isNone(noColor) && process.stderr.isTTY === true })
  return level
})

export const enabled = (level: Level): boolean => level <= maxLevel

const line = (level: Level, time: Timestamp, message: string): string => {
  const tag = useColor ? `\x1b[${color(level)}m${label(level)}\x1b[0m` : label(level)
  return `${Timestamp.displayMillis(time)} ${tag} ${message}\n`
}

/** Writes one line, whatever the level; callers check `enabled` first. */
export const write = (level: Level, message: string, time: Timestamp = Timestamp.nowUnsafe()): void => {
  try {
    process.stderr.write(line(level, time, message))
  } catch {
    // As `let _ = writeln!(…)`: a closed stderr loses the line, nothing more.
  }
}

const at = (level: Level) => (message: string) => {
  if (enabled(level)) write(level, message)
}

export const error: (message: string) => void = at(Level.Error)
export const warn: (message: string) => void = at(Level.Warn)
export const info: (message: string) => void = at(Level.Info)

const fromEffect = (level: LogLevel.LogLevel): Level | undefined => {
  switch (level) {
    case "Fatal":
    case "Error":
      return Level.Error
    case "Warn":
      return Level.Warn
    case "Info":
      return Level.Info
    case "Debug":
    case "Trace":
      return Level.Debug
    default:
      return undefined
  }
}

const render = (message: unknown): string => {
  const parts = Array.isArray(message) ? message : [message]
  return parts.map((part) => (typeof part === "string" ? part : Inspectable.toStringUnknown(part))).join(" ")
}

/** Effect's log calls, written in slopmax's format and filtered by the level `init` set. */
export const logger: Logger.Logger<unknown, void> = Logger.make(({ logLevel, message, cause, date }) => {
  const level = fromEffect(logLevel)
  if (level === undefined || !enabled(level)) return
  const text = render(message)
  write(level, cause.reasons.length > 0 ? `${text} ${Cause.pretty(cause)}` : text, date.getTime())
})

// Effect's minimum level for ours: `Trace` too goes out as `DEBUG`.
const toEffect = (level: Level | Off): LogLevel.LogLevel => {
  switch (level) {
    case Off:
      return "None"
    case Level.Error:
      return "Error"
    case Level.Warn:
      return "Warn"
    case Level.Info:
      return "Info"
    case Level.Debug:
      return "Trace"
  }
}

/**
 * Runs `init(fallback)` and routes Effect's logging through `logger` in
 * place of the default one. Effect's minimum level is set from the same
 * level, so calls below it are dropped before a log entry is built.
 */
export const layer = (fallback: Level): Layer.Layer<never, Config.ConfigError> =>
  Layer.merge(Logger.layer([logger]), Layer.effect(References.MinimumLogLevel, Effect.map(init(fallback), toEffect)))
