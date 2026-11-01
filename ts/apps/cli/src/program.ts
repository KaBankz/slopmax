// One run of the CLI, from its arguments to its exit status. effect/cli
// parses and prints help, the version and completion scripts; everything
// else ends here: a usage mistake exits 2, a failure prints `error: …` and
// exits 1, a command with a status of its own (the doctor, `run`) exits with
// it, and a question someone quit exits as Ctrl-C does.
import { slopmaxVersion } from "@slopmax/domain"
import { Cause, Console, Effect, Exit, Layer } from "effect"
import { CliConfig, CliError, CliOutput, Command, GlobalFlag, TerminalCapabilities } from "effect/cli"
import { type Actions, argsFor, makeCli } from "./cli.ts"
import { Cancelled, ExitWith, failureText, interruptedExit, usageExit } from "./failure.ts"
import { paint } from "./print.ts"

/** Help and completions as effect/cli writes them; the version as `slopmax 1.2.3`; mistakes on stderr. */
const presenter: CliOutput.Presenter = {
  present: (event) =>
    Effect.gen(function* () {
      const { canColor } = yield* TerminalCapabilities.TerminalCapabilities
      const formatter = CliOutput.defaultFormatter({ colors: canColor })
      const style = paint(canColor)
      switch (event._tag) {
        case "Help":
          return yield* Console.log(formatter.formatHelpDoc(event.helpDoc))
        case "Version":
          return yield* Console.log(`slopmax ${event.version}`)
        case "InvalidInvocation": {
          for (const error of event.errors) yield* Console.error(`${style.red("error:")} ${error.message}`)
          return yield* Console.error(`\nSee \`${event.commandPath.join(" ")} --help\`.`)
        }
      }
    }),
}

/** effect/cli's own: help, the version, and completion scripts; no wizard, no log level flag. */
const cliLayer = Layer.mergeAll(
  CliOutput.layerPresenter(presenter),
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
)

/**
 * The exit status a failure ends the process with, after saying why when it
 * has not been said. Commands fail with the CLI's own errors and with the
 * engine's, each of which says what went wrong in its message, so anything
 * but the parser's errors and the CLI's two endings is said the same way.
 */
const ending = (error: unknown): Effect.Effect<number> =>
  Effect.gen(function* () {
    if (CliError.isCliError(error)) {
      // Help and the parser's errors were printed already.
      if (error._tag === "ShowHelp") return usageExit
      yield* Console.error(`error: ${error.message}`)
      return usageExit
    }
    if (error instanceof ExitWith) return error.code
    if (error instanceof Cancelled) return interruptedExit
    const { canColor } = yield* TerminalCapabilities.TerminalCapabilities
    yield* Console.error(`${paint(canColor).red("error:")} ${failureText(error)}`)
    return 1
  })

/** Runs the CLI over `actions` with `argv` (without the program's own name) and gives its exit status. */
export const program = <E, R>(actions: Actions<E, R>, argv: ReadonlyArray<string>) =>
  Command.runWith(makeCli(actions), { version: slopmaxVersion })(argsFor(argv)).pipe(
    Effect.as(0),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.succeed(interruptedExit)
      const failure = cause.reasons.find(Cause.isFailReason)
      return failure === undefined
        ? Effect.andThen(Console.error(`error: ${Cause.pretty(cause)}`), Effect.succeed(1))
        : ending(failure.error)
    }),
    Effect.provide(cliLayer),
  )

/** How the process exits once the program is done: with its status, or 130 when it was interrupted. */
export const exitCode = (exit: Exit.Exit<unknown, unknown>): number => {
  if (Exit.isSuccess(exit)) return typeof exit.value === "number" ? Math.min(255, Math.max(0, exit.value)) : 0
  return Cause.hasInterruptsOnly(exit.cause) ? interruptedExit : 1
}
