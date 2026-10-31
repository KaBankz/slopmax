// A small declarative command-line parser. One table of commands drives
// parsing, `--help` output, errors with suggestions, and shell completions.
//
// Pure functions over plain data: the exact error texts, the exit code they
// lead to, `-1` read as a value, and the trailing-argument rules are all
// part of the contract (see DECISIONS.md), so this is the Rust's parser,
// not `effect/cli`.
import { Effect, Result } from "effect"

import { Failure, text, VERSION } from "@slopmax/core"

/** The program: its commands and the help around them. */
export interface App {
  readonly name: string
  readonly about: string
  readonly afterHelp: string
  /** The command run when none is given. */
  readonly default: string
  readonly commands: ReadonlyArray<Command>
}

export interface Command {
  readonly name: string
  readonly alias: string | undefined
  readonly about: string
  readonly args: ReadonlyArray<Arg>
}

export interface Arg {
  readonly name: string
  readonly help: string
  readonly kind: Kind
}

export type Kind =
  /** A positional value that must be given; `choices` may restrict it. */
  | { readonly _tag: "Required"; readonly choices: ReadonlyArray<Choice> }
  /** A positional value that may be left out, falling back to `default`. */
  | { readonly _tag: "Optional"; readonly choices: ReadonlyArray<Choice>; readonly default: string }
  /** Every remaining argument, verbatim (flags included). */
  | { readonly _tag: "Rest" }
  /** `--name`, or `-x` with a short form. */
  | { readonly _tag: "Flag"; readonly short: string | undefined }
  /** `--name VALUE`, `--name=VALUE`, or `-x VALUE`. */
  | { readonly _tag: "Value"; readonly short: string | undefined; readonly placeholder: string }

export const Kind = {
  Required: (choices: ReadonlyArray<Choice> = []): Kind => ({ _tag: "Required", choices }),
  Optional: (choices: ReadonlyArray<Choice>, value: string): Kind => ({ _tag: "Optional", choices, default: value }),
  Rest: { _tag: "Rest" } satisfies Kind,
  Flag: (short?: string): Kind => ({ _tag: "Flag", short }),
  Value: (short: string | undefined, placeholder: string): Kind => ({ _tag: "Value", short, placeholder }),
} as const

/** One accepted value of a positional argument. */
export interface Choice {
  readonly value: string
  readonly help: string
}

const isPositional = (arg: Arg): boolean => arg.kind._tag === "Required" || arg.kind._tag === "Optional"

const isOption = (arg: Arg): boolean => arg.kind._tag === "Flag" || arg.kind._tag === "Value"

const shortOf = (arg: Arg): string | undefined =>
  arg.kind._tag === "Flag" || arg.kind._tag === "Value" ? arg.kind.short : undefined

const choicesOf = (arg: Arg): ReadonlyArray<Choice> =>
  arg.kind._tag === "Required" || arg.kind._tag === "Optional" ? arg.kind.choices : []

// `str::to_ascii_uppercase`: only `a`–`z` change.
const asciiUpper = (s: string): string => s.replace(/[a-z]+/g, (m) => m.toUpperCase())

/** `<PROVIDER>`, `[SOURCE]`, `[ARGS]...`, `--label <LABEL>`. */
const argUsage = (arg: Arg): string => {
  const upper = asciiUpper(arg.name)
  switch (arg.kind._tag) {
    case "Required":
      return `<${upper}>`
    case "Optional":
      return `[${upper}]`
    case "Rest":
      return `[${upper}]...`
    case "Flag":
      return `--${arg.name}`
    case "Value":
      return `--${arg.name} <${arg.kind.placeholder}>`
  }
}

/** A parsed command line. */
export class Matches {
  constructor(
    readonly command: Command,
    private readonly values: ReadonlyArray<readonly [string, string]>,
    private readonly flags: ReadonlyArray<string>,
    readonly rest: ReadonlyArray<string>,
  ) {}

  flag(name: string): boolean {
    return this.flags.includes(name)
  }

  /**
   * The value of a positional or `--name VALUE` argument (its first
   * occurrence), or the positional's default.
   */
  value(name: string): string | undefined {
    const given = this.values.find(([n]) => n === name)
    if (given !== undefined) return given[1]
    for (const arg of this.command.args) {
      if (arg.kind._tag === "Optional" && arg.name === name) return arg.kind.default
    }
    return undefined
  }

  /**
   * A value converted with `parse` (Rust's `FromStr`, whose error is the
   * reason); required by the caller.
   */
  get<T>(name: string, parse: (value: string) => Result.Result<T, string>): Effect.Effect<T, Failure> {
    const value = this.value(name)
    if (value === undefined) return Effect.fail(new Failure({ message: `missing <${asciiUpper(name)}>` }))
    const parsed = parse(value)
    if (Result.isSuccess(parsed)) return Effect.succeed(parsed.success)
    return Effect.fail(
      new Failure({ message: `invalid <${asciiUpper(name)}> ${text.debug(value)}: ${parsed.failure}` }),
    )
  }

