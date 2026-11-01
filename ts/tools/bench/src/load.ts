// Load runs with oha: the requests Claude Code and Codex send, one at a
// time or 32 at once, against the proxy or the raw probe.
import { withDefault } from "@slopmax/domain"
import { fixed } from "@slopmax/domain/format"
import { Effect, Schema } from "effect"
import type { BodyName } from "./bodies.ts"
import { benchKey } from "./rig.ts"
import { run } from "./programs.ts"

/** Who a load speaks as: the path, and the headers that agent sends. */
export const agents = {
  claude: {
    path: "/claude/v1/messages?beta=true",
    headers: {
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "x-claude-code-session-id": "bench",
    },
  },
  codex: { path: "/codex/responses", headers: { session_id: "bench" } },
} as const satisfies Record<string, { readonly path: string; readonly headers: Readonly<Record<string, string>> }>

export type AgentName = keyof typeof agents

/** How many requests: a fixed count, or as many as fit in a duration. */
export type Amount = { readonly requests: number } | { readonly seconds: number }

/** One load: who sends what, how many at once, and for how long. */
export interface Load {
  readonly name: string
  readonly agent: AgentName
  readonly body: BodyName
  readonly concurrency: number
  readonly amount: Amount
}

/** The loads DIST-012 measures, with 32-at-once runs lasting `seconds`. */
export const benchLoads = (seconds: number): ReadonlyArray<Load> => [
  {
    name: "claude small, one at a time",
    agent: "claude",
    body: "claude-small",
    concurrency: 1,
    amount: { requests: 300 },
  },
  { name: "claude small, 32 at once", agent: "claude", body: "claude-small", concurrency: 32, amount: { seconds } },
  {
    name: "claude 300 KB, one at a time",
    agent: "claude",
    body: "claude-large",
    concurrency: 1,
    amount: { requests: 200 },
  },
  { name: "claude 300 KB, 32 at once", agent: "claude", body: "claude-large", concurrency: 32, amount: { seconds } },
  { name: "codex small, 32 at once", agent: "codex", body: "codex-small", concurrency: 32, amount: { seconds } },
  { name: "codex 300 KB, 32 at once", agent: "codex", body: "codex-large", concurrency: 32, amount: { seconds } },
]

/** oha's arguments for `load` against `base`, sending the file `bodyFile`. */
export const ohaArgs = (load: Load, base: string, bodyFile: string): ReadonlyArray<string> => {
  const agent = agents[load.agent]
  return [
    "--no-tui",
    "--output-format",
    "json",
    "-m",
    "POST",
    "-H",
    `authorization: Bearer ${benchKey}`,
    "-H",
    "content-type: application/json",
    ...Object.entries(agent.headers).flatMap(([name, value]) => ["-H", `${name}: ${value}`]),
    "-c",
    String(load.concurrency),
    ...("requests" in load.amount ? ["-n", String(load.amount.requests)] : ["-z", `${load.amount.seconds}s`]),
    "-D",
    bodyFile,
    `${base}${agent.path}`,
  ]
}

/** The parts of oha's JSON report the bench reads; times are in seconds. */
export class OhaReport extends Schema.Class<OhaReport>("OhaReport")({
  summary: Schema.Struct({ successRate: Schema.Finite, requestsPerSec: Schema.Finite }),
  latencyPercentiles: Schema.Struct({ p50: Schema.NullOr(Schema.Finite), p99: Schema.NullOr(Schema.Finite) }),
  statusCodeDistribution: Schema.Record(Schema.String, Schema.Finite).pipe(withDefault({})),
}) {}

/** What one load came to. */
export interface Outcome {
  /** The share of requests answered 200, 0 to 1: oha counts any answer as a success. */
  readonly ok: number
  readonly requestsPerSec: number
  readonly p50Ms: number
  readonly p99Ms: number
}

/** A report's figures, counting only 200s as answered. */
export const outcomeOf = (report: OhaReport): Outcome => {
  const counts = Object.entries(report.statusCodeDistribution)
  const total = counts.reduce((sum, [, n]) => sum + n, 0)
  const ok = counts.reduce((sum, [code, n]) => (code === "200" ? sum + n : sum), 0)
  return {
    ok: total === 0 ? 0 : (ok / total) * report.summary.successRate,
    requestsPerSec: report.summary.requestsPerSec,
    p50Ms: (report.latencyPercentiles.p50 ?? 0) * 1000,
    p99Ms: (report.latencyPercentiles.p99 ?? 0) * 1000,
  }
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OhaReport))

/** Runs `load` against `base` with oha (`oha` is how to start it) and reads its report. */
export const runLoad = (oha: ReadonlyArray<string>, load: Load, base: string, bodyFile: string) =>
  Effect.flatMap(run([...oha, ...ohaArgs(load, base, bodyFile)]), decodeReport).pipe(
    Effect.map(outcomeOf),
    Effect.withSpan("Bench.load", { attributes: { load: load.name } }),
  )

/** One row of the load table: `{name}  {ok}% ok  {n} req/s  p50 {ms} ms  p99 {ms} ms`. */
export const loadRow = (name: string, outcome: Outcome): ReadonlyArray<string> => [
  name,
  `${Math.floor(outcome.ok * 100)}% ok`,
  `${Math.floor(outcome.requestsPerSec)} req/s`,
  `p50 ${fixed(outcome.p50Ms, 2)} ms`,
  `p99 ${fixed(outcome.p99Ms, 2)} ms`,
]
