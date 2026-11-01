// The bench rig as a program of its own, compiled with the same flags as
// the slopmax binary so the gates measure the daemon as it ships:
//
//   rig <host:port> <mock-url> <home>
//
// It serves until SIGINT or SIGTERM, then stops the way slopmax does.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { rigCommand } from "./rig.ts"

BunRuntime.runMain(Command.run(rigCommand, { version: "bench" }).pipe(Effect.provide(BunServices.layer)))
