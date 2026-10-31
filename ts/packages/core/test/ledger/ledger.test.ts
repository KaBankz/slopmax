import { describe, expect } from "bun:test"
import { AccountId, LedgerRecord, type RequestRecord, type WindowEndedRecord } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Array, DateTime, Effect, Fiber, FileSystem, Layer, Logger, Option, Schema, Stream } from "effect"
import { Events } from "../../src/events.ts"
import { Home } from "../../src/home.ts"
import { Ledger, lineOf, monthFile, parseLine, windowEndedRecords } from "../../src/ledger.ts"
import { windowsEnded } from "../../src/ledger-views.ts"

const root = "/home/me/.slopmax"
const usage = `${root}/usage`

const decodeRequest = Schema.decodeUnknownSync(LedgerRecord.cases.Request)
const decodeEnded = Schema.decodeUnknownSync(LedgerRecord.cases.WindowEnded)

const request = (at: string, fields: Record<string, unknown> = {}): RequestRecord =>
  decodeRequest({
    _tag: "Request",
    at,
    account: "claude-1a2b3c4d",
    provider: "claude",
    model: "claude-opus-5-5",
    status: 200,
    usage: { input: 10, output: 5, cacheRead: 100 },
    ms: 900,
    firstByteMs: 300,
    ...fields,
  })

const ended = (at: string, account: string, used: number): WindowEndedRecord =>
  decodeEnded({ _tag: "WindowEnded", at, account, provider: "claude", plan: "max 20x", span: "7d", used })

const since = (text: string) => DateTime.makeUnsafe(text)

const services = (options: MemoryFileSystem.Options = {}) =>
  Ledger.layer.pipe(
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(Home.layerAt(root)),
    Layer.provideMerge(MemoryFileSystem.layerWith(options)),
  )

const modeOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.map(fs.stat(path), (info) => info.mode & 0o777))

