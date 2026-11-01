import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  budgets,
  GatesReport,
  judge,
  keeps,
  Measured,
  Note,
  renderReport,
  reportJson,
  show,
  showLimit,
  table,
} from "../src/budgets.ts"
import { latencyOver, throughputShare } from "../src/gates.ts"
import type { Outcome } from "../src/load.ts"

const limitOf = (metric: string) => budgets.find((budget) => budget.metric === metric)

const measured = (metric: Measured["metric"], value: number) => new Measured({ metric, value, runs: [value], how: "" })

const passing = [
  measured("binary", 60 * 1024 * 1024),
  measured("binaryXz", 23_000_000),
  measured("version", 22),
  measured("serveToHealthy", 40),
  measured("idleRss", 40_000_000),
  measured("peakRss", 100_000_000),
  measured("smallThroughput", 0.75),
  measured("largeThroughput", 0.85),
  measured("latencyOverRaw", 0.1),
]

const report = (values: ReadonlyArray<Measured>) =>
  new GatesReport({
    at: "2026-11-01T00:00:00Z",
    host: { platform: "linux", arch: "x64", cpus: 8, load: [1, 1, 1] },
    compiler: "1.4.4-canary.1+da867c60b",
    verdicts: judge(values),
    notes: [new Note({ title: "small, 32 at once", value: "proxy 1600 req/s, raw probe 2000 req/s" })],
  })

describe("the performance budgets", () => {
  test("are ARCHITECTURE.md §16's", () => {
    expect(limitOf("binary")?.limit).toBe(70 * 1024 * 1024)
    expect(limitOf("binaryXz")?.limit).toBe(26_000_000)
    expect(limitOf("version")?.limit).toBe(30)
    expect(limitOf("serveToHealthy")?.limit).toBe(60)
    expect(limitOf("idleRss")?.limit).toBe(45_000_000)
    expect(limitOf("peakRss")?.limit).toBe(120_000_000)
    expect(limitOf("smallThroughput")).toMatchObject({ limit: 0.7, bound: "at least" })
    expect(limitOf("largeThroughput")).toMatchObject({ limit: 0.8, bound: "at least" })
    expect(limitOf("latencyOverRaw")).toMatchObject({ limit: 0.15, unit: "ms" })
  })

  test("hold a figure at the limit, and fail one past it in the budget's direction", () => {
    const version = limitOf("version")
    const small = limitOf("smallThroughput")
    if (version === undefined || small === undefined) throw new Error("missing budgets")
    expect(keeps(version, 30)).toBe(true)
    expect(keeps(version, 30.1)).toBe(false)
    expect(keeps(small, 0.7)).toBe(true)
    expect(keeps(small, 0.1)).toBe(false)
  })

  test("fail a budget nothing measured, since it was never shown to hold", () => {
    const verdicts = judge(passing.filter((m) => m.metric !== "peakRss"))
    expect(verdicts.find((verdict) => verdict.budget.metric === "peakRss")?.pass).toBe(false)
    expect(verdicts.filter((verdict) => verdict.pass)).toHaveLength(budgets.length - 1)
  })

  test("print one row per budget and say which fail", () => {
    const failing = report([...passing.filter((m) => m.metric !== "smallThroughput"), measured("smallThroughput", 0.1)])
    expect(failing.passed).toBe(false)
    const text = renderReport(failing)
    expect(text).toMatch(/small, 32 at once, vs raw probe\s+≥ 70\.0%/)
    expect(text).toMatch(/≥ 70\.0%\s+10\.0%\s+FAIL/)
    expect(text).toContain("1 of 9 budgets fail: small, 32 at once, vs raw probe.")
    expect(text).toContain("proxy 1600 req/s, raw probe 2000 req/s")
    expect(renderReport(report(passing))).toContain("Every budget holds.")
  })

  test("write the report as JSON that reads back the same", () => {
    const written = report(passing)
    const read = Schema.decodeUnknownSync(Schema.fromJsonString(GatesReport))(reportJson(written))
    expect(read).toEqual(written)
    expect(read.passed).toBe(true)
  })

  test("show figures in their units", () => {
    expect(show("bytes", 71_284_968)).toBe("71.3 MB")
    expect(show("bytes", 1234)).toBe("1,234 B")
    expect(show("ms", 22.44)).toBe("22.4 ms")
    expect(show("ms", 0.123)).toBe("0.123 ms")
    expect(show("share", 0.105)).toBe("10.5%")
    const binary = limitOf("binary")
    if (binary === undefined) throw new Error("missing budget")
    expect(showLimit(binary)).toBe("≤ 70 MiB")
  })

  test("line up columns by visible characters", () => {
    expect(
      table([
        ["a", "bb", "c"],
        ["ccc", "≤", "d"],
      ]),
    ).toBe("a    bb  c\nccc  ≤   d")
  })
})

const outcome = (requestsPerSec: number, p50Ms: number, ok = 1): Outcome => ({ ok, requestsPerSec, p50Ms, p99Ms: 0 })

describe("comparing with the raw probe", () => {
  test("gates the median of the proxy's throughput over the median of the probe's", () => {
    const share = throughputShare(
      [outcome(100, 0), outcome(300, 0), outcome(200, 0)],
      [outcome(1000, 0), outcome(1000, 0), outcome(2000, 0)],
    )
    expect(share.share).toBeCloseTo(0.2)
    expect(share.runs).toEqual([0.1, 0.3, 0.1])
    expect(share.answered).toBe(true)
  })

  test("counts a proxy that did not answer 200 as no throughput at all", () => {
    const share = throughputShare([outcome(5000, 0, 0.5)], [outcome(1000, 0)])
    expect(share.share).toBe(0)
    expect(share.answered).toBe(false)
  })

  test("gates the p50 the proxy adds over the probe's", () => {
    const over = latencyOver(
      [outcome(0, 1.3), outcome(0, 1.2), outcome(0, 1.5)],
      [outcome(0, 1), outcome(0, 1.1), outcome(0, 1)],
    )
    expect(over.over).toBeCloseTo(0.3)
    expect(over.runs.map((run) => Number(run.toFixed(2)))).toEqual([0.3, 0.1, 0.5])
  })
})
