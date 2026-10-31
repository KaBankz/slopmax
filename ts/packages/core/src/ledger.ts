// The usage ledger: one line per request slopmax answered, and one per usage
// window that ran out, in a file per UTC month (`usage/2026-10.ndjson`).
// `slopmax usage`, the history charts and "left on the table" are read from
// it.
//
// Recording never makes a request wait for the disk: records go on an
// unbounded queue, and one writer takes everything queued at once and
// appends it with one write per month file. Files are opened `O_APPEND`, so
// the CLI's own appends (an offline redeem) and the daemon's never interleave
// inside a line. Months are UTC months so a file's name never depends on
// where the machine is; the views turn times into local days and hours.
import {
  type AccountId,
  Event,
  type Lapse,
  LedgerRecord,
  type ProviderId,
  type Usage,
  type WindowEndedRecord,
} from "@slopmax/domain"
import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  type Option,
  Order,
  Path,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect"
import { causeText, type FileError, Home } from "./home.ts"
import { Events } from "./events.ts"

/** The month file a record belongs in: the UTC month of its time. */
export const monthFile = (at: DateTime.DateTime): string => `${DateTime.formatIsoDateUtc(at).slice(0, 7)}.ndjson`

/** The time a record is filed under. */
export const recordedAt = (record: LedgerRecord): DateTime.Utc => record.at

const encodeRecord = Schema.encodeSync(LedgerRecord)

type Counts = typeof Usage.Encoded

const countNames = ["requests", "input", "output", "cacheRead", "cacheWrite"] as const satisfies ReadonlyArray<
  keyof Counts
>

const nonZero = (counts: Counts): Counts => {
  const kept: { -readonly [K in keyof Counts]?: number } = {}
  for (const name of countNames) {
    const value = counts[name]
    if (value !== undefined && value !== 0) kept[name] = value
  }
  return kept
}

/**
 * A record as its line's JSON. Fields at the values they read back as when
 * absent (one attempt, over HTTP, no tokens of a kind) are left out, so a
 * month of requests stays small.
 */
export const lineOf = (record: LedgerRecord): typeof LedgerRecord.Encoded => {
  const encoded = encodeRecord(record)
  if (encoded._tag !== "Request") return encoded
  const { attempts, via, usage, ...rest } = encoded
  const counts = usage === undefined ? {} : nonZero(usage)
  return {
    ...rest,
    ...(Object.keys(counts).length === 0 ? {} : { usage: counts }),
    ...(attempts === undefined || attempts === 1 ? {} : { attempts }),
    ...(via === undefined || via === "http" ? {} : { via }),
  }
}

/**
 * Reads one line, or nothing: a line cut short by a crash, or written by a
 * newer slopmax in a shape this one does not know, is skipped rather than
 * spoiling the month.
 */
export const parseLine: (line: string) => Option.Option<LedgerRecord> = Schema.decodeUnknownOption(
  Schema.fromJsonString(LedgerRecord),
)

/** Oldest first; records from the same moment keep their order in the files. */
export const byTime: Order.Order<LedgerRecord> = Order.mapInput(DateTime.Order, recordedAt)

/** The lines of a batch of records, ready to append. */
export const linesOf = (records: ReadonlyArray<LedgerRecord>): string =>
  records.map((record) => `${JSON.stringify(lineOf(record))}\n`).join("")

/** An account as the windows it used up are filed: under its provider and plan. */
export interface WindowHolder {
  readonly provider: ProviderId
  readonly plan?: string | undefined
}

/**
 * The records for usage windows that ran out, each filed under its account's
 * provider and plan, so "left on the table" can value the quota they threw
 * away. A window of an account removed since is dropped: nobody will ask
 * about it.
 */
export const windowEndedRecords = (
  lapses: Iterable<{ readonly account: AccountId; readonly lapse: Lapse }>,
  accounts: ReadonlyMap<AccountId, WindowHolder>,
): ReadonlyArray<WindowEndedRecord> => {
  const records: Array<WindowEndedRecord> = []
  for (const { account, lapse } of lapses) {
    const holder = accounts.get(account)
    if (holder === undefined) continue
    records.push(
      LedgerRecord.cases.WindowEnded.make({
        at: lapse.endedAt,
        account,
        provider: holder.provider,
        ...(holder.plan === undefined ? {} : { plan: holder.plan }),
        span: lapse.span,
        ...(lapse.model === undefined ? {} : { model: lapse.model }),
        used: lapse.used,
      }),
    )
  }
  return records
}

