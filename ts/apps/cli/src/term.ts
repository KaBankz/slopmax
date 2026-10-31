// Reading from the terminal: answers, secrets, and redirect addresses
// pasted during a sign-in. One reader takes every line typed, for the whole
// process, so a question and a sign-in waiting for a paste never compete
// for input.
import process from "node:process"
import { isatty } from "node:tty"

import { Cause, Context, Effect, Layer, Option, Queue, type Scope } from "effect"

import { auth, error, Failure, text } from "@slopmax/core"

import { usize } from "./args.ts"
import * as ui from "./ui.ts"

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const INVALID_UTF8 = "stream did not contain valid UTF-8"

// Whatever is waiting for a secret typed with echo off.
interface Secret {
  typed: string
  // Inside an escape sequence (an arrow key, say), which is dropped: 0 not
  // in one, 1 just after ESC, 2 in its parameters.
  escape: 0 | 1 | 2
  readonly done: (secret: string) => void
}

/**
 * The process's stdin, read once it is first needed and split into lines
 * (without `\n` or `\r\n`), which go into `lines` in order. While a secret
 * is asked for, the terminal is in raw mode and keys go to it instead.
 */
class Reader {
  private started = false
  private ended = false
  private pending = ""
  private secret: Secret | undefined
  private readonly decoder = new TextDecoder()

  constructor(readonly lines: Queue.Queue<string, Cause.Done>) {}

  private readonly onData = (chunk: Uint8Array | string): void => {
    this.take(typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }))
  }

  private readonly onEnd = (): void => this.end()

  start(): void {
    if (this.started) return
    this.started = true
    process.stdin.on("data", this.onData)
    process.stdin.once("end", this.onEnd)
    process.stdin.once("error", this.onEnd)
  }

  /** Lets stdin go, and the terminal out of raw mode if a secret was being typed. */
  stop(): void {
    if (!this.started) return
    process.stdin.off("data", this.onData)
    process.stdin.off("end", this.onEnd)
    process.stdin.off("error", this.onEnd)
    process.stdin.pause()
    if (this.secret !== undefined) {
      this.secret = undefined
      this.raw(false)
    }
  }

  get isStarted(): boolean {
    return this.started
  }

  private take(input: string): void {
    let rest = input
    if (this.secret !== undefined) rest = this.key(this.secret, rest)
    this.pending += rest
    for (let at = this.pending.indexOf("\n"); at >= 0; at = this.pending.indexOf("\n")) {
      const line = this.pending.slice(0, at)
      this.pending = this.pending.slice(at + 1)
      Queue.offerUnsafe(this.lines, line.endsWith("\r") ? line.slice(0, -1) : line)
    }
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    if (this.pending !== "") Queue.offerUnsafe(this.lines, this.pending)
    this.pending = ""
    Queue.endUnsafe(this.lines)
    this.finishSecret(undefined)
  }

  /** Feeds keys to the secret; returns what follows its Enter, for the lines. */
  private key(secret: Secret, input: string): string {
    const chars = [...input]
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i] ?? ""
      if (secret.escape === 1) {
        secret.escape = c === "[" || c === "O" ? 2 : 0
        continue
      }
      if (secret.escape === 2) {
        if (c >= "@" && c <= "~") secret.escape = 0
        continue
      }
      switch (c) {
        case "\r":
        case "\n": {
          const skip = c === "\r" && chars[i + 1] === "\n" ? 2 : 1
          this.finishSecret(secret.typed)
          return chars.slice(i + skip).join("")
        }
        case "\x03":
          // Ctrl-C: the terminal's own handling is off in raw mode.
          this.raw(false)
          process.stderr.write("\n")
          process.kill(process.pid, "SIGINT")
          return ""
        case "\x04":
          // Ctrl-D on an empty line ends input, as it does with echo on.
          if (secret.typed === "") {
            this.end()
            return ""
          }
          break
        case "\x7f":
        case "\b":
          secret.typed = [...secret.typed].slice(0, -1).join("")
          break
        case "\x15":
          secret.typed = ""
          break
        case "\x1b":
          secret.escape = 1
          break
        default:
          if (c >= " ") secret.typed += c
      }
    }
    return ""
  }

  private raw(on: boolean): void {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(on)
    } catch {
      // Not a terminal after all: nothing to turn off.
    }
  }

  private finishSecret(typed: string | undefined): void {
    const secret = this.secret
    if (secret === undefined) return
    this.secret = undefined
    this.raw(false)
    secret.done(typed ?? secret.typed)
  }

  /** Reads one line with echo off, starting from what was typed but not entered yet. */
  readQuietly(done: (secret: string) => void): () => void {
    this.start()
    const secret: Secret = { typed: this.pending, escape: 0, done }
    this.pending = ""
    if (this.ended) {
      done(secret.typed)
      return () => {}
    }
    this.secret = secret
    this.raw(true)
    return () => {
      if (this.secret !== secret) return
      this.secret = undefined
      this.raw(false)
    }
  }
}

