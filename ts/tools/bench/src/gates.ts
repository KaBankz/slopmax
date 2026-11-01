// `bun tools/bench gates`: builds slopmax as it ships and holds it to the
// budgets of ARCHITECTURE.md §16, printing a table, writing the figures as
// JSON when asked, and failing when any budget does not hold.
//
// The size, startup and idle figures are the CLI binary's own. Throughput,
// latency and peak memory are the rig's, the same daemon code compiled with
// the same flags, whose accounts' providers are the mock; each is compared
// with the raw probe on the same host in the same run, since a shared
// machine's throughput moves by about 15% from minute to minute. Every
// figure is the median of several runs.
import { TestHome } from "@slopmax/test"
import { Console, Data, DateTime, Duration, Effect, FileSystem, Option, Path } from "effect"
import { cpus, loadavg } from "node:os"
import { writeBodies } from "./bodies.ts"
import { GatesReport, judge, Measured, Note, renderReport, reportJson, show } from "./budgets.ts"
import { buildCli, compileLikeCli, entries } from "./builds.ts"
import { type Load, type Outcome, runLoad } from "./load.ts"
import { memoryOf, median, startupTimes, untilHealthy } from "./measure.ts"
import { serveMock } from "./mock.ts"
import { run, start } from "./programs.ts"
import { prepareHome } from "./rig.ts"
import {
  answeredEnough,
  ensureAnswered,
  freeListen,
  nowhere,
  probeEnv,
  resolveCanary,
  resolveTools,
  sandboxEnv,
  settledMemory,
  timeCommands,
  xzSize,
} from "./workbench.ts"

export interface GatesOptions {
  /** An AOT binary built already (`mise run gates` builds it first); else it is built here. */
  readonly cli: Option.Option<string>
  /** A --no-aot fallback binary built already; else it is built here, unless `fallback` is false. */
  readonly fallbackBinary: Option.Option<string>
  /** Measure the fallback too (reported, not gated). */
  readonly fallback: boolean
  /** How long each 32-at-once load runs. */
  readonly seconds: number
  /** How many times each load runs against each target. */
  readonly rounds: number
  /** How long a daemon is left alone before its idle memory is read. */
  readonly settle: Duration.Duration
  /** Where to write the report as JSON. */
  readonly json: Option.Option<string>
}

/** At least one budget does not hold. */
export class GatesFailed extends Data.TaggedError("GatesFailed")<{ readonly failed: ReadonlyArray<string> }> {
  override get message(): string {
    return `over budget: ${this.failed.join("; ")}`
  }
}

const url = (listen: string) => `http://${listen}`

/** What one binary's startup comes to: `--version` times, serve-to-healthy times, and settled memory. */
const startup = Effect.fn("Bench.gates.startup")(function* (
  binary: string,
  settle: Duration.Duration,
  hyperfine: string,
  work: string,
  name: string,
) {
  const home = yield* TestHome.make(`gates-${name}`)
  const listen = yield* freeListen
  // The startup home of the bench's own startup rows: nothing redeemed, refreshed or polled at start.
  yield* prepareHome({ listen, upstream: nowhere, root: home.slopmax, keepExpiring: true })
  const env = sandboxEnv(home.env, listen)
  const [version = []] = yield* timeCommands(hyperfine, [`${binary} --version`], env, `${work}/${name}.json`, 50)
  const serve = yield* startupTimes([binary, "serve"], env, `${url(listen)}/healthz`, 10)
  const memory = yield* Effect.scoped(settledMemory([binary, "serve"], env, `${url(listen)}/healthz`, settle))
  return { version, serve, idle: memory.rss }
}, Effect.scoped)

/** The loads the gates compare with the raw probe. */
const gatedLoads = (seconds: number) =>
  ({
    small: { name: "small, 32 at once", agent: "claude", body: "claude-small", concurrency: 32, amount: { seconds } },
    large: { name: "300 KB, 32 at once", agent: "claude", body: "claude-large", concurrency: 32, amount: { seconds } },
    single: {
      name: "small, one at a time",
      agent: "claude",
      body: "claude-small",
      concurrency: 1,
      amount: { requests: 300 },
    },
  }) satisfies Record<string, Load>

type Gated = keyof ReturnType<typeof gatedLoads>

const rate = (outcomes: ReadonlyArray<Outcome>) => median(outcomes.map((outcome) => outcome.requestsPerSec))

