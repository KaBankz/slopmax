// `bun tools/test/map-check.ts [--allow-pending]`: fails when a row of
// docs/parity/test-map.tsv names a test that does not exist, or (without
// --allow-pending) when a Rust test has neither a TypeScript test nor a
// reason it no longer applies. CI runs it strict; `--allow-pending` is for
// checking the rows filled in so far while the port is under way.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command, Flag } from "effect/cli"
import * as TestMap from "./src/test-map.ts"

const mapCheck = Command.make(
  "map-check",
  {
    allowPending: Flag.Boolean("allow-pending").pipe(
      Flag.withDescription("Count rows not yet filled in instead of failing on them"),
      Flag.withDefault(false),
    ),
  },
  ({ allowPending }) =>
    TestMap.run({ root: `${import.meta.dir}/../..`, allowPending }).pipe(
      Effect.asVoid,
      // The problems are already printed, one per line; a stack trace on top would only bury them.
      Effect.catchTag("TestMapInvalid", () =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
).pipe(Command.withDescription("Check docs/parity/test-map.tsv against the Rust tests and the TypeScript test titles"))

Command.run(mapCheck, { version: "1" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