export interface Shape {
  /** Queues a record and tells the event feed about a request; never waits for the disk. */
  readonly record: (record: LedgerRecord) => Effect.Effect<void>
  /** Every record at or after `since`, file by file, in the order they were written. */
  readonly read: (since: DateTime.Utc) => Stream.Stream<LedgerRecord, FileError>
  /** Every record at or after `since`, oldest first. */
  readonly load: (since: DateTime.Utc) => Effect.Effect<ReadonlyArray<LedgerRecord>, FileError>
  /** Appends records at once, without the queue: for a process that records one thing and exits. */
  readonly append: (records: ReadonlyArray<LedgerRecord>) => Effect.Effect<void, FileError>
  /** Waits until every record queued so far is on disk. */
  readonly flush: Effect.Effect<void>
}

type Queued =
  | { readonly _tag: "Record"; readonly record: LedgerRecord }
  | { readonly _tag: "Flush"; readonly done: Deferred.Deferred<void> }

export const make = Effect.gen(function* () {
  const home = yield* Home
  const events = yield* Events
  const path = yield* Path.Path
  const dir = home.paths.usage

  const append = Effect.fn("Ledger.append")(function* (records: ReadonlyArray<LedgerRecord>) {
    const byFile = Arr.groupBy(records, (record) => monthFile(record.at))
    for (const [name, batch] of Object.entries(byFile)) {
      yield* home.append(path.join(dir, name), linesOf(batch))
    }
  })

  const read = (since: DateTime.Utc): Stream.Stream<LedgerRecord, FileError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const first = monthFile(since)
        // Month files sort by name in time order, so the first one that can
        // hold `since` is found by name alone.
        const names = (yield* home.list(dir)).filter((name) => name.endsWith(".ndjson") && name >= first)
        return Stream.fromIterable(names).pipe(
          // Lines are read one by one rather than through an NDJSON decoder,
          // which stops at the first bad line; here a bad line is skipped.
          Stream.flatMap((name) => Stream.splitLines(Stream.decodeText(home.stream(path.join(dir, name))))),
          Stream.filterMap((line) => {
            const parsed = parseLine(line)
            return parsed._tag === "Some" && DateTime.isGreaterThanOrEqualTo(parsed.value.at, since)
              ? Result.succeed(parsed.value)
              : Result.failVoid
          }),
        )
      }),
    )

  const load = Effect.fn("Ledger.load")(function* (since: DateTime.Utc) {
    const records = yield* Stream.runCollect(read(since))
    return Arr.sort(records, byTime)
  })

  const queue = yield* Queue.unbounded<Queued>()

  const writeQueued = Effect.gen(function* () {
    const queued = yield* Queue.takeAll(queue)
    const records = queued.flatMap((item) => (item._tag === "Record" ? [item.record] : []))
    if (records.length > 0) {
      // A batch is written whole even while shutting down, so no line is cut
      // short. Whatever goes wrong is logged and the writer carries on: if it
      // stopped, records would pile up and shutdown would wait on it forever.
      yield* Effect.uninterruptible(append(records)).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`writing the usage ledger: ${causeText(Cause.squash(cause))}`)),
      )
    }
    for (const item of queued) if (item._tag === "Flush") yield* Deferred.succeed(item.done, undefined)
  })
  yield* Effect.forkScoped(Effect.forever(writeQueued))

  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    yield* Queue.offer(queue, { _tag: "Flush", done })
    yield* Deferred.await(done)
  }).pipe(Effect.withSpan("Ledger.flush"))
  // Added after the writer was forked, so it runs first when the scope
  // closes: whatever is queued is written while the writer still runs.
  yield* Effect.addFinalizer(() => flush)

  // Untraced: every request that settles records here, and a span each
  // would cost more than queueing the record.
  const record = Effect.fnUntraced(function* (entry: LedgerRecord) {
    yield* Queue.offer(queue, { _tag: "Record", record: entry })
    if (entry._tag === "Request") yield* events.publish(Event.cases.Request.make({ record: entry }))
  })

  return { record, read, load, append, flush } satisfies Shape
})

/** The usage ledger. */
export class Ledger extends Context.Service<Ledger, Shape>()("@slopmax/core/Ledger", { make }) {
  /** One writer for the life of the scope; queued records are written before it closes. */
  static readonly layer: Layer.Layer<Ledger, never, Home | Events | Path.Path> = Layer.effect(Ledger, Ledger.make)
}