const p50 = (outcomes: ReadonlyArray<Outcome>) => median(outcomes.map((outcome) => outcome.p50Ms))

/** A throughput share from paired runs: the median of the proxy's over the median of the probe's. */
export const throughputShare = (proxy: ReadonlyArray<Outcome>, raw: ReadonlyArray<Outcome>) => {
  const answered = proxy.every((outcome) => outcome.ok >= answeredEnough)
  const share = rate(raw) === 0 || !answered ? 0 : rate(proxy) / rate(raw)
  const runs = proxy.map((outcome, i) => {
    const probe = raw[i]?.requestsPerSec ?? 0
    return probe === 0 ? 0 : outcome.requestsPerSec / probe
  })
  return { share, runs, answered }
}

/** The p50 the proxy adds over the probe, in milliseconds, from paired runs. */
export const latencyOver = (proxy: ReadonlyArray<Outcome>, raw: ReadonlyArray<Outcome>) => ({
  over: p50(proxy) - p50(raw),
  runs: proxy.map((outcome, i) => outcome.p50Ms - (raw[i]?.p50Ms ?? 0)),
})

const showRate = (outcomes: ReadonlyArray<Outcome>) => `${Math.round(rate(outcomes))} req/s`

/** Why a share counts as nothing, when it does. */
const unanswered = (share: { readonly answered: boolean }) =>
  share.answered ? "" : `; the proxy answered under ${answeredEnough * 100}% with 200, so it counts as 0`

