// A second slopmax process for the lock tests: takes `name` on the home at
// `root`, says so on stdout, and holds it until it is killed.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Home } from "../../src/home.ts"
import { Lock } from "../../src/lock.ts"

const [root = "", name = "test"] = process.argv.slice(2)

const services = Lock.layer.pipe(Layer.provideMerge(Home.layerAt(root)), Layer.provideMerge(BunServices.layer))

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* Lock
      yield* lock.hold(name)
      yield* Console.log("held")
      return yield* Effect.never
    }),
  ).pipe(Effect.provide(services)),
)
