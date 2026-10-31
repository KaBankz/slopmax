import { describe, expect } from "bun:test"
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect, Result } from "effect"

import { Timestamp } from "@slopmax/common"

import { append, type Entry, Entry as Entries, Ledger, read } from "../src/ledger.ts"
import { tempDirs } from "./support/temp.ts"

const at = (text: string): Timestamp => {
  const parsed = Timestamp.parse(text)
  if (Result.isFailure(parsed)) throw new Error(text)
  return parsed.success
}

const entry = (when: string, model: string): Entry => ({
  at: at(when),
  account: "claude-1",
  provider: "claude",
  model,
  status: 200,
  input: 10,
  output: 5,
  cacheRead: 100,
  cacheWrite: 0,
  ms: 900,
  firstByteMs: 300,
  attempts: 1,
})

const temp = tempDirs()

describe("ledger", () => {
  it.live("writes_monthly_files_and_reads_them_back", () =>
    Effect.gen(function* () {
      const dir = join(temp("ledger"), "ledger")
      const september = entry("2026-09-30T23:00:00Z", "a")
      const october = entry("2026-10-01T01:00:00Z", "b")
      yield* append(dir, [september, october])
      expect(existsSync(join(dir, "2026-09.jsonl"))).toBe(true)
      expect(existsSync(join(dir, "2026-10.jsonl"))).toBe(true)

      const all = yield* read(dir, at("2026-01-01T00:00:00Z"))
      expect(all).toEqual([september, october])
      const recent = yield* read(dir, at("2026-10-01T00:00:00Z"))
      expect(recent).toEqual([october])

      // Lines stay compact: defaults are left out.
      const text = readFileSync(join(dir, "2026-10.jsonl"), "utf8")
      expect(text).not.toContain("attempts")
    }),
  )
})

describe("ledger, beyond the Rust tests", () => {
  it.live("lines keep the Rust's order and omissions; bad lines are skipped", () =>
    Effect.gen(function* () {
      const dir = join(temp("ledger"), "ledger")
      const retried: Entry = { ...entry("2026-10-02T00:00:00.5Z", "m"), attempts: 3, agent: "codex", session: "s" }
      yield* append(dir, [retried])
      const path = join(dir, "2026-10.jsonl")
      expect(readFileSync(path, "utf8")).toBe(
        '{"at":"2026-10-02T00:00:00.5Z","account":"claude-1","provider":"claude","model":"m","status":200,"input":10,"output":5,"cache_read":100,"cache_write":0,"ms":900,"first_byte_ms":300,"attempts":3,"agent":"codex","session":"s"}\n',
      )
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      appendFileSync(
        path,
        '{"partial\n{"at":"2026-10-03T00:00:00Z","account":"","provider":"codex","status":503,"ms":1}\n',
      )
      const entries = yield* read(dir, 0)
      expect(entries.length).toBe(2)
      const failed = entries[1]
      expect(failed?.attempts).toBe(1)
      expect(failed?.input).toBe(0)
      expect(failed !== undefined && Entries.failed(failed) && !Entries.answered(failed)).toBe(true)
      expect(Entries.tokens(retried)).toBe(115)
      expect(yield* read(join(dir, "missing"), 0)).toEqual([])
    }),
  )

  it.live("the writer appends in the background", () =>
    Effect.gen(function* () {
      const dir = join(temp("ledger"), "ledger")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* Ledger.start(dir)
          ledger.record(entry("2026-10-05T00:00:00Z", "x"))
          ledger.record(entry("2026-11-05T00:00:00Z", "y"))
          for (let i = 0; i < 100 && (yield* read(dir, 0)).length < 2; i++) yield* Effect.sleep("10 millis")
        }),
      )
      expect((yield* read(dir, 0)).map((e) => e.model)).toEqual(["x", "y"])
    }),
  )
})