export const gates = Effect.fn("Bench.gates")(function* (options: GatesOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tools = yield* resolveTools
  const canary = yield* resolveCanary
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-gates-" })
  const compiler = (yield* run([...canary, "--revision"])).trim()

  // A binary given with --cli is usually apps/cli/dist/slopmax, where the fallback is built too; buildCli puts
  // back what it found there, so the AOT binary is still the one measured.
  const cli = Option.isSome(options.cli)
    ? path.resolve(options.cli.value)
    : yield* buildCli(canary, "compile", path.join(work, "slopmax"))
  const fallback = options.fallback
    ? Option.some(
        Option.isSome(options.fallbackBinary)
          ? path.resolve(options.fallbackBinary.value)
          : yield* buildCli(canary, "build", path.join(work, "slopmax-fallback")),
      )
    : Option.none<string>()
  const rig = yield* compileLikeCli(canary, entries.rig, path.join(work, "rig"))
  const raw = yield* compileLikeCli(canary, entries.raw, path.join(work, "raw"))

  const measured: Array<Measured> = []
  const notes: Array<Note> = [new Note({ title: "compiler", value: compiler })]
  const note = (title: string, value: string) => notes.push(new Note({ title, value }))

  yield* Console.log("Measuring size")
  const bytes = Number((yield* fs.stat(cli)).size)
  const xzBytes = yield* xzSize(cli)
  measured.push(new Measured({ metric: "binary", value: bytes, runs: [bytes], how: "file size" }))
  measured.push(new Measured({ metric: "binaryXz", value: xzBytes, runs: [xzBytes], how: "xz -9" }))

  yield* Console.log("Measuring startup and idle memory")
  const aot = yield* startup(cli, options.settle, tools.hyperfine, work, "aot")
  measured.push(
    new Measured({
      metric: "version",
      value: median(aot.version),
      runs: aot.version,
      how: `hyperfine median of ${aot.version.length} runs`,
    }),
  )
  measured.push(
    new Measured({
      metric: "serveToHealthy",
      value: median(aot.serve),
      runs: aot.serve,
      how: `median of ${aot.serve.length} starts`,
    }),
  )
  measured.push(
    new Measured({
      metric: "idleRss",
      value: aot.idle,
      runs: [aot.idle],
      how: `VmRSS ${Duration.format(options.settle)} after the first /healthz`,
    }),
  )

  if (Option.isSome(fallback)) {
    const fallbackBytes = Number((yield* fs.stat(fallback.value)).size)
    const fallbackXz = yield* xzSize(fallback.value)
    const figures = yield* startup(fallback.value, options.settle, tools.hyperfine, work, "fallback")
    note("fallback binary", `${show("bytes", fallbackBytes)}, ${show("bytes", fallbackXz)} as xz`)
    note("fallback --version", show("ms", median(figures.version)))
    note("fallback serve to /healthz", show("ms", median(figures.serve)))
    note("fallback idle RSS", show("bytes", figures.idle))
  }

  yield* Console.log("Measuring throughput against the raw probe")
  yield* Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
      const bodyFile = yield* writeBodies(path.join(work, "bodies"))
      const rigHome = yield* TestHome.make("gates-rig")
      const rigListen = yield* freeListen
      const rawListen = yield* freeListen
      const proxy = yield* start([rig, rigListen, upstream, rigHome.slopmax], sandboxEnv(rigHome.env, rigListen))
      yield* start([raw, rawListen, upstream], probeEnv(rigHome.env))
      yield* untilHealthy(`${url(rigListen)}/healthz`)
      yield* untilHealthy(`${url(rawListen)}/healthz`)
      const rigIdle = yield* memoryOf(proxy.pid)

      // The probe must answer every load, or the comparison measures its failures; the proxy's own misses count against it below.
      const against = (base: string, load: Load) =>
        Effect.tap(runLoad([tools.oha], load, base, bodyFile(load.body)), (outcome) =>
          base === url(rawListen) ? ensureAnswered("raw probe", outcome.ok) : Effect.void,
        )
      // A short run on each first, so neither is measured while it warms up.
      const warmup: Load = {
        name: "warmup",
        agent: "claude",
        body: "claude-small",
        concurrency: 32,
        amount: { requests: 2000 },
      }
      yield* against(url(rawListen), warmup)
      yield* against(url(rigListen), warmup)

      const loads = gatedLoads(options.seconds)
      const results: Record<Gated, { proxy: Array<Outcome>; raw: Array<Outcome> }> = {
        small: { proxy: [], raw: [] },
        large: { proxy: [], raw: [] },
        single: { proxy: [], raw: [] },
      }
      for (let round = 0; round < options.rounds; round += 1) {
        for (const key of ["small", "large", "single"] as const) {
          results[key].raw.push(yield* against(url(rawListen), loads[key]))
          results[key].proxy.push(yield* against(url(rigListen), loads[key]))
        }
      }
      const rigMemory = yield* memoryOf(proxy.pid)

      const small = throughputShare(results.small.proxy, results.small.raw)
      const large = throughputShare(results.large.proxy, results.large.raw)
      const single = latencyOver(results.single.proxy, results.single.raw)
      measured.push(
        new Measured({
          metric: "smallThroughput",
          value: small.share,
          runs: small.runs,
          how: `median req/s over the probe's, ${options.rounds} runs of ${options.seconds} s${unanswered(small)}`,
        }),
      )
      measured.push(
        new Measured({
          metric: "largeThroughput",
          value: large.share,
          runs: large.runs,
          how: `median req/s over the probe's, ${options.rounds} runs of ${options.seconds} s${unanswered(large)}`,
        }),
      )
      measured.push(
        new Measured({
          metric: "latencyOverRaw",
          value: single.over,
          runs: single.runs,
          how: "median p50 over 300 requests",
        }),
      )
      measured.push(
        new Measured({
          metric: "peakRss",
          value: rigMemory.peak,
          runs: [rigMemory.peak],
          how: "VmHWM of the rig after every load",
        }),
      )
      note("small, 32 at once", `proxy ${showRate(results.small.proxy)}, raw probe ${showRate(results.small.raw)}`)
      note("300 KB, 32 at once", `proxy ${showRate(results.large.proxy)}, raw probe ${showRate(results.large.raw)}`)
      note(
        "small, one at a time, p50",
        `proxy ${show("ms", p50(results.single.proxy))}, raw probe ${show("ms", p50(results.single.raw))}`,
      )
      note("rig RSS", `${show("bytes", rigIdle.rss)} idle, ${show("bytes", rigMemory.rss)} after the loads`)
    }),
  )

  const report = new GatesReport({
    at: DateTime.formatIso(yield* DateTime.now),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, load: loadavg() },
    compiler,
    verdicts: judge(measured),
    notes,
  })
  yield* Console.log(`\n${renderReport(report)}`)
  if (Option.isSome(options.json)) yield* fs.writeFileString(options.json.value, reportJson(report))
  if (!report.passed) {
    return yield* new GatesFailed({
      failed: report.verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.budget.title),
    })
  }
  return report
})