describe("Ledger", () => {
  it.effect("files each record under its UTC month and reads them back from a moment on", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const fs = yield* FileSystem.FileSystem
      // 23:00 UTC on September 30th is October 1st in much of the world; it is filed by UTC.
      const september = request("2026-09-30T23:00:00Z")
      const october = request("2026-10-01T01:00:00Z", { model: "claude-sonnet-5" })
      yield* ledger.record(september)
      yield* ledger.record(october)
      yield* ledger.flush
      expect(yield* fs.readDirectory(usage)).toEqual(["2026-09.ndjson", "2026-10.ndjson"])
      expect(yield* ledger.load(since("2026-01-01T00:00:00Z"))).toEqual([september, october])
      expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([october])
      expect(yield* ledger.load(since("2026-10-01T01:00:00.001Z"))).toEqual([])
    }).pipe(Effect.provide(services())),
  )

  it.effect("keeps lines short by leaving out what reads back as the default", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const fs = yield* FileSystem.FileSystem
      const plain = request("2026-10-05T10:00:00Z", { usage: { output: 7 } })
      const rescued = request("2026-10-05T10:00:01Z", { attempts: 3, via: "socket" })
      yield* ledger.record(plain)
      yield* ledger.record(rescued)
      yield* ledger.flush
      const [first, second] = (yield* fs.readFileString(`${usage}/2026-10.ndjson`)).trimEnd().split("\n")
      expect(first).not.toContain("attempts")
      expect(first).not.toContain("via")
      expect(first).toContain('"usage":{"output":7}')
      expect(second).toContain('"attempts":3')
      expect(second).toContain('"via":"socket"')
      expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([plain, rescued])
    }).pipe(Effect.provide(services())),
  )

  it.effect("keeps the directory and every month file private", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.record(request("2026-10-05T10:00:00Z"))
      yield* ledger.flush
      expect(yield* modeOf(usage)).toBe(0o700)
      expect(yield* modeOf(`${usage}/2026-10.ndjson`)).toBe(0o600)
    }).pipe(Effect.provide(services())),
  )

  it.effect("skips lines it cannot read, and files that are not months", () => {
    const good = request("2026-10-05T10:00:00Z")
    const line = JSON.stringify(lineOf(good))
    return Effect.gen(function* () {
      const ledger = yield* Ledger
      expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([good, good])
    }).pipe(
      Effect.provide(
        services({
          files: {
            [`${usage}/2026-10.ndjson`]: [
              line,
              '{"_tag":"Request","at":"2026-10-05T11:0', // cut short by a crash
              '{"_tag":"Someday","at":"2026-10-05T12:00:00Z"}', // from a newer slopmax
              "",
              line,
            ].join("\n"),
            [`${usage}/notes.txt`]: line,
          },
        }),
      ),
    )
  })

  it.effect("reads a home with no ledger yet as empty", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      expect(yield* ledger.load(since("1970-01-01T00:00:00Z"))).toEqual([])
    }).pipe(Effect.provide(services())),
  )

  it.effect("loads records oldest first, though they are written as requests finish", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      // A long answer that began first finishes, and is recorded, last.
      const long = request("2026-10-05T10:00:00Z", { ms: 60_000 })
      const short = request("2026-10-05T10:00:30Z", { ms: 1_000 })
      yield* ledger.record(short)
      yield* ledger.record(long)
      yield* ledger.flush
      expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([long, short])
      expect(yield* Stream.runCollect(ledger.read(since("2026-10-01T00:00:00Z")))).toEqual([short, long])
    }).pipe(Effect.provide(services())),
  )

  it.effect("writes what is still queued when it closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // The ledger lives only as long as this inner program; nothing waits for its writer.
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.record(request("2026-10-05T10:00:00Z"))
        yield* ledger.record(request("2026-10-05T10:00:01Z"))
      }).pipe(Effect.provide(Ledger.layer))
      expect((yield* fs.readFileString(`${usage}/2026-10.ndjson`)).trimEnd().split("\n").length).toBe(2)
    }).pipe(
      Effect.provide(
        Events.layer.pipe(Layer.provideMerge(Home.layerAt(root)), Layer.provideMerge(MemoryFileSystem.layerWith({}))),
      ),
    ),
  )

  it.effect("tells the event feed of each request it records", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const events = yield* Events
      const reader = yield* events.subscribe.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* events.watchers.pipe(
        Stream.filter((n) => n > 0),
        Stream.take(1),
        Stream.runDrain,
      )
      const answer = request("2026-10-05T10:00:00Z")
      yield* ledger.record(ended("2026-10-05T09:00:00Z", "claude-1a2b3c4d", 40))
      yield* ledger.record(answer)
      const heard = yield* Fiber.join(reader)
      expect(heard.map((event) => event._tag)).toEqual(["Hello", "Request"])
      expect(heard[1]?._tag === "Request" ? heard[1].record : undefined).toEqual(answer)
    }).pipe(Effect.provide(services())),
  )

  it.effect("warns when a write fails and goes on writing what comes after", () =>
    Effect.gen(function* () {
      let failing = true
      const warnings: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(Array.ensure(message).map(String).join(" "))
        }),
      ])
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger
        const fs = yield* FileSystem.FileSystem
        yield* ledger.record(request("2026-10-05T10:00:00Z"))
        yield* ledger.flush
        failing = false
        const later = request("2026-10-05T10:00:01Z")
        yield* ledger.record(later)
        yield* ledger.flush
        expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([later])
        expect(yield* fs.exists(`${usage}/2026-10.ndjson`)).toBe(true)
      }).pipe(
        Effect.provide(
          services({
            fault: ({ method, path }) =>
              failing && method === "open" && path.startsWith(usage) ? "PermissionDenied" : undefined,
          }),
        ),
        Effect.provide(capture),
      )
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toStartWith("writing the usage ledger: ")
    }),
  )

  it.effect("keeps writing after something unexpected goes wrong with a batch, so closing never waits forever", () =>
    Effect.gen(function* () {
      let breaking = true
      const warnings: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(Array.ensure(message).map(String).join(" "))
        }),
      ])
      // A disk whose first append breaks in a way nothing expects.
      const breakingDisk = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
          ...fs,
          open: (path, options) =>
            breaking && path.startsWith(usage) ? Effect.die(new Error("the disk fell off")) : fs.open(path, options),
        })),
      ).pipe(Layer.provideMerge(MemoryFileSystem.layerWith({})))
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.record(request("2026-10-05T10:00:00Z"))
        yield* ledger.flush
        breaking = false
        const later = request("2026-10-05T10:00:01Z")
        yield* ledger.record(later)
        yield* ledger.flush
        expect(yield* ledger.load(since("2026-10-01T00:00:00Z"))).toEqual([later])
      }).pipe(
        Effect.provide(
          Ledger.layer.pipe(
            Layer.provideMerge(Events.layer),
            Layer.provideMerge(Home.layerAt(root)),
            Layer.provideMerge(breakingDisk),
          ),
        ),
        Effect.provide(capture),
      )
      expect(warnings).toEqual(["writing the usage ledger: the disk fell off"])
    }),
  )

  it.effect("appends at once without the queue, for a process that records one thing and exits", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const fs = yield* FileSystem.FileSystem
      yield* ledger.append([request("2026-11-01T00:00:00Z")])
      expect(yield* fs.readDirectory(usage)).toEqual(["2026-11.ndjson"])
    }).pipe(Effect.provide(services())),
  )

  it.effect("reads ended windows back once each, from a moment on", () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const a = ended("2026-10-03T00:00:00Z", "claude-aaaaaaaa", 40)
      const b = ended("2026-10-04T00:00:00Z", "claude-bbbbbbbb", 90)
      yield* ledger.record(a)
      yield* ledger.record(b)
      // Seen again after a restart.
      yield* ledger.record(a)
      yield* ledger.flush
      const all = yield* ledger.load(since("2026-10-01T00:00:00Z"))
      expect(windowsEnded(all, since("2026-10-01T00:00:00Z"))).toEqual([a, b])
      expect(windowsEnded(all, since("2026-10-03T12:00:00Z"))).toEqual([b])
    }).pipe(Effect.provide(services())),
  )
})

