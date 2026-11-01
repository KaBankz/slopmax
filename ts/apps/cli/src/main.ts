// The slopmax binary: the CLI over Bun's platform layer, exiting with the
// status the command ended with. `./version.ts` comes first so that
// `slopmax --version` answers before anything else loads.
// oxlint-disable-next-line import/no-unassigned-import -- it runs for what it does: answering --version first
import "./version.ts"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { liveActions } from "./actions.ts"
import { exitCode, program } from "./program.ts"

BunRuntime.runMain(program(liveActions, process.argv.slice(2)).pipe(Effect.provide(BunServices.layer)), {
  // Failures are said by the program itself, in one line.
  disableErrorReporting: true,
  teardown: (exit, onExit) => onExit(exitCode(exit)),
})
