import { describe, expect } from "bun:test"
import { Duration, Effect, Fiber, Layer, Option, Queue, Redacted, Ref, Schema, SubscriptionRef } from "effect"
import { Event, Notice } from "@slopmax/domain"
import { ProxyState } from "@slopmax/domain/desktop"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { it } from "@slopmax/test"
import type { Connection } from "../src/main/engine.ts"
import { Follower } from "../src/main/events.ts"
import { Notifications } from "../src/main/notifications.ts"
import { fakeEngine, report } from "./support.ts"

const encodeEvent = Schema.encodeSync(Event)
const sse = (events: ReadonlyArray<Event>) =>
  events.map((event) => `data: ${JSON.stringify(encodeEvent(event))}\n\n`).join("")

const connection: Connection = { url: "http://127.0.0.1:7567", key: Redacted.make("sm-one"), version: "0.4.0" }

const notice = new Notice({
  kind: "exhausted",
  key: "exhausted:claude",
  message: "Every Claude account is limited",
  at: report().generatedAt,
})

/**
 * A follower over a proxy whose event stream sends `scripts` in turn, one
 * per connection (the last again after that), each then ending as a dropped
 * connection would.
 */
const following = (scripts: ReadonlyArray<ReadonlyArray<Event>>) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ProxyState>(ProxyState.cases.Running.make({ version: "0.4.0" }))
    const heard = yield* Queue.unbounded<string>()
    const lost = yield* Ref.make(0)
    const posted = yield* Queue.unbounded<string>()
    const connections = yield* Ref.make(0)
    const asked: Array<string> = []
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        asked.push(`${request.url} ${request.headers["authorization"] ?? ""}`)
        const turn = yield* Ref.getAndUpdate(connections, (n) => n + 1)
        const script = scripts[Math.min(turn, scripts.length - 1)] ?? []
        return HttpClientResponse.fromWeb(
          request,
          new Response(sse(script), { headers: { "content-type": "text/event-stream" } }),
        )
      }),
    )
    const layer = Follower.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeEngine({
            changes: SubscriptionRef.changes(state),
            last: Effect.succeed(Option.some(connection)),
            heard: (version) => Queue.offer(heard, version),
            lost: Effect.andThen(
              Ref.update(lost, (n) => n + 1),
              SubscriptionRef.set(state, ProxyState.cases.Stopped.make({})),
            ),
            alive: () => Effect.succeed(Option.none()),
          }),
          Layer.succeed(Notifications, {
            notice: (found) => Queue.offer(posted, found.key),
            say: () => Effect.void,
          }),
          Layer.succeed(HttpClient.HttpClient, http),
        ),
      ),
    )
    return { layer, state, heard, lost, posted, connections, asked }
  })

describe("following the proxy's events", () => {
  it.effect("hears hello, keeps each report for the tray, and posts notices", () =>
    Effect.gen(function* () {
      const setup = yield* following([
        [
          Event.cases.Hello.make({ version: "0.4.0" }),
          Event.cases.Status.make({ report: report() }),
          Event.cases.Notice.make({ notice }),
        ],
      ])
      yield* Effect.gen(function* () {
        const follower = yield* Follower
        const fiber = yield* Effect.forkChild(follower.follow)
        expect(yield* Queue.take(setup.heard)).toBe("0.4.0")
        expect(yield* Queue.take(setup.posted)).toBe("exhausted:claude")
        expect(Option.map(yield* follower.report, (found) => found.version)).toEqual(Option.some("0.4.0"))
        expect(setup.asked[0]).toBe("http://127.0.0.1:7567/slopmax/api/events Bearer sm-one")
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(setup.layer))
    }),
  )

  it.effect("a stream that drops is reported, and followed again once the proxy runs", () =>
    Effect.gen(function* () {
      const setup = yield* following([[Event.cases.Hello.make({ version: "0.4.0" })]])
      yield* Effect.gen(function* () {
        const follower = yield* Follower
        const fiber = yield* Effect.forkChild(follower.follow)
        yield* Queue.take(setup.heard)
        yield* TestClock.adjust("10 millis")
        // The stream ended: the engine was told, and found the proxy stopped.
        expect(yield* Ref.get(setup.lost)).toBe(1)
        expect(yield* Ref.get(setup.connections)).toBe(1)
        // While it is stopped nothing connects, however long it waits.
        yield* TestClock.adjust("1 minute")
        expect(yield* Ref.get(setup.connections)).toBe(1)
        // Running again: the stream is followed again.
        yield* SubscriptionRef.set(setup.state, ProxyState.cases.Running.make({ version: "0.4.0" }))
        yield* TestClock.adjust("1 second")
        expect(yield* Queue.take(setup.heard)).toBe("0.4.0")
        expect(yield* Ref.get(setup.connections)).toBe(2)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(setup.layer))
    }),
  )

  it.effect("a proxy that never says hello is tried again less and less often, up to every 15 seconds", () =>
    Effect.gen(function* () {
      const setup = yield* following([[]])
      yield* Effect.gen(function* () {
        const follower = yield* Follower
        // Each drop reads as stopped; the test says it runs again before each try.
        const fiber = yield* Effect.forkChild(follower.follow)
        yield* SubscriptionRef.set(setup.state, ProxyState.cases.Running.make({ version: "0.4.0" }))
        const counts: Array<number> = []
        for (const step of [0, 1, 2, 4, 8, 15]) {
          yield* SubscriptionRef.set(setup.state, ProxyState.cases.Running.make({ version: "0.4.0" }))
          yield* TestClock.adjust(Duration.seconds(step))
          counts.push(yield* Ref.get(setup.connections))
        }
        expect(counts).toEqual([1, 2, 3, 4, 5, 6])
        // Capped: the next try is 15 seconds on, not 16.
        yield* SubscriptionRef.set(setup.state, ProxyState.cases.Running.make({ version: "0.4.0" }))
        yield* TestClock.adjust("14 seconds")
        expect(yield* Ref.get(setup.connections)).toBe(6)
        yield* TestClock.adjust("1 second")
        expect(yield* Ref.get(setup.connections)).toBe(7)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(setup.layer))
    }),
  )
})
