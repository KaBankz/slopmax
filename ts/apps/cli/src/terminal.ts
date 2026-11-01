// Questions, secrets and pasted sign-in addresses, all from one reader of
// stdin: Effect's Terminal reads stdin once for the whole process, and every
// question and every sign-in waiting for a pasted address takes its lines
// from that reader in turn, so no line is lost between them.
//
// At a terminal the questions are effect/cli's prompts (arrow keys, a
// hidden prompt for secrets). Elsewhere nothing is drawn: a yes-or-no
// question reads one line (`y` or `yes` is yes, anything else no, the end of
// input its default), the rest take their defaults, and a secret is the
// whole of stdin, so `slopmax login xai < key.txt` works.
import { Context, Effect, type FileSystem, Layer, type Path, Redacted, Stream, Terminal } from "effect"
import { Prompt, TerminalCapabilities } from "effect/cli"
import { Cancelled } from "./failure.ts"

/** One answer to offer: what it means, its name, and a few words about it. */
export interface Choice<A> {
  readonly value: A
  readonly title: string
  readonly help?: string | undefined
}

export interface Shape {
  /** Whether stdin and stdout are a terminal, so questions can be asked. */
  readonly interactive: boolean
  readonly confirm: (message: string, initial: boolean) => Effect.Effect<boolean, Cancelled>
  /** A line of text; `initial` when nothing is typed. */
  readonly text: (message: string, initial?: string) => Effect.Effect<string, Cancelled>
  readonly choose: <A>(message: string, choices: ReadonlyArray<Choice<A>>, initial: A) => Effect.Effect<A, Cancelled>
  readonly chooseMany: <A>(
    message: string,
    choices: ReadonlyArray<Choice<A>>,
    initial: ReadonlyArray<A>,
  ) => Effect.Effect<ReadonlyArray<A>, Cancelled>
  /** A secret, trimmed: typed without echo at a terminal, else all of stdin. */
  readonly secret: (message: string) => Effect.Effect<string, Cancelled>
  /** Lines as they are typed or pasted, until stdin ends: what a waiting sign-in reads. */
  readonly lines: Stream.Stream<string>
}

/** Reads a yes-or-no answer as typed. */
export const isYes = (answer: string): boolean => ["y", "yes"].includes(answer.trim().toLowerCase())

type PromptServices = FileSystem.FileSystem | Path.Path | Terminal.Terminal

/** The asker over a terminal, interactive or not. */
export const make = (interactive: boolean): Effect.Effect<Shape, never, PromptServices> =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal
    const context = yield* Effect.context<PromptServices>()

    /** A prompt's answer; quitting it cancels the command. */
    const ask = <A>(prompt: Prompt.Prompt<A>): Effect.Effect<A, Cancelled> =>
      prompt.pipe(
        Effect.provideContext(context),
        Effect.mapError(() => new Cancelled()),
      )

    /** The next line, or nothing once stdin has ended. */
    const line = terminal.readLine.pipe(
      Effect.map((text): string | undefined => text),
      Effect.orElseSucceed(() => undefined),
    )

    const lines: Stream.Stream<string> = Stream.fromEffectRepeat(line).pipe(
      Stream.takeWhile((text): text is string => text !== undefined),
    )

    const shown = (text: string) => terminal.display(text).pipe(Effect.ignore)

    const confirm = (message: string, initial: boolean) =>
      interactive
        ? ask(Prompt.Confirm({ message: message.trim(), initial }))
        : Effect.gen(function* () {
            yield* shown(`${message} ${initial ? "[Y/n]" : "[y/N]"} `)
            const answer = yield* line
            yield* shown("\n")
            return answer === undefined || answer.trim() === "" ? initial : isYes(answer)
          })

    const text = (message: string, initial = "") =>
      interactive
        ? ask(Prompt.String({ message: message.trim(), default: initial })).pipe(Effect.map((answer) => answer.trim()))
        : Effect.gen(function* () {
            yield* shown(initial === "" ? `${message} ` : `${message} [${initial}] `)
            const answer = (yield* line)?.trim() ?? ""
            yield* shown("\n")
            return answer === "" ? initial : answer
          })

    const choose = <A>(message: string, choices: ReadonlyArray<Choice<A>>, initial: A) =>
      interactive
        ? ask(
            Prompt.Select({
              message: message.trim(),
              choices: choices.map((choice) => ({
                title: choice.title,
                value: choice.value,
                ...(choice.help === undefined ? {} : { description: choice.help }),
                selected: choice.value === initial,
              })),
            }),
          )
        : Effect.succeed(initial)

    const chooseMany = <A>(message: string, choices: ReadonlyArray<Choice<A>>, initial: ReadonlyArray<A>) =>
      interactive
        ? ask(
            Prompt.MultiSelect({
              message: message.trim(),
              choices: choices.map((choice) => ({
                title: choice.title,
                value: choice.value,
                ...(choice.help === undefined ? {} : { description: choice.help }),
                selected: initial.includes(choice.value),
              })),
            }),
          ).pipe(Effect.map((picked): ReadonlyArray<A> => picked))
        : Effect.succeed(initial)

    const secret = (message: string) =>
      interactive
        ? ask(Prompt.Password({ message: message.trim() })).pipe(Effect.map((typed) => Redacted.value(typed).trim()))
        : Effect.map(Stream.runCollect(lines), (all) => all.join("\n").trim())

    return { interactive, confirm, text, choose, chooseMany, secret, lines } satisfies Shape
  })

/** Questions and pasted lines for this process. */
export class Prompter extends Context.Service<Prompter, Shape>()("slopmax/Prompter") {
  /** Asks at a terminal when stdin and stdout are one, else reads stdin as lines. */
  static readonly layer: Layer.Layer<Prompter, never, PromptServices> = Layer.effect(
    Prompter,
    Effect.gen(function* () {
      const capabilities = yield* TerminalCapabilities.TerminalCapabilities
      return yield* make(capabilities.canPrompt)
    }),
  )
}