  /** A value taken as it is (`String`'s `FromStr` never fails). */
  string(name: string): Effect.Effect<string, Failure> {
    return this.get(name, Result.succeed)
  }
}

/** What the command line asked for. */
export type Parsed =
  | { readonly _tag: "Run"; readonly matches: Matches }
  /** Help or version text to print. */
  | { readonly _tag: "Print"; readonly text: string }

const run = (matches: Matches): Parsed => ({ _tag: "Run", matches })
const printed = (body: string): Parsed => ({ _tag: "Print", text: body })

/** A command line that does not fit the table. */
export class UsageError {
  constructor(
    readonly message: string,
    readonly usage: string,
    readonly helpHint: string,
  ) {}

  toString(): string {
    return `error: ${this.message}\n\nUsage: ${this.usage}\n\nFor more information, try '${this.helpHint}'.\n`
  }
}

const isAsciiDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9"

export const parse = (app: App, input: Iterable<string>): Result.Result<Parsed, UsageError> => {
  const args = [...input]
  let next = 0
  const take = (): string | undefined => args[next++]
  const appError = (message: string) => Result.fail(new UsageError(message, `${app.name} [COMMAND]`, "--help"))

  let name: string
  const first = take()
  if (first === undefined) name = app.default
  else if (first === "-h" || first === "--help") return Result.succeed(printed(help(app, undefined)))
  else if (first === "-V" || first === "--version") return Result.succeed(printed(`${app.name} ${VERSION}\n`))
  else if (first === "help") {
    const asked = take()
    if (asked === undefined) return Result.succeed(printed(help(app, undefined)))
    const command = find(app, asked)
    return command === undefined ? appError(unknownCommand(app, asked)) : Result.succeed(printed(help(app, command)))
  } else if (first.startsWith("-")) return appError(`unexpected argument '${first}'`)
  else name = first

  const command = find(app, name)
  if (command === undefined) return appError(unknownCommand(app, name))
  const error = (message: string) =>
    Result.fail(new UsageError(message, usage(app, command), `${app.name} ${command.name} --help`))

  const positionals = command.args.filter(isPositional)
  const takesRest = command.args.some((a) => a.kind._tag === "Rest")
  const values: Array<readonly [string, string]> = []
  const flags: Array<string> = []
  const rest: Array<string> = []
  let filled = 0
  let optionsDone = false
  for (let arg = take(); arg !== undefined; arg = take()) {
    // Once the positionals are in, a trailing list takes everything.
    if (takesRest && filled === positionals.length) {
      rest.push(arg, ...args.slice(next))
      next = args.length
      break
    }
    const option = !optionsDone && arg.startsWith("-") && arg.length > 1 && !isAsciiDigit(arg[1])
    if (arg === "--" && !optionsDone) {
      optionsDone = true
      continue
    }
    if (!option) {
      const spec = positionals[filled]
      if (spec === undefined) return error(`unexpected argument '${arg}'`)
      const choices = choicesOf(spec)
      if (choices.length > 0 && !choices.some((c) => c.value === arg)) {
        const possible = choices.map((c) => c.value).join(", ")
        return error(`invalid value '${arg}' for '${argUsage(spec)}'\n  [possible values: ${possible}]`)
      }
      values.push([spec.name, arg])
      filled += 1
      continue
    }
    if (arg === "-h" || arg === "--help") return Result.succeed(printed(help(app, command)))
    let spec: Arg
    let inline: string | undefined
    if (arg.startsWith("--")) {
      const long = arg.slice(2)
      const eq = long.indexOf("=")
      const given = eq < 0 ? long : long.slice(0, eq)
      inline = eq < 0 ? undefined : long.slice(eq + 1)
      // Rust also finds the trailing list here, then panics on it; it is
      // not an option, so it is reported as unknown instead.
      const found = command.args.find((a) => isOption(a) && a.name === given)
      if (found === undefined) return error(unknownOption(command, arg))
      spec = found
    } else {
      // `-rw` sets two flags; `-lVALUE` gives a value.
      const [short = "", ...others] = Array.from(arg.slice(1))
      const found = command.args.find((a) => shortOf(a) === short)
      if (found === undefined) return error(unknownOption(command, arg))
      spec = found
      const remaining = others.join("")
      if (spec.kind._tag === "Value") inline = remaining === "" ? undefined : remaining
      else {
        for (const c of others) {
          const flag = command.args.find((a) => shortOf(a) === c && a.kind._tag === "Flag")
          if (flag === undefined) return error(unknownOption(command, `-${c}`))
          flags.push(flag.name)
        }
        inline = undefined
      }
    }
    if (spec.kind._tag === "Flag") {
      if (inline !== undefined) return error(`'--${spec.name}' takes no value`)
      flags.push(spec.name)
    } else {
      let value = inline
      if (value === undefined) {
        value = take()
        if (value === undefined) return error(`'${argUsage(spec)}' needs a value`)
      }
      values.push([spec.name, value])
    }
  }
  const missing = positionals.slice(filled).find((a) => a.kind._tag === "Required")
  if (missing !== undefined) return error(`the following required argument was not provided: ${argUsage(missing)}`)
  return Result.succeed(run(new Matches(command, values, flags, rest)))
}

