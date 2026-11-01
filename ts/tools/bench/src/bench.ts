// `bun tools/bench run` (`mise run bench`): what slopmax adds, side by side
// with the raw probe. Every load Claude Code and Codex send, through the rig
// and through the probe; the daemon's memory idle, at its peak and after;
// then the CLI's startup and size. It reports and never fails on a figure:
// holding figures to budgets is `gates`.
import { TestHome } from "@slopmax/test"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { writeBodies } from "./bodies.ts"
import { show, table } from "./budgets.ts"
import { buildCli, compileLikeCli, entries } from "./builds.ts"
import { benchLoads, loadRow, runLoad } from "./load.ts"
import { memoryOf, median, startupTimes, untilHealthy } from "./measure.ts"
import { serveMock } from "./mock.ts"
import { start } from "./programs.ts"
import { prepareHome } from "./rig.ts"
import { freeListen, nowhere, probeEnv, resolveCanary, resolveTools, sandboxEnv, timeCommands } from "./workbench.ts"

export interface BenchOptions {
  /** An AOT binary built already; else it is built here. */
  readonly cli: Option.Option<string>
  /** How long each 32-at-once load runs. */
  readonly seconds: number
}

const url = (listen: string) => `http://${listen}`

export const bench = Effect.fn("Bench.run")(function* (options: BenchOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tools = yield* resolveTools
  const canary = yield* resolveCanary
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-bench-" })
  const cli = Option.isSome(options.cli)
    ? path.resolve(options.cli.value)
    : yield* buildCli(canary, "compile", path.join(work, "slopmax"))
  const rig = yield* compileLikeCli(canary, entries.rig, path.join(work, "rig"))
  const raw = yield* compileLikeCli(canary, entries.raw, path.join(work, "raw"))

  yield* Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
      const bodyFile = yield* writeBodies(path.join(work, "bodies"))
      const home = yield* TestHome.make("bench-rig")
      const rigListen = yield* freeListen
      const rawListen = yield* freeListen
      const proxy = yield* start([rig, rigListen, upstream, home.slopmax], sandboxEnv(home.env, rigListen))
      yield* start([raw, rawListen, upstream], probeEnv(home.env))
      yield* untilHealthy(`${url(rigListen)}/healthz`)
      yield* untilHealthy(`${url(rawListen)}/healthz`)
      yield* Effect.sleep("500 millis")
      const idle = yield* memoryOf(proxy.pid)
      const rows: Array<ReadonlyArray<string>> = []
      for (const load of benchLoads(options.seconds)) {
        rows.push(loadRow(load.name, yield* runLoad([tools.oha], load, url(rigListen), bodyFile(load.body))))
        rows.push(loadRow(`  raw probe`, yield* runLoad([tools.oha], load, url(rawListen), bodyFile(load.body))))
      }
      const after = yield* memoryOf(proxy.pid)
      yield* Console.log(`Requests through the proxy, and through the raw probe\n${table(rows)}`)
      yield* Console.log(
        `Memory: ${show("bytes", idle.rss)} idle, ${show("bytes", after.peak)} at peak, ${show("bytes", after.rss)} after`,
      )
    }),
  )

  yield* Effect.scoped(
    Effect.gen(function* () {
      const home = yield* TestHome.make("bench-cli")
      const listen = yield* freeListen
      yield* prepareHome({ listen, upstream: nowhere, root: home.slopmax, keepExpiring: true })
      const env = sandboxEnv(home.env, listen)
      const [version = [], status = []] = yield* timeCommands(
        tools.hyperfine,
        [`${cli} --version`, `${cli} status --json`],
        env,
        path.join(work, "startup.json"),
        100,
      )
      const serve = yield* startupTimes([cli, "serve"], env, `${url(listen)}/healthz`, 10)
      yield* Console.log(
        `Startup\n${table([
          ["slopmax --version", show("ms", median(version))],
          ["slopmax status --json", show("ms", median(status))],
          ["slopmax serve, until it answers", show("ms", median(serve))],
        ])}`,
      )
    }),
  )
  yield* Console.log(`Binary: ${Number((yield* fs.stat(cli)).size)} bytes`)
})
