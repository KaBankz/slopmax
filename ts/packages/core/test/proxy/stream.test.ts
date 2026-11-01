// The held start, the relay and the stall sweeper, over hand-driven streams
// and the test clock.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Opening, ReportingTap, Tap, type TapReport } from "@slopmax/wire"
import { Clock, Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Held, holdLimit, holdStart } from "../../src/proxy/hold.ts"
import { LiveStreams, stallMessage } from "../../src/proxy/live.ts"
import { relay } from "../../src/proxy/relay.ts"

const utf8 = new TextEncoder()
const text = new TextDecoder()

/** A body that sends `chunks` one per read, then ends. */
const body = (chunks: ReadonlyArray<string>) => {
  let next = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(utf8.encode(chunk))
    },
  })
}

/** A body the test feeds by hand: what it has been pulled for, what was cancelled. */
const driven = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const state: { pulls: number; cancelled: unknown } = { pulls: 0, cancelled: undefined }
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c
      },
      pull: () => {
        state.pulls++
      },
      cancel: (reason) => {
        state.cancelled = reason ?? "cancelled"
      },
    },
    { highWaterMark: 0 },
  )
  return {
    stream,
    state,
    send: (chunk: string) => controller?.enqueue(utf8.encode(chunk)),
    end: () => controller?.close(),
    fail: (error: Error) => controller?.error(error),
  }
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const created = event({ type: "response.created", response: { id: "resp_1" } })
const added = event({ type: "response.output_item.added", item: { type: "message" } })
const completed = event({ type: "response.completed", response: { id: "resp_1" } })

/** Reads a relayed answer to its end. */
const readAll = (stream: ReadableStream<Uint8Array>) => Effect.promise(() => new Response(stream).text())

/** A tap that keeps what it reports. */
const reporting = (clock: Clock.Clock) => {
  const reports: Array<TapReport> = []
  const tap = new ReportingTap(
    Tap.forResponse("responses", new Headers({ "content-type": "text/event-stream" })),
    () => clock.currentTimeMillisUnsafe(),
    (report) => reports.push(report),
  )
  return { tap, reports }
}

/** Relays what a held start left, as the attempt does. */
const relayHeld = (held: Held, tap: ReportingTap) =>
  Effect.gen(function* () {
    if (held._tag !== "Streaming") return yield* Effect.die("the start was refused")
    const live = yield* LiveStreams
    const clock = yield* Clock.Clock
    return relay(
      { reader: held.reader, held: held.held, pending: held.pending, tap, transcoder: undefined, clock },
      live,
    )
  })

