import { describe, expect } from "bun:test"
import { LeftAccount, LeftOnTheTable, Section, Summary } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Option, Result, Schema } from "effect"
import { endpointUrl, splitList } from "../src/commands/accounts.ts"
import { lastLines } from "../src/commands/logs.ts"
import { anyFailed, renderDoctor } from "../src/commands/misc.ts"
import { flagList, readPlan } from "../src/commands/setup.ts"
import { rangeTitle, renderUsage } from "../src/commands/usage.ts"
import { paint } from "../src/print.ts"

const plain = paint(false)

const summary = (rows: ReadonlyArray<unknown>, total: Record<string, number>) =>
  Schema.decodeUnknownSync(Summary)({ range: "7d", by: "model", since: "2026-10-25T00:00:00Z", rows, total })

const sections = (levels: ReadonlyArray<"ok" | "info" | "warn" | "fail">) => [
  Schema.decodeUnknownSync(Section)({
    title: "Proxy",
    findings: levels.map((level, index) => ({
      level,
      text: `finding ${index}`,
      ...(level === "fail" ? { fix: "do this" } : {}),
    })),
  }),
]

describe("setup's flags", () => {
  it("reads a list flag as the items it names, without blanks or `none`", () => {
    expect(flagList("claude, codex")).toEqual(["claude", "codex"])
    expect(flagList(" claude,,codex ,")).toEqual(["claude", "codex"])
    expect(flagList("none")).toEqual([])
    expect(flagList("")).toEqual([])
  })

  it("checks every list before anything runs, naming the first mistake", () => {
    const none = { import: Option.none(), login: Option.none(), agents: Option.none() }
    expect(Result.getOrThrow(readPlan(none))).toEqual(none)
    expect(Result.getOrThrow(readPlan({ ...none, import: Option.some("all") })).import).toEqual(
      Option.some(["claude-code", "codex", "cliproxyapi"]),
    )
    expect(Result.getOrThrow(readPlan({ ...none, import: Option.some("none") })).import).toEqual(Option.some([]))
    expect(Result.getOrThrow(readPlan({ ...none, agents: Option.some("claude,codex") })).agents).toEqual(
      Option.some(["claude-code", "codex"]),
    )
    expect(Result.getOrThrow(readPlan({ ...none, login: Option.some("codex") })).login).toEqual(Option.some(["codex"]))
    expect(readPlan({ ...none, import: Option.some("dropbox") })).toEqual(Result.fail('unknown source "dropbox"'))
    expect(readPlan({ ...none, agents: Option.some("grok") })).toEqual(Result.fail('unknown agent "grok"'))
    const login = readPlan({ ...none, login: Option.some("xai") })
    expect(Result.isFailure(login) && login.failure).toContain("--login signs in to subscriptions (claude, codex)")
    const unknown = readPlan({ ...none, login: Option.some("gemini") })
    expect(Result.isFailure(unknown) && unknown.failure).toContain("gemini")
  })
})

describe("login's flags", () => {
  it("takes an endpoint's base URL over http or https, without trailing slashes", () => {
    expect(endpointUrl("http://localhost:11434/v1/")).toEqual(Result.succeed("http://localhost:11434/v1"))
    expect(endpointUrl(" https://h/v1// ")).toEqual(Result.succeed("https://h/v1"))
    expect(Result.isFailure(endpointUrl("ftp://host"))).toBe(true)
  })

  it("reads a list of models split on commas, trimmed, without empty ones", () => {
    expect(splitList("qwen3, llama4,,")).toEqual(["qwen3", "llama4"])
    expect(splitList("")).toEqual([])
  })
})

describe("usage", () => {
  it("names its period as a sentence does", () => {
    expect(rangeTitle("today")).toBe("today")
    expect(rangeTitle("7d")).toBe("the last 7 days")
    expect(rangeTitle("30d")).toBe("the last 30 days")
    expect(rangeTitle("all")).toBe("all time")
  })

  it("says when nothing was recorded", () => {
    expect(renderUsage(summary([], {}), LeftOnTheTable.none, "config.json", plain)).toEqual([
      "No requests recorded for the last 7 days.",
    ])
  })

  it("totals the rows with their API cost, and says what is left out", () => {
    const view = summary(
      [
        {
          key: "claude-fable-5",
          totals: { requests: 2, input: 2000, output: 400, cacheRead: 10_000, cacheWrite: 600, cost: 1.5 },
        },
        { key: "mystery", totals: { requests: 1, input: 10, output: 5, unpriced: 1 } },
      ],
      { requests: 3, input: 2010, output: 405, cacheRead: 10_000, cacheWrite: 600, cost: 1.5, unpriced: 1, failed: 2 },
    )
    const lines = renderUsage(view, LeftOnTheTable.none, "/home/x/.slopmax/config.json", plain)
    expect(lines[1]).toBe("MODEL              REQ     INPUT    OUTPUT  CACHE READ  CACHE WRITE   API COST")
    expect(lines[2]).toBe("claude-fable-5       2      2.0k       400       10.0k          600      $1.50")
    expect(lines[3]).toBe("mystery              1        10         5           0            0          —")
    expect(lines[4]).toBe("total                3      2.0k       405       10.0k          600     $1.50+")
    const notes = lines.slice(5).join("\n")
    expect(notes).toContain("Usage for the last 7 days.")
    expect(notes).toContain(
      "leaves out 1 request to models without a price; set one under prices in /home/x/.slopmax/config.json",
    )
    expect(notes).toContain("2 requests failed")
    expect(notes).toContain("are left out")
  })

  it("says what resets threw away, by account", () => {
    const wasted = new LeftOnTheTable({
      windows: 3,
      unused: 40,
      dollars: 12.5,
      unpriced: 1,
      accounts: [
        new LeftAccount({ name: "a@x.dev", provider: "claude", windows: 2, unused: 55, dollars: 12.5 }),
        new LeftAccount({ name: "b@x.dev", provider: "codex", windows: 1, unused: 0.2, dollars: 0 }),
      ],
    })
    const text = renderUsage(summary([], {}), wasted, "config.json", plain).join("\n")
    expect(text).toContain("Left on the table: $12.50, 40% unused on average, across 3 weekly windows")
    expect(text).toContain("  a@x.dev                        $12.50  55% unused over 2")
    expect(text).not.toContain("b@x.dev")
    expect(text).toContain("Plans without a known price are left out")
  })
})

describe("doctor", () => {
  it("marks each finding by its level, with its fix beneath, and counts the problems", () => {
    const lines = renderDoctor(sections(["ok", "info", "warn", "fail"]), plain)
    expect(lines).toEqual([
      "",
      "Proxy",
      "  ✓ finding 0",
      "  · finding 1",
      "  ! finding 2",
      "  ✗ finding 3",
      "      fix: do this",
      "",
      "1 problem, 1 warning.",
    ])
    expect(anyFailed(sections(["ok", "fail"]))).toBe(true)
  })

  it("says everything looks good when nothing failed or warned", () => {
    expect(renderDoctor(sections(["ok", "info"]), plain).at(-1)).toBe("Everything looks good.")
    expect(anyFailed(sections(["ok", "warn"]))).toBe(false)
  })
})

describe("logs", () => {
  it("shows the last lines of the log, each ending in a newline", () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join("")
    expect(lastLines(log, 3)).toBe("line 48\nline 49\nline 50\n")
    expect(lastLines("only\npartial", 5)).toBe("only\npartial\n")
    expect(lastLines(log, 0)).toBe("")
    expect(lastLines("", 10)).toBe("")
  })
})