describe("ledger lines", () => {
  it("name their month file by the UTC month", () => {
    expect(monthFile(DateTime.makeUnsafe("2026-09-30T23:59:59.999Z"))).toBe("2026-09.ndjson")
    const berlin = DateTime.makeZonedUnsafe("2026-09-30T23:30:00Z", { timeZone: "Europe/Berlin" })
    expect(monthFile(berlin)).toBe("2026-09.ndjson")
  })

  it("read back what they wrote", () => {
    const record = request("2026-10-05T10:00:00.25Z", { agent: "claude-code", session: "s-1" })
    expect(parseLine(JSON.stringify(lineOf(record)))).toEqual(Option.some(record))
    expect(parseLine("not json")._tag).toBe("None")
  })
})

describe("windows that ran out", () => {
  const holderId = Schema.decodeUnknownSync(AccountId)
  const kept = holderId("claude-1a2b3c4d")
  const gone = holderId("codex-9f8e7d6c")

  it("are filed under their account's provider and plan, and dropped when the account is gone", () => {
    const endedAt = since("2026-10-05T00:00:00Z")
    const records = windowEndedRecords(
      [
        { account: kept, lapse: { span: "7d", used: 40, endedAt } },
        { account: kept, lapse: { span: "5h", model: "claude-opus-5-5", used: 90, endedAt } },
        { account: gone, lapse: { span: "7d", used: 10, endedAt } },
      ],
      new Map([[kept, { provider: "claude", plan: "max 20x" }]]),
    )
    expect(records).toEqual([
      ended("2026-10-05T00:00:00Z", "claude-1a2b3c4d", 40),
      decodeEnded({
        _tag: "WindowEnded",
        at: "2026-10-05T00:00:00Z",
        account: "claude-1a2b3c4d",
        provider: "claude",
        plan: "max 20x",
        span: "5h",
        model: "claude-opus-5-5",
        used: 90,
      }),
    ])
  })
})
