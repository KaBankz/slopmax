import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { benchLoads, type Load, loadRow, OhaReport, ohaArgs, outcomeOf } from "../src/load.ts"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OhaReport))

describe("load runs", () => {
  test("speak as Claude Code to the proxy's Claude path, with the bench key", () => {
    const load: Load = { name: "x", agent: "claude", body: "claude-small", concurrency: 1, amount: { requests: 300 } }
    const args = ohaArgs(load, "http://127.0.0.1:9101", "/b/claude-small.json")
    expect(args).toContain("authorization: Bearer bench")
    expect(args).toContain("user-agent: claude-cli/2.1.287 (external, cli)")
    expect(args).toContain("x-claude-code-session-id: bench")
    expect(args.join(" ")).toContain("-c 1 -n 300 -D /b/claude-small.json")
    expect(args.at(-1)).toBe("http://127.0.0.1:9101/claude/v1/messages?beta=true")
    expect(args.slice(0, 3)).toEqual(["--no-tui", "--output-format", "json"])
  })

  test("speak as Codex to its path for a duration, 32 at once", () => {
    const load: Load = { name: "x", agent: "codex", body: "codex-large", concurrency: 32, amount: { seconds: 8 } }
    const args = ohaArgs(load, "http://h", "/b/codex-large.json")
    expect(args).toContain("session_id: bench")
    expect(args.join(" ")).toContain("-c 32 -z 8s")
    expect(args.at(-1)).toBe("http://h/codex/responses")
  })

  test("cover every load the bench table shows", () => {
    expect(benchLoads(8).map((load) => load.name)).toEqual([
      "claude small, one at a time",
      "claude small, 32 at once",
      "claude 300 KB, one at a time",
      "claude 300 KB, 32 at once",
      "codex small, 32 at once",
      "codex 300 KB, 32 at once",
    ])
  })

  test("count only 200 answers as answered, since oha counts every answer as a success", () => {
    const report = decode(
      JSON.stringify({
        summary: { successRate: 1, requestsPerSec: 1500.7, total: 1 },
        latencyPercentiles: { p50: 0.0011, p99: 0.0042 },
        statusCodeDistribution: { "200": 90, "401": 10 },
        details: {},
      }),
    )
    const outcome = outcomeOf(report)
    expect(outcome.ok).toBeCloseTo(0.9)
    expect(outcome.requestsPerSec).toBe(1500.7)
    expect(outcome.p50Ms).toBeCloseTo(1.1)
    expect(loadRow("claude small", outcome)).toEqual([
      "claude small",
      "90% ok",
      "1500 req/s",
      "p50 1.10 ms",
      "p99 4.20 ms",
    ])
  })

  test("read a report with no answers at all as none answered", () => {
    const report = decode(
      JSON.stringify({ summary: { successRate: 0, requestsPerSec: 0 }, latencyPercentiles: { p50: null, p99: null } }),
    )
    expect(outcomeOf(report)).toEqual({ ok: 0, requestsPerSec: 0, p50Ms: 0, p99Ms: 0 })
  })
})