const find = (app: App, name: string): Command | undefined =>
  app.commands.find((c) => c.name === name || c.alias === name)

const unknownCommand = (app: App, name: string): string => {
  const close = suggest(
    name,
    app.commands.map((c) => c.name),
  )
  return close === undefined
    ? `unrecognized command '${name}'`
    : `unrecognized command '${name}'\n\n  tip: a similar command exists: '${close}'`
}

const unknownOption = (command: Command, arg: string): string => {
  const names = command.args.filter((a) => !isPositional(a) && a.kind._tag !== "Rest").map((a) => `--${a.name}`)
  const eq = arg.indexOf("=")
  const given = eq < 0 ? arg : arg.slice(0, eq)
  const close = suggest(given, names)
  return close === undefined
    ? `unexpected argument '${arg}'`
    : `unexpected argument '${arg}'\n\n  tip: a similar argument exists: '${close}'`
}

/** The candidate within edit distance 2 of `given`, if any: the closest, the first of equals. */
const suggest = (given: string, candidates: ReadonlyArray<string>): string | undefined => {
  let best: readonly [number, string] | undefined
  for (const c of candidates) {
    const d = distance(given, c)
    if (d <= 2 && (best === undefined || d < best[0])) best = [d, c]
  }
  return best?.[1]
}

/** Levenshtein distance, over characters (Unicode scalar values). */
export const distance = (a: string, b: string): number => {
  const bs = [...b]
  const row = Array.from({ length: bs.length + 1 }, (_, i) => i)
  let i = 0
  for (const ca of a) {
    let diagonal = row[0] ?? 0
    row[0] = i + 1
    for (let j = 0; j < bs.length; j++) {
      const above = row[j + 1] ?? 0
      row[j + 1] = Math.min(above + 1, (row[j] ?? 0) + 1, diagonal + (ca === bs[j] ? 0 : 1))
      diagonal = above
    }
    i += 1
  }
  return row[bs.length] ?? 0
}

export const usage = (app: App, command: Command): string => {
  let out = `${app.name} ${command.name}`
  if (command.args.some((a) => !isPositional(a) && a.kind._tag !== "Rest")) out += " [OPTIONS]"
  for (const arg of command.args) {
    if (isPositional(arg) || arg.kind._tag === "Rest") out += ` ${argUsage(arg)}`
  }
  return out
}

// `str::len`: the length in UTF-8 bytes, which the Rust measures columns by.
const byteLength = (s: string): number => Buffer.byteLength(s)

/** Two-column help rows: a left label padded to a shared width. */
const rows = (title: string, entries: ReadonlyArray<readonly [string, string]>): string => {
  if (entries.length === 0) return ""
  const width = Math.max(0, ...entries.map(([left]) => byteLength(left)))
  let out = `\n${title}:\n`
  for (const [left, right] of entries) out += `  ${text.padEnd(left, width)}  ${right}\n`
  return out
}

/** The help text for the program, or for one command. */
export const help = (app: App, command: Command | undefined): string => {
  if (command === undefined) {
    let out = `${app.about}\n\nUsage: ${app.name} [COMMAND]\n`
    out += rows(
      "Commands",
      app.commands.map((c) => [c.name, `${c.about}${c.alias === undefined ? "" : ` [alias: ${c.alias}]`}`] as const),
    )
    out += rows("Options", [
      ["-h, --help", "Print help"],
      ["-V, --version", "Print version"],
    ])
    return `${out}\n${app.afterHelp}\n`
  }

  let out = `${command.about}\n\nUsage: ${usage(app, command)}\n`
  const args: Array<readonly [string, string]> = []
  for (const arg of command.args) {
    if (!isPositional(arg) && arg.kind._tag !== "Rest") continue
    let about = arg.help
    if (arg.kind._tag === "Optional" && arg.kind.default !== "") about += ` [default: ${arg.kind.default}]`
    args.push([argUsage(arg), about])
    const choices = choicesOf(arg)
    const width = Math.max(0, ...choices.map((c) => byteLength(c.value)))
    for (const choice of choices) args.push(["", `  ${text.padEnd(choice.value, width)}  ${choice.help}`])
  }
  out += rows("Arguments", args)
  const options: Array<readonly [string, string]> = command.args.filter(isOption).map((a) => {
    const short = shortOf(a)
    return [`${short === undefined ? "    " : `-${short}, `}${argUsage(a)}`, a.help] as const
  })
  options.push(["-h, --help", "Print help"])
  out += rows("Options", options)
  return out
}

