import { describe, expect, it as plain } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect, Schema } from "effect"

import { Timestamp } from "@slopmax/common"

import { append, left, read, type Record, RecordSchema, value } from "../src/waste.ts"
import { tempDirs } from "./support/temp.ts"

const ts = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

const record = (account: string, plan: string, span: string, used: number, ended: number): Record => ({
  endedAt: ts(ended),
  account,
  provider: "claude",
  plan,
  span,
  used,
})

const week = (monthly: number) => (monthly * 12.0) / 52.0

const temp = tempDirs()

describe("waste", () => {
  plain("the_unused_part_of_a_week_costs_its_share_of_the_fee", () => {
    // Max 20x at $200 a month: a week is $46.15; half unused, $23.08.
    const half = value("claude", "max 20x", "7d", undefined, 50.0, {}) ?? 0
    expect(Math.abs(half - (200.0 * 12.0) / 52.0 / 2.0)).toBeLessThan(1e-9)
    // A week used to the full wastes nothing; over the full, nothing.
    expect(value("claude", "pro", "7d", undefined, 100.0, {})).toBe(0.0)
    expect(value("claude", "pro", "7d", undefined, 130.0, {})).toBe(0.0)
    // Five hours and a model's own week are not what the fee buys.
    expect(value("claude", "pro", "5h", undefined, 0.0, {})).toBe(0.0)
    expect(value("claude", "pro", "7d", "Fable", 0.0, {})).toBe(0.0)
    // A month's window is the whole fee.
    expect(value("codex", "team", "30d", undefined, 0.0, {})).toBe(30.0)
    expect(value("claude", undefined, "7d", undefined, 0.0, {})).toBeUndefined()
    expect(value("claude", "enterprise", "7d", undefined, 0.0, {})).toBeUndefined()
  })

  it.live("records_are_kept_and_read_back_once_each", () =>
    Effect.gen(function* () {
      const dir = join(temp("waste"), "waste")
      const path = join(dir, "windows.jsonl")
      const a = record("a", "max 20x", "7d", 40.0, 1_000)
      const b = record("b", "pro", "7d", 90.0, 2_000)
      yield* append(path, [a, b])
      // Told again after a restart.
      yield* append(path, [a])
      yield* append(path, [])
      expect(yield* read(path, ts(0))).toEqual([a, b])
      expect(yield* read(path, ts(1_500))).toEqual([b])
      expect(yield* read(join(dir, "missing.jsonl"), ts(0))).toEqual([])
      // One line each, as serde_json writes them; the file 0600.
      expect(readFileSync(path, "utf8").split("\n")[0]).toBe(
        '{"ended_at":"1970-01-01T00:16:40Z","account":"a","provider":"claude","plan":"max 20x","span":"7d","used":40.0}',
      )
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }),
  )

  plain("left_totals_long_windows_by_account", () => {
    const records = [
      record("a", "max 20x", "7d", 50.0, 1),
      record("a", "max 20x", "7d", 100.0, 2),
      record("a", "max 20x", "5h", 0.0, 3),
      record("b", "pro", "7d", 80.0, 4),
      record("c", "mystery", "7d", 0.0, 5),
    ]
    const names = new Map([["a", "work@x.dev"]])
    const total = left(records, {}, names)
    expect([total.windows, total.unpriced]).toEqual([4, 1])
    // 50, 0, 20, and 100 unused.
    expect(Math.abs(total.unused - 42.5)).toBeLessThan(1e-9)
    expect(Math.abs(total.dollars - (week(200.0) * 0.5 + week(20.0) * 0.2))).toBeLessThan(1e-9)
    expect(total.accounts[0]?.name).toBe("work@x.dev")
    expect([total.accounts[0]?.windows, total.accounts[0]?.unused]).toEqual([2, 25.0])
    expect(total.accounts.at(-1)?.dollars).toBe(0.0)
  })
})

describe("waste, beyond the Rust tests", () => {
  plain("records read whatever writes them, and skip lines that are not records", () => {
    const decoded = Schema.decodeUnknownSync(RecordSchema)(
      JSON.parse('{"ended_at":"2026-10-01T00:00:00Z","account":"x","provider":"codex","span":"7d","used":1e1}'),
    )
    expect(decoded).toEqual({ endedAt: Date.UTC(2026, 9, 1), account: "x", provider: "codex", span: "7d", used: 10 })
  })
})
