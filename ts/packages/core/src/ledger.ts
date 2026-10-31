// The usage ledger: one JSON line per request that reached the accounts,
// answered or failed, in monthly files (`~/.slopmax/usage/2026-10.jsonl`).
// `slopmax usage` reads it back.

import { Effect, Queue, Schema, type Scope } from "effect"

import { fmt, log, SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"

import { chain } from "./error.ts"
import * as fsx from "./fsx.ts"
import { join } from "./paths.ts"
import { ProviderIdSchema } from "./provider/mod.ts"
import { Count, defaulted, opt, U16, U32, withDefault } from "./serde.ts"

/** One request: answered, or failed with the status the agent got. */
export const EntrySchema = Schema.Struct({
  at: TimestampFromString,
  account: Schema.String,
  provider: ProviderIdSchema,
  model: opt(Schema.String),
  status: U16,
  input: withDefault(Count, 0),
  output: withDefault(Count, 0),
  cacheRead: withDefault(Count, 0),
  cacheWrite: withDefault(Count, 0),
  /** Milliseconds from the request arriving to its last byte. */
  ms: Count,
  /** Milliseconds from the request arriving to the first response byte. */
  firstByteMs: opt(Count),
  /** Accounts tried: the last one answered, or none did. */
  attempts: defaulted(U32, 1),
  /**
   * The agent that sent it (`claude`, `codex`), or `slopmax` for the
   * requests slopmax sends itself to start a window.
   */
  agent: opt(Schema.String),
  /** The agent's session (its conversation), when it names one. */
  session: opt(Schema.String),
}).pipe(Schema.encodeKeys({ cacheRead: "cache_read", cacheWrite: "cache_write", firstByteMs: "first_byte_ms" }))

export type Entry = typeof EntrySchema.Type

export const Entry = {
  /** Every token the request moved: input, output, and both kinds of cache. */
  tokens: (self: Entry): number => self.input + self.output + self.cacheRead + self.cacheWrite,

  /** Whether it ended in an error instead of an answer. */
  failed: (self: Entry): boolean => self.status >= 400,

  /**
   * Whether it is a request someone made: an answer that moved tokens,
   * unlike a failure or an agent's housekeeping (listing models, counting
   * tokens).
   */
  answered: (self: Entry): boolean => !Entry.failed(self) && Entry.tokens(self) > 0,
} as const

/** Appends entries in the background, so requests never wait on the disk. */
export class Ledger {
  private constructor(private readonly queue: Queue.Queue<Entry>) {}

  /** Starts the writer for `dir`; it stops when the scope closes. */
  static readonly start = Effect.fn("Ledger.start")(function* (
    dir: string,
  ): Effect.fn.Return<Ledger, never, Scope.Scope> {
    const queue = yield* Queue.unbounded<Entry>()
    const writer = Effect.gen(function* () {
      const batch = yield* Queue.takeAll(queue)
      const written = yield* Effect.result(append(dir, batch))
      if (written._tag === "Failure") log.warn(`writing the usage ledger: ${chain(written.failure)}`)
    })
    yield* Effect.forkScoped(Effect.forever(writer))
    return new Ledger(queue)
  })

  record(entry: Entry): void {
    Queue.offerUnsafe(this.queue, entry)
  }
}

const fileFor = (dir: string, at: Timestamp): string => {
  const [year, month] = Timestamp.date(at, SignedDuration.ZERO)
  return join(dir, `${fmt.zeroPad(year, 4)}-${fmt.zeroPad(month, 2)}.jsonl`)
}

/** @internal Appends `entries` to their months' files; the writer's step, exposed for tests. */
export const append = Effect.fn("ledger.append")(function* (dir: string, entries: ReadonlyArray<Entry>) {
  yield* fsx.privateDir(dir)
  const byFile = new Map<string, Array<Entry>>()
  for (const entry of entries) {
    const file = fileFor(dir, entry.at)
    const list = byFile.get(file)
    if (list === undefined) byFile.set(file, [entry])
    else list.push(entry)
  }
  for (const file of [...byFile.keys()].toSorted()) yield* fsx.appendLines(file, EntrySchema, byFile.get(file) ?? [])
})

const decodeEntry = Schema.decodeUnknownOption(EntrySchema)

/**
 * Every entry at or after `since`, oldest first. Unreadable lines (a
 * partial write, a newer format) are skipped.
 */
export const read = Effect.fn("ledger.read")(function* (dir: string, since: Timestamp) {
  const first = fileFor(dir, since)
  const names = yield* Effect.orElseSucceed(fsx.readDir(dir), () => undefined)
  if (names === undefined) return []
  const files = names
    .filter((name) => name.endsWith(".jsonl") && name !== ".jsonl")
    .map((name) => join(dir, name))
    .filter((path) => path >= first)
    .toSorted()
  const entries: Array<Entry> = []
  for (const path of files) {
    for (const line of (yield* fsx.readLines(path)) ?? []) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const entry = decodeEntry(value)
      if (entry._tag === "Some" && entry.value.at >= since) entries.push(entry.value)
    }
  }
  return entries.toSorted((a, b) => a.at - b.at)
})