describe("holding back the start of a Responses answer", () => {
  it.effect("streams content with the held start replayed first", () =>
    Effect.gen(function* () {
      const stream = `${created}${added}${completed}`
      const held = yield* holdStart(body([created, added, completed]), new Opening("responses"))
      expect(held._tag).toBe("Streaming")
      const { tap, reports } = reporting(yield* Clock.Clock)
      expect(yield* readAll(yield* relayHeld(held, tap))).toBe(stream)
      expect(reports.map((report) => report.how)).toEqual(["ended"])
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("catches a spent quota before the agent sees a byte", () =>
    Effect.gen(function* () {
      const failed = event({ type: "response.failed", response: { error: { code: "usage_limit_reached" } } })
      const source = driven()
      source.send(created)
      source.send(failed)
      const held = yield* holdStart(source.stream, new Opening("responses"))
      expect(held._tag).toBe("Refused")
      if (held._tag !== "Refused") return
      expect(held.exhausted).toBe(true)
      expect(text.decode(held.bytes)).toBe(`${created}${failed}`)
      // The rest of the refused answer is not read.
      expect(source.state.cancelled).toBeDefined()
    }),
  )

  it.effect("moves on from an overloaded start without calling the account spent", () =>
    Effect.gen(function* () {
      const busy = event({ type: "response.failed", response: { error: { code: "server_is_overloaded" } } })
      const held = yield* holdStart(body([created, busy]), new Opening("responses"))
      expect(held._tag === "Refused" ? held.exhausted : "streaming").toBe(false)
    }),
  )

  it.effect("passes a failure that is the request's own to the agent", () =>
    Effect.gen(function* () {
      const tooLong = event({ type: "response.failed", response: { error: { code: "context_length_exceeded" } } })
      const held = yield* holdStart(body([tooLong]), new Opening("responses"))
      expect(held._tag).toBe("Streaming")
    }),
  )

  it.effect("streams what was held once 3 seconds pass, losing no chunk read meanwhile", () =>
    Effect.gen(function* () {
      const source = driven()
      source.send(created)
      const fiber = yield* Effect.forkChild(holdStart(source.stream, new Opening("responses")))
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(2999))
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(1))
      const held = yield* Fiber.join(fiber)
      expect(held._tag === "Streaming" ? held.pending : undefined).toBeDefined()
      // The read in flight when the wait ran out is the relay's next chunk.
      source.send(added)
      source.send(completed)
      source.end()
      const { tap } = reporting(yield* Clock.Clock)
      expect(yield* readAll(yield* relayHeld(held, tap))).toBe(`${created}${added}${completed}`)
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("stops holding at 256 KiB", () =>
    Effect.gen(function* () {
      const filler = `: ${"x".repeat(64 * 1024)}\n`
      const chunks = Array.from({ length: holdLimit / filler.length + 2 }, () => filler)
      const source = driven()
      for (const chunk of chunks) source.send(chunk)
      const held = yield* holdStart(source.stream, new Opening("responses"))
      expect(held._tag).toBe("Streaming")
      if (held._tag !== "Streaming") return
      const size = held.held.reduce((sum, chunk) => sum + chunk.length, 0)
      expect(size).toBeGreaterThanOrEqual(holdLimit)
      expect(size).toBeLessThan(holdLimit + filler.length + 8)
      expect(source.state.cancelled).toBeUndefined()
    }),
  )

  it.effect("stops reading the provider when the request is dropped while its start is held", () =>
    Effect.gen(function* () {
      const source = driven()
      source.send(created)
      const fiber = yield* Effect.forkChild(holdStart(source.stream, new Opening("responses")))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(source.state.cancelled).toBeDefined()
    }),
  )
})

describe("relaying an answer", () => {
  it.effect("reads the provider only as fast as the client reads", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap } = reporting(yield* Clock.Clock)
      const live = yield* LiveStreams
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        live,
      )
      const reader = out.getReader()
      yield* Effect.yieldNow
      expect(source.state.pulls).toBe(0)
      const first = reader.read()
      source.send(created)
      expect(text.decode((yield* Effect.promise(() => first)).value)).toBe(created)
      // Nothing is read ahead of the client.
      expect(source.state.pulls).toBe(1)
      expect(yield* live.size).toBe(1)
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("stops the provider and settles once when the client hangs up", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap, reports } = reporting(yield* Clock.Clock)
      const live = yield* LiveStreams
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        live,
      )
      const reader = out.getReader()
      const first = reader.read()
      source.send(created)
      yield* Effect.promise(() => first)
      yield* Effect.promise(() => reader.cancel("gone"))
      expect(source.state.cancelled).toBe("gone")
      expect(reports.map((report) => report.how)).toEqual(["dropped"])
      expect(reports[0]?.firstByteAt).toBe(0)
      expect(yield* live.size).toBe(0)
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("reports a provider that broke off as an errored answer, to the client too", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap, reports } = reporting(yield* Clock.Clock)
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [utf8.encode(created)],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        yield* LiveStreams,
      )
      const reader = out.getReader()
      expect(text.decode((yield* Effect.promise(() => reader.read())).value)).toBe(created)
      const next = reader.read()
      source.fail(new Error("connection reset"))
      const read = yield* Effect.promise(() =>
        next.then(
          () => "read",
          (error: unknown) => String(error),
        ),
      )
      expect(read).toContain("connection reset")
      expect(reports.map((report) => report.how)).toEqual(["errored"])
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("cuts an answer silent for 600 seconds and settles it as stalled", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap, reports } = reporting(yield* Clock.Clock)
      const live = yield* LiveStreams
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        live,
      )
      const reader = out.getReader()
      const first = reader.read()
      source.send(created)
      yield* Effect.promise(() => first)
      const waiting = reader.read().then(
        () => "read",
        (error: unknown) => String(error),
      )
      // A chunk at 590 s keeps it alive past the first 600 s.
      yield* TestClock.adjust(Duration.seconds(590))
      source.send(added)
      yield* Effect.promise(() => waiting)
      const stalled = reader.read().then(
        () => "read",
        (error: unknown) => String(error),
      )
      yield* TestClock.adjust(Duration.seconds(590))
      expect(reports).toHaveLength(0)
      yield* TestClock.adjust(Duration.seconds(20))
      expect(yield* Effect.promise(() => stalled)).toContain(stallMessage)
      expect(stallMessage).toBe("no data for 600 s")
      expect(reports.map((report) => report.how)).toEqual(["stalled"])
      expect(source.state.cancelled).toBe(stallMessage)
      expect(yield* live.size).toBe(0)
    }).pipe(Effect.provide(LiveStreams.layer)),
  )
})

describe("draining answers at shutdown", () => {
  it.effect("waits for answers to finish, up to 10 seconds", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap, reports } = reporting(yield* Clock.Clock)
      const live = yield* LiveStreams
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        live,
      )
      const drained = yield* Effect.forkChild(live.drain())
      yield* TestClock.adjust(Duration.seconds(4))
      expect(drained.pollUnsafe()).toBeUndefined()
      source.send(completed)
      source.end()
      expect(yield* readAll(out)).toBe(completed)
      yield* Fiber.join(drained)
      expect(reports.map((report) => report.how)).toEqual(["ended"])
    }).pipe(Effect.provide(LiveStreams.layer)),
  )

  it.effect("cuts what is still streaming after 10 seconds", () =>
    Effect.gen(function* () {
      const source = driven()
      const { tap, reports } = reporting(yield* Clock.Clock)
      const live = yield* LiveStreams
      const out = relay(
        {
          reader: source.stream.getReader(),
          held: [],
          pending: undefined,
          tap,
          transcoder: undefined,
          clock: yield* Clock.Clock,
        },
        live,
      )
      const reading = out
        .getReader()
        .read()
        .then(
          () => "read",
          (error: unknown) => String(error),
        )
      const drained = yield* Effect.forkChild(live.drain())
      yield* TestClock.adjust(Duration.seconds(10))
      yield* Fiber.join(drained)
      expect(yield* Effect.promise(() => reading)).toContain("slopmax is shutting down")
      expect(reports.map((report) => report.how)).toEqual(["errored"])
      expect(source.state.cancelled).toBeDefined()
    }).pipe(Effect.provide(LiveStreams.layer)),
  )
})