/** Shells `slopmax completions` can write a script for. */
export type Shell = "bash" | "zsh" | "fish"

export const Shell = {
  parse: (s: string): Result.Result<Shell, string> =>
    s === "bash" || s === "zsh" || s === "fish" ? Result.succeed(s) : Result.fail("expected bash, zsh, or fish"),
} as const

// A command's options, as completions offer them.
const optionWords = (command: Command): Array<string> => [
  ...command.args.filter(isOption).map((a) => `--${a.name}`),
  "--help",
]

// The accepted values of a command's first positional argument.
const firstValues = (command: Command): Array<string> => {
  const first = command.args.find(isPositional)
  return first === undefined ? [] : choicesOf(first).map((c) => c.value)
}

/**
 * A completion script: command names, each command's options, and the
 * accepted values of its first positional argument.
 */
export const completions = (app: App, shell: Shell): string => {
  const name = app.name
  const commands = app.commands.map((c) => c.name)
  let out = ""
  if (shell === "bash" || shell === "zsh") {
    if (shell === "zsh") out += `#compdef ${name}\nautoload -U bashcompinit && bashcompinit\n`
    out += `_${name}() {\n`
    out += "  local cur=${COMP_WORDS[COMP_CWORD]}\n"
    out += '  if [ "$COMP_CWORD" -eq 1 ]; then\n'
    out += `    COMPREPLY=($(compgen -W "${commands.join(" ")} help --help --version" -- "$cur"))\n`
    out += '    return\n  fi\n  case "${COMP_WORDS[1]}" in\n'
    for (const command of app.commands) {
      const words = [...firstValues(command), ...optionWords(command)]
      const names = command.alias === undefined ? command.name : `${command.name}|${command.alias}`
      out += `    ${names}) COMPREPLY=($(compgen -W "${words.join(" ")}" -- "$cur")) ;;\n`
    }
    out += `  esac\n}\ncomplete -F _${name} ${name}\n`
    return out
  }
  out += `complete -c ${name} -f\n`
  for (const command of app.commands) {
    out += `complete -c ${name} -n __fish_use_subcommand -a ${command.name} -d '${escape(command.about)}'\n`
    const seen = `__fish_seen_subcommand_from ${command.name}`
    for (const value of firstValues(command)) out += `complete -c ${name} -n '${seen}' -a ${value}\n`
    for (const arg of command.args.filter(isOption)) {
      const short = shortOf(arg)
      const s = short === undefined ? "" : ` -s ${short}`
      const takes = arg.kind._tag === "Value" ? " -r" : ""
      out += `complete -c ${name} -n '${seen}' -l ${arg.name}${s}${takes} -d '${escape(arg.help)}'\n`
    }
  }
  return out
}

const escape = (s: string): string => s.replaceAll("'", "\\'")

// Rust's integer `FromStr` errors.
const EMPTY = "cannot parse integer from empty string"
const INVALID = "invalid digit found in string"
const TOO_LARGE = "number too large to fit in target type"
const TOO_SMALL = "number too small to fit in target type"

// An integer in `[min, max]` as Rust's `FromStr` reads one: an optional
// sign (`-` only when negatives fit), then ASCII digits.
const integer = (s: string, min: bigint, max: bigint): Result.Result<number, string> => {
  if (s === "") return Result.fail(EMPTY)
  const signed = s[0] === "+" || (s[0] === "-" && min < 0n)
  const digits = signed ? s.slice(1) : s
  if (digits === "" || !/^[0-9]+$/.test(digits)) return Result.fail(INVALID)
  const n = s[0] === "-" ? -BigInt(digits) : BigInt(digits)
  if (n > max) return Result.fail(TOO_LARGE)
  if (n < min) return Result.fail(TOO_SMALL)
  return Result.succeed(Number(n))
}

/** `i32::from_str`. */
export const i32 = (s: string): Result.Result<number, string> => integer(s, -(2n ** 31n), 2n ** 31n - 1n)

/** `usize::from_str` (64-bit). */
export const usize = (s: string): Result.Result<number, string> => integer(s, 0n, 2n ** 64n - 1n)
