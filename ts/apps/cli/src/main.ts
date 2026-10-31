// The `slopmax` command line: argument parsing, questions, and printing
// around @slopmax/core, which does the work.
//
// Platform services and the environment are provided here, at the edge:
// Bun's services, and the environment read as the Rust reads it (an empty
// variable such as `NO_COLOR=` counts as set).
import process from "node:process"

import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect"

import { error, log } from "@slopmax/core"

import * as commands from "./commands.ts"
import { Terminal } from "./term.ts"
import * as ui from "./ui.ts"

const args = process.argv.slice(2)

// The proxy reports each request; other commands only warn.
const level = args[0] === "serve" ? log.Level.Info : log.Level.Warn

const environment = ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))

const services = Layer.mergeAll(BunServices.layer, Terminal.layer, log.layer(level)).pipe(
  Layer.provideMerge(environment),
)

const program = Effect.gen(function* () {
  yield* ui.init
  return yield* commands.run(args).pipe(
    Effect.map((code) => Math.min(255, Math.max(0, code))),
    Effect.catch((e) => Effect.as(ui.eprintln(`${ui.red("error:")} ${error.chain(e)}`), 1)),
  )
})

const exit = await Effect.runPromiseExit(Effect.provide(program, services))
let code: number
if (Exit.isSuccess(exit)) code = exit.value
else {
  // A defect: a bug, reported as Rust reports a panic.
  process.stderr.write(`slopmax panicked: ${Cause.pretty(exit.cause)}\n`)
  code = 101
}
await Effect.runPromise(ui.flush)
process.exit(code)
