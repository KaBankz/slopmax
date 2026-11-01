// The bench's commands (`bun tools/bench <command>`):
//
//   mock <host:port>                 the mock provider, until Ctrl-C
//   bodies <dir>                     writes the four request bodies
//   rig <host:port> <mock> <home>    the daemon over bench accounts, from source
//   run [--cli <binary>]             every load, memory, startup and size (mise run bench)
//   demo                             a throwaway slopmax with fake accounts (mise run demo)
//   gates [--cli <binary>] [--json <file>]   the budgets of ARCHITECTURE.md §16 (mise run gates)
//   release-check [--tag <tag>]      the tag names this version and CHANGELOG.md has its notes
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Console, Duration, Effect, Layer } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { splitAddress } from "../raw.ts"
import { bench } from "./bench.ts"
import { writeBodies } from "./bodies.ts"
import { demo } from "./demo.ts"
import { gates } from "./gates.ts"
import { serveMock } from "./mock.ts"
import { releaseCheck } from "./release.ts"
import { rigCommand } from "./rig.ts"

const cliFlag = Flag.String("cli").pipe(
  Flag.withDescription("An AOT slopmax binary built already, instead of building one"),
  Flag.optional,
)

const mock = Command.make(
  "mock",
  { listen: Argument.String("listen").pipe(Argument.withDescription("host:port to listen on")) },
  ({ listen }) =>
    Effect.gen(function* () {
      const url = yield* serveMock(splitAddress(listen))
      yield* Console.error(`mock provider on ${url}`)
      return yield* Effect.never
    }),
).pipe(Command.withDescription("Answer like Claude and ChatGPT, until stopped"))

const bodies = Command.make(
  "bodies",
  { dir: Argument.String("dir").pipe(Argument.withDescription("where to write the bodies")) },
  ({ dir }) => Effect.asVoid(writeBodies(dir)),
).pipe(Command.withDescription("Write claude-small, claude-large, codex-small and codex-large .json"))

const runCommand = Command.make(
  "run",
  {
    cli: cliFlag,
    seconds: Flag.Int("seconds").pipe(Flag.withDescription("How long each 32-at-once load runs"), Flag.withDefault(8)),
  },
  ({ cli, seconds }) => bench({ cli, seconds }),
).pipe(Command.withDescription("Measure the latency, throughput, memory and startup slopmax adds"))

const demoCommand = Command.make("demo", {}, () => demo).pipe(
  Command.withDescription("Run a throwaway slopmax with fake accounts until Ctrl-C (UPSTREAM_PORT, DEMO_PORT)"),
)

const gatesCommand = Command.make(
  "gates",
  {
    cli: cliFlag,
    fallbackBinary: Flag.String("fallback-binary").pipe(
      Flag.withDescription("A --no-aot fallback binary built already, instead of building one"),
      Flag.optional,
    ),
    fallback: Flag.Boolean("fallback").pipe(
      Flag.withDescription(
        "Also build and measure the --no-aot fallback (reported, not gated); --no-fallback leaves it out",
      ),
      Flag.withDefault(true),
    ),
    seconds: Flag.Int("seconds").pipe(Flag.withDescription("How long each 32-at-once load runs"), Flag.withDefault(5)),
    rounds: Flag.Int("rounds").pipe(Flag.withDescription("Runs of each load, the median gated"), Flag.withDefault(3)),
    settle: Flag.Int("settle").pipe(
      Flag.withDescription("Seconds a daemon is left alone before its idle memory is read"),
      Flag.withDefault(10),
    ),
    json: Flag.String("json").pipe(Flag.withDescription("Also write the figures to this file as JSON"), Flag.optional),
  },
  (options) =>
    gates({
      cli: options.cli,
      fallbackBinary: options.fallbackBinary,
      fallback: options.fallback,
      seconds: options.seconds,
      rounds: options.rounds,
      settle: Duration.seconds(options.settle),
      json: options.json,
    }),
).pipe(Command.withDescription("Hold slopmax to the performance budgets of ARCHITECTURE.md §16"))

const releaseCheckCommand = Command.make(
  "release-check",
  {
    tag: Flag.String("tag").pipe(Flag.withDescription("The tag being released; none for a dry run"), Flag.optional),
    changelog: Flag.String("changelog").pipe(
      Flag.withDescription("The changelog the release notes come from"),
      Flag.withDefault(`${import.meta.dir}/../../../../CHANGELOG.md`),
    ),
  },
  ({ tag, changelog }) => releaseCheck(tag, changelog),
).pipe(Command.withDescription("Check that a tag names slopmax's version and CHANGELOG.md has its notes"))

export const benchCli = Command.make("bench").pipe(
  Command.withDescription("slopmax's bench rig, demo and performance gates"),
  Command.withSubcommands([mock, bodies, rigCommand, runCommand, demoCommand, gatesCommand, releaseCheckCommand]),
)

/** One line for a failure; effect/cli has already said what was wrong with the command line. */
export const failureText = (cause: Cause.Cause<unknown>): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const failure = cause.reasons.find(Cause.isFailReason)
  if (failure === undefined) return Cause.pretty(cause)
  if (CliError.isCliError(failure.error)) return undefined
  return failure.error instanceof Error ? failure.error.message : Cause.pretty(cause)
}

if (import.meta.main) {
  BunRuntime.runMain(
    Command.run(benchCli, { version: "bench" }).pipe(
      Effect.scoped,
      Effect.tapCause((cause) => {
        const text = failureText(cause)
        return text === undefined ? Effect.void : Console.error(text)
      }),
      Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  )
}
