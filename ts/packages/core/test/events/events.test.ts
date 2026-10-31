import { describe, expect } from "bun:test"
import { Event, LedgerRecord, Notice, Report, slopmaxVersion } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Effect, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { backlog, Events } from "../../src/events.ts"

const at = DateTime.makeUnsafe("2026-10-31T12:00:00Z")

const report = (strategy: "reset-first" | "fill-first") =>
  new Report({ version: slopmaxVersion, live: true, generatedAt: at, strategy, accounts: [], pools: [], nudges: [] })

const status = (strategy: "reset-first" | "fill-first") => Event.cases.Status.make({ report: report(strategy) })

const request = (ms: number) =>
  Event.cases.Request.make({
    record: Schema.decodeUnknownSync(LedgerRecord.cases.Request)({
      _tag: "Request",
      at: "2026-10-31T12:00:00Z",
      provider: "claude",
      status: 200,
      ms,
    }),
  })

const notice = Event.cases.Notice.make({
  notice: new Notice({ kind: "test", key: "test", message: "slopmax notifications are working.", at }),
})

/** Waits until `n` connections are open. */
const connected = (n: number) =>
  Effect.flatMap(Events, (events) =>
    events.watchers.pipe(
      Stream.filter((count) => count >= n),
      Stream.take(1),
      Stream.runDrain,
    ),
  )

/** Starts a connection that reads `n` events. */
const reading = (n: number) =>
  Effect.flatMap(Events, (events) => events.subscribe.pipe(Stream.take(n), Stream.runCollect, Effect.forkScoped))

const tags = (events: ReadonlyArray<Event>) => events.map((event) => event._tag)

describe("Events", () => {
  it.effect("greets each connection with Hello and its version, then passes on what is published", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const reader = yield* reading(3)
      yield* connected(1)
      yield* events.publish(request(900))
      yield* events.publish(notice)
      const heard = yield* Fiber.join(reader)
      expect(tags(heard)).toEqual(["Hello", "Request", "Notice"])
      expect(heard[0]).toEqual(Event.cases.Hello.make({ version: slopmaxVersion }))
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("tells a connection that arrives between reports the latest one, right after Hello", () =>
    Effect.gen(function* () {
      const events = yield* Events
      // Someone watches throughout, so reports are being kept current.
      const watcher = yield* reading(100)
      yield* connected(1)
      yield* events.publish(status("reset-first"))
      yield* events.publish(status("fill-first"))
      const heard = yield* Fiber.join(yield* reading(2))
      expect(tags(heard)).toEqual(["Hello", "Status"])
      expect(heard[1]).toEqual(status("fill-first"))
      yield* Fiber.interrupt(watcher)
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("forgets the latest report once nobody watches, since nobody keeps it current then", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const first = yield* reading(2)
      yield* connected(1)
      yield* events.publish(status("reset-first"))
      yield* Fiber.join(first)
      expect(yield* events.watching).toBe(false)
      const later = yield* reading(2)
      yield* connected(1)
      yield* events.publish(request(5))
      expect(tags(yield* Fiber.join(later))).toEqual(["Hello", "Request"])
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("keeps no report published while nobody watches", () =>
    Effect.gen(function* () {
      const events = yield* Events
      yield* events.publish(status("reset-first"))
      const reader = yield* reading(2)
      yield* connected(1)
      yield* events.publish(request(5))
      expect(tags(yield* Fiber.join(reader))).toEqual(["Hello", "Request"])
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("pings a connection every 15 seconds", () =>
    Effect.gen(function* () {
      const reader = yield* reading(3)
      yield* connected(1)
      yield* TestClock.adjust("15 seconds")
      yield* TestClock.adjust("15 seconds")
      expect(tags(yield* Fiber.join(reader))).toEqual(["Hello", "Ping", "Ping"])
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("says whether anyone watches, and counts connections as they come and go", () =>
    Effect.gen(function* () {
      const events = yield* Events
      expect(yield* events.watching).toBe(false)
      const one = yield* reading(10)
      const two = yield* reading(10)
      yield* connected(2)
      expect(yield* events.watching).toBe(true)
      yield* Fiber.interrupt(one)
      yield* Fiber.interrupt(two)
      expect(yield* events.watching).toBe(false)
    }).pipe(Effect.provide(Events.layer)),
  )

  it.effect("never makes a publisher wait: a reader that falls behind loses the oldest events", () =>
    Effect.gen(function* () {
      const events = yield* Events
      const published = backlog + 44
      const reader = yield* events.subscribe.pipe(
        // The reader sits on its greeting while everything is published.
        Stream.tap((event) => (event._tag === "Hello" ? Effect.sleep("1 second") : Effect.void)),
        Stream.filter((event) => event._tag === "Request"),
        Stream.take(backlog),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* connected(1)
      for (let ms = 0; ms < published; ms++) yield* events.publish(request(ms))
      yield* TestClock.adjust("1 second")
      const heard = (yield* Fiber.join(reader)).map((event) => (event._tag === "Request" ? event.record.ms : -1))
      expect(heard.length).toBe(backlog)
      expect(heard[0]).toBe(published - backlog)
      expect(heard.at(-1)).toBe(published - 1)
    }).pipe(Effect.provide(Events.layer)),
  )
})
