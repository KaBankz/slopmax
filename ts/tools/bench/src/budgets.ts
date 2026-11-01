// The performance budgets slopmax is held to on Linux (ARCHITECTURE.md §16),
// what a measured figure comes to against each, and the report the gates
// print and write as JSON for side-by-side comparisons.
import { fixed, grouped } from "@slopmax/domain/format"
import { Schema } from "effect"

/** What a figure counts. */
export const Unit = Schema.Literals(["bytes", "ms", "share"])
export type Unit = typeof Unit.Type

/** Whether a figure must stay under its limit or reach it. */
export const Bound = Schema.Literals(["at most", "at least"])
export type Bound = typeof Bound.Type

/** Every gated figure. */
export const Metric = Schema.Literals([
  "binary",
  "binaryXz",
  "version",
  "serveToHealthy",
  "idleRss",
  "peakRss",
  "smallThroughput",
  "largeThroughput",
  "latencyOverRaw",
])
export type Metric = typeof Metric.Type

export class Budget extends Schema.Class<Budget>("Budget")({
  metric: Metric,
  title: Schema.String,
  bound: Bound,
  limit: Schema.Finite,
  unit: Unit,
}) {}

const mib = 1024 * 1024
/** Memory budgets are in decimal megabytes, as the xz budget is. */
const mb = 1_000_000

/** ARCHITECTURE.md §16, gated on the ahead-of-time binary. */
export const budgets: ReadonlyArray<Budget> = [
  new Budget({ metric: "binary", title: "AOT binary size", bound: "at most", limit: 70 * mib, unit: "bytes" }),
  new Budget({ metric: "binaryXz", title: "AOT binary as xz", bound: "at most", limit: 26 * mb, unit: "bytes" }),
  new Budget({ metric: "version", title: "slopmax --version", bound: "at most", limit: 30, unit: "ms" }),
  new Budget({
    metric: "serveToHealthy",
    title: "serve to first /healthz 200",
    bound: "at most",
    limit: 60,
    unit: "ms",
  }),
  new Budget({ metric: "idleRss", title: "daemon idle RSS", bound: "at most", limit: 45 * mb, unit: "bytes" }),
  new Budget({
    metric: "peakRss",
    title: "daemon peak RSS, 32 x 300 KB",
    bound: "at most",
    limit: 120 * mb,
    unit: "bytes",
  }),
  new Budget({
    metric: "smallThroughput",
    title: "small, 32 at once, vs raw probe",
    bound: "at least",
    limit: 0.7,
    unit: "share",
  }),
  new Budget({
    metric: "largeThroughput",
    title: "300 KB, 32 at once, vs raw probe",
    bound: "at least",
    limit: 0.8,
    unit: "share",
  }),
  new Budget({
    metric: "latencyOverRaw",
    title: "small, one at a time, p50 over raw",
    bound: "at most",
    limit: 0.15,
    unit: "ms",
  }),
]

/** A figure as measured: the value gated (a median), and every run it came from. */
export class Measured extends Schema.Class<Measured>("Measured")({
  metric: Metric,
  value: Schema.Finite,
  runs: Schema.Array(Schema.Finite),
  /** How the value was arrived at, in a few words. */
  how: Schema.String,
}) {}

export class Verdict extends Schema.Class<Verdict>("Verdict")({
  budget: Budget,
  measured: Schema.optionalKey(Measured),
  pass: Schema.Boolean,
}) {}

/** Whether `value` keeps within `budget`. */
export const keeps = (budget: Budget, value: number): boolean =>
  budget.bound === "at most" ? value <= budget.limit : value >= budget.limit

/** Each budget against its figure; a budget with no figure fails, since it was not shown to hold. */
export const judge = (measured: ReadonlyArray<Measured>): ReadonlyArray<Verdict> =>
  budgets.map((budget) => {
    const found = measured.find((m) => m.metric === budget.metric)
    return found === undefined
      ? new Verdict({ budget, pass: false })
      : new Verdict({ budget, measured: found, pass: keeps(budget, found.value) })
  })

/** A figure in its unit, for people. */
export const show = (unit: Unit, value: number): string => {
  switch (unit) {
    case "bytes":
      return value >= 10 * mb ? `${fixed(value / mb, 1)} MB` : `${grouped(value)} B`
    case "ms":
      return `${fixed(value, value < 1 ? 3 : 1)} ms`
    case "share":
      return `${fixed(value * 100, 1)}%`
  }
}

/** A limit for people: `≤ 30.0 ms`, `≥ 70.0%`; sizes in MiB when that is how the budget is set. */
export const showLimit = (budget: Budget): string => {
  const sign = budget.bound === "at most" ? "≤" : "≥"
  if (budget.unit === "bytes" && budget.limit % mib === 0) return `${sign} ${budget.limit / mib} MiB`
  return `${sign} ${show(budget.unit, budget.limit)}`
}

/** The runs a figure came from: each of a few, else the fastest and slowest of many. */
export const showRuns = (unit: Unit, runs: ReadonlyArray<number>): string => {
  if (runs.length <= 1) return ""
  if (runs.length <= 3) return runs.map((run) => show(unit, run)).join(", ")
  return `${runs.length} runs, ${show(unit, Math.min(...runs))} to ${show(unit, Math.max(...runs))}`
}

/** A row of figures that are reported but not gated. */
export class Note extends Schema.Class<Note>("Note")({
  title: Schema.String,
  value: Schema.String,
}) {}

/** Everything one gates run found: written as JSON, so runs can be compared side by side. */
export class GatesReport extends Schema.Class<GatesReport>("GatesReport")({
  at: Schema.String,
  host: Schema.Struct({
    platform: Schema.String,
    arch: Schema.String,
    cpus: Schema.Finite,
    load: Schema.Array(Schema.Finite),
  }),
  compiler: Schema.String,
  verdicts: Schema.Array(Verdict),
  notes: Schema.Array(Note),
}) {
  get passed(): boolean {
    return this.verdicts.every((verdict) => verdict.pass)
  }
}

/** Pads columns to their widest cell (by code point), two spaces apart. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths: Array<number> = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length)
    })
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - [...cell].length)))
        .join("  "),
    )
    .join("\n")
}

/** The gates as people read them: one row per budget, then the figures that are only reported. */
export const renderReport = (report: GatesReport): string => {
  const rows = [
    ["Budget", "Limit", "Measured", "Runs", "Result"],
    ...report.verdicts.map((verdict) => [
      verdict.budget.title,
      showLimit(verdict.budget),
      verdict.measured === undefined ? "not measured" : show(verdict.budget.unit, verdict.measured.value),
      verdict.measured === undefined ? "" : showRuns(verdict.budget.unit, verdict.measured.runs),
      verdict.pass ? "ok" : "FAIL",
    ]),
  ]
  const failed = report.verdicts.filter((verdict) => !verdict.pass)
  const notes = report.notes.length === 0 ? [] : ["", table(report.notes.map((note) => [note.title, note.value]))]
  const summary =
    failed.length === 0
      ? "Every budget holds."
      : `${failed.length} of ${report.verdicts.length} budgets fail: ${failed.map((v) => v.budget.title).join("; ")}.`
  return [table(rows), ...notes, "", summary].join("\n")
}

const encode = Schema.encodeSync(GatesReport)

/** The report as indented JSON. */
export const reportJson = (report: GatesReport): string => `${JSON.stringify(encode(report), null, 2)}\n`
