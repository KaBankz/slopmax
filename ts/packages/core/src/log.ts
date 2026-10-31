// slopmax's log lines: `{time} {LABEL} {message}`, one per line, to stderr
// or to the daemon's log file.
//
// The level comes from `SLOPMAX_LOG`: `off` (or `none`), `error`, `warn` (or
// `warning`), `info`, `debug` (or `trace`), in any case and with spaces
// around. A filter such as `slopmax=info,other=warn` is read too; the last
// directive for slopmax, or one naming no target, wins. Anything else leaves
// the caller's default, which is warnings and errors only. Labels are five
// wide so messages line up, and colored only on a terminal without
// `NO_COLOR`.
import { formatLogInstant } from "@slopmax/domain"
import {
  Array,
  Cause,
  Config,
  DateTime,
  Effect,
  type FileSystem,
  Formatter,
  Layer,
  Logger,
  type LogLevel,
  Option,
  type PlatformError,
  References,
} from "effect"

/** Reads one level, in any case and with spaces around; `debug` and `trace` both show everything. */
export const parseLevel = (text: string): Option.Option<LogLevel.LogLevel> => {
  switch (text.trim().toLowerCase()) {
    case "off":
    case "none":
      return Option.some("None")
    case "error":
      return Option.some("Error")
    case "warn":
    case "warning":
      return Option.some("Warn")
    case "info":
      return Option.some("Info")
    case "debug":
    case "trace":
      return Option.some("All")
    default:
      return Option.none()
  }
}

/** Reads `info` or `slopmax=info,other=warn`: the last directive for slopmax, or without a target, wins. */
export const parseLogFilter = (filter: string): Option.Option<LogLevel.LogLevel> => {
  for (const directive of filter.split(",").toReversed()) {
    const equals = directive.indexOf("=")
    if (equals < 0) {
      const level = parseLevel(directive)
      if (Option.isSome(level)) return level
      continue
    }
    if (directive.slice(0, equals).trim() !== "slopmax") continue
    const level = parseLevel(directive.slice(equals + 1))
    if (Option.isSome(level)) return level
  }
  return Option.none()
}

type Shown = "error" | "warn" | "info" | "debug"

const shown = (level: LogLevel.LogLevel): Shown => {
  switch (level) {
    case "Fatal":
    case "Error":
      return "error"
    case "Warn":
      return "warn"
    case "Info":
      return "info"
    default:
      return "debug"
  }
}

/** Five wide, so messages line up. */
export const labels: { readonly [K in Shown]: string } = {
  error: "ERROR",
  warn: "WARN ",
  info: "INFO ",
  debug: "DEBUG",
}

/** ANSI colors, one per level: red, yellow, green, dim. */
export const colors: { readonly [K in Shown]: string } = { error: "31", warn: "33", info: "32", debug: "2" }

const textOf = (part: unknown): string => (typeof part === "string" ? part : Formatter.format(part))

/** One log line, without its newline. */
export const formatLine = (options: {
  readonly date: Date
  readonly level: LogLevel.LogLevel
  readonly message: unknown
  readonly cause?: Cause.Cause<unknown> | undefined
  readonly color: boolean
}): string => {
  const level = shown(options.level)
  const label = options.color ? `\u001b[${colors[level]}m${labels[level]}\u001b[0m` : labels[level]
  const text = Array.ensure(options.message).map(textOf).join(" ")
  const cause =
    options.cause === undefined || options.cause.reasons.length === 0 ? "" : `\n${Cause.pretty(options.cause)}`
  return `${formatLogInstant(DateTime.fromDateUnsafe(options.date))} ${label} ${text}${cause}`
}

/** slopmax's line format as an Effect logger. */
export const lineLogger = (color: boolean): Logger.Logger<unknown, string> =>
  Logger.make(({ date, logLevel, message, cause }) => formatLine({ date, level: logLevel, message, cause, color }))

/** The least severe level `SLOPMAX_LOG` asks to see, else `fallback`. */
export const levelFromEnv = (fallback: LogLevel.LogLevel): Config.Config<LogLevel.LogLevel> =>
  Config.option(Config.String("SLOPMAX_LOG")).pipe(
    Config.map((text) => Option.getOrElse(Option.flatMap(text, parseLogFilter), () => fallback)),
  )

export interface LogOptions {
  /** The level when `SLOPMAX_LOG` sets none: warnings and errors unless told otherwise. */
  readonly fallback?: LogLevel.LogLevel | undefined
  /** Write to this file (appended, created 0600) instead of stderr: the background daemon's log. */
  readonly file?: string | undefined
  /** Whether stderr is a terminal, for colors. Read from the process unless given. */
  readonly terminal?: boolean | undefined
}

/**
 * Replaces Effect's default logger with slopmax's lines and sets the level
 * from `SLOPMAX_LOG`. Lines go to stderr (through `Console`, so tests can
 * read them), colored on a terminal without `NO_COLOR`; or to a file.
 */
export const layer = (
  options: LogOptions = {},
): Layer.Layer<never, Config.ConfigError | PlatformError.PlatformError, FileSystem.FileSystem> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const minimum = yield* levelFromEnv(options.fallback ?? "Warn")
      const level = Layer.succeed(References.MinimumLogLevel)(minimum)
      if (options.file !== undefined) {
        const toFile = Logger.toFile(lineLogger(false), options.file, { flag: "a", mode: 0o600 })
        return Layer.merge(Logger.layer([toFile]), level)
      }
      const noColor = Option.isSome(yield* Config.option(Config.String("NO_COLOR")))
      const terminal = options.terminal ?? process.stderr.isTTY === true
      return Layer.merge(Logger.layer([Logger.withConsoleError(lineLogger(terminal && !noColor))]), level)
    }),
  )