/** The terminal: every line typed, in order, and the secrets and pastes read from it. */
export class Terminal extends Context.Service<
  Terminal,
  {
    /** The next line typed, or undefined once input ends. */
    readonly readLine: Effect.Effect<string | undefined>
    /**
     * Reads a secret such as an API key: typed without echo at a terminal,
     * or read whole from stdin when it is piped in, so it never sits in argv
     * or shell history.
     */
    readonly readSecret: (prompt: string) => Effect.Effect<string, Failure>
    /**
     * A sign-in at the terminal: what to do goes to stderr, and the lines
     * typed while it waits (until the scope closes) are taken as pasted
     * redirect addresses.
     */
    readonly signIn: Effect.Effect<auth.Prompt, never, Scope.Scope>
  }
>()("slopmax/term/Terminal", {
  make: Effect.gen(function* () {
    const reader = new Reader(yield* Queue.unbounded<string, Cause.Done>())
    yield* Effect.addFinalizer(() => Effect.sync(() => reader.stop()))

    const readLine: Effect.Effect<string | undefined> = Effect.suspend(() => {
      reader.start()
      return Queue.take(reader.lines).pipe(Effect.catchIf(Cause.isDone, () => Effect.succeed(undefined)))
    })

    // Everything left on a piped stdin; `read_to_string`, which fails on
    // text that is not UTF-8.
    const readAll: Effect.Effect<string, Failure> = Effect.suspend(() => {
      if (!reader.isStarted) {
        return Effect.tryPromise({
          try: () => Bun.stdin.bytes(),
          catch: (e) => new Failure({ message: error.text(e) }),
        }).pipe(
          Effect.flatMap((bytes) =>
            Effect.try({ try: () => strict.decode(bytes), catch: () => new Failure({ message: INVALID_UTF8 }) }),
          ),
        )
      }
      return Effect.gen(function* () {
        const lines: Array<string> = []
        for (let line = yield* readLine; line !== undefined; line = yield* readLine) lines.push(line)
        return lines.join("\n")
      })
    })

    const readSecret = (prompt: string): Effect.Effect<string, Failure> =>
      Effect.gen(function* () {
        if (!isatty(0)) return text.trim(yield* readAll)
        yield* ui.eprint(`${prompt}: `)
        // A line typed ahead was typed before echo went off; it is the answer.
        const ahead = reader.isStarted ? yield* Queue.poll(reader.lines) : Option.none()
        const line = Option.isSome(ahead)
          ? ahead.value
          : yield* Effect.callback<string>((resume) => {
              const cancel = reader.readQuietly((secret) => resume(Effect.succeed(secret)))
              return Effect.sync(cancel)
            })
        yield* ui.eprintln()
        return text.trim(line)
      })

    const signIn: Effect.Effect<auth.Prompt, never, Scope.Scope> = Effect.gen(function* () {
      const pasted = yield* Queue.unbounded<string, Cause.Done>()
      // Takes lines only while the sign-in waits, so the answer after it goes
      // to whatever asks next.
      const forward: Effect.Effect<void> = Effect.gen(function* () {
        for (;;) {
          const line = yield* readLine
          if (line === undefined) {
            yield* Queue.end(pasted)
            return
          }
          yield* Queue.offer(pasted, line)
        }
      })
      yield* Effect.forkScoped(forward)
      return auth.Prompt.make(show).withPasted(pasted)
    })

    return { readLine, readSecret, signIn }
  }),
}) {
  static readonly layer = Layer.effect(Terminal, Terminal.make)
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

const show = (event: auth.LoginEvent): void => {
  switch (event._tag) {
    case "Authorize": {
      const verb = event.opened ? "Opened" : "Authorize"
      say(`\n  ${verb} your ${event.title} account in the browser:\n\n  ${event.url}\n`)
      say(
        `  Waiting for the redirect to localhost:${event.port}. If the browser runs on another\n  ` +
          "machine, paste the final localhost URL from its address bar here.\n",
      )
      return
    }
    case "DeviceCode":
      say(`\n  Open ${event.url}\n  and enter the code: ${event.code}\n`)
      return
    case "Notice":
      say(`  ${event.text}`)
  }
}

/** Reads a secret (see `Terminal.readSecret`). */
export const readSecret = (prompt: string): Effect.Effect<string, Failure, Terminal> =>
  Effect.flatMap(Terminal, (t) => t.readSecret(prompt))

/** A sign-in at the terminal (see `Terminal.signIn`). */
export const signIn: Effect.Effect<auth.Prompt, never, Terminal | Scope.Scope> = Effect.flatMap(
  Terminal,
  (t) => t.signIn,
)

const readLine: Effect.Effect<string | undefined, never, Terminal> = Effect.flatMap(Terminal, (t) => t.readLine)

/** Asks a yes/no question; an empty answer, or none, takes `fallback`. */
export const confirm = Effect.fn("term.confirm")(function* (question: string, fallback: boolean) {
  yield* ui.print(`${question} ${ui.dim(fallback ? "[Y/n]" : "[y/N]")} `)
  const answer = text.asciiLowercase(text.trim((yield* readLine) ?? ""))
  return answer === "" ? fallback : answer === "y" || answer === "yes"
})

/** Asks for a line of text; an empty answer, or none, takes `fallback`. */
export const ask = Effect.fn("term.ask")(function* (question: string, fallback: string) {
  yield* ui.print(fallback === "" ? `${question} ` : `${question} ${ui.dim(`[${fallback}]`)} `)
  const answer = text.trim((yield* readLine) ?? "")
  return answer === "" ? fallback : answer
})

/** An option to choose: its name and what it means. */
export type Choice = readonly [name: string, help: string]

/**
 * Asks for one of `options` by number; an empty answer, or none, takes
 * `fallback`.
 */
export const choose = Effect.fn("term.choose")(function* (
  question: string,
  options: ReadonlyArray<Choice>,
  fallback: number,
) {
  yield* ui.println(question)
  yield* list(options, (i) => i === fallback)
  // Three tries, then the default: input that has ended answers nothing.
  for (let i = 0; i < 3; i++) {
    const answer = yield* ask(`  Choose 1-${options.length}`, String(fallback + 1))
    const chosen = parseChoices(answer, options.length)
    if (chosen !== undefined && chosen.length === 1 && chosen[0] !== undefined) return chosen[0]
    yield* ui.println(`  ${ui.dim("One number, please.")}`)
  }
  return fallback
})

/**
 * Asks for any of `options` by number, separated by commas or spaces; an
 * empty answer, or none, takes `defaults`.
 */
export const chooseMany = Effect.fn("term.chooseMany")(function* (
  question: string,
  options: ReadonlyArray<Choice>,
  defaults: ReadonlyArray<number>,
) {
  yield* ui.println(question)
  yield* list(options, (i) => defaults.includes(i))
  const fallback = defaults.map((i) => String(i + 1)).join(",")
  for (let i = 0; i < 3; i++) {
    const answer = yield* ask(`  Numbers, e.g. 1,3 (${ui.bold("0")} for none)`, fallback)
    // An empty answer takes the defaults, which may be none.
    if (text.trim(answer) === "0" || text.trim(answer) === "") return []
    const chosen = parseChoices(answer, options.length)
    if (chosen !== undefined) return chosen
    yield* ui.println(`  ${ui.dim(`Numbers from 1 to ${options.length}.`)}`)
  }
  return [...defaults]
})

const list = (options: ReadonlyArray<Choice>, marked: (i: number) => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const width = Math.max(0, ...options.map(([name]) => Buffer.byteLength(name)))
    for (const [i, [name, help]] of options.entries()) {
      const mark = marked(i) ? ui.green("•") : " "
      yield* ui.println(`  ${mark} ${ui.dim(String(i + 1).padStart(2))} ${ui.pad(name, width)}  ${ui.dim(help)}`)
    }
  })

/** `"1, 3 2"` → `[0, 2, 1]`, for `len` options; undefined if any is not one. */
export const parseChoices = (answer: string, len: number): Array<number> | undefined => {
  const chosen: Array<number> = []
  for (const part of answer.split(/[, ]/)) {
    if (part === "") continue
    const n = usize(part)
    if (n._tag === "Failure") return undefined
    if (n.success === 0 || n.success > len) return undefined
    if (!chosen.includes(n.success - 1)) chosen.push(n.success - 1)
  }
  return chosen.length > 0 ? chosen : undefined
}
