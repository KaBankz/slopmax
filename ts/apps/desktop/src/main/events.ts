// Main follows the daemon over the same event stream every front end uses,
// so nothing polls while the proxy runs: `Hello` says it is up and on which
// release, `Status` carries each new report for the tray, and `Notice` is
// posted as a notification. When the stream drops, main finds out whether the
// proxy stopped or restarted, and reconnects: after a second, then backing
// off to every 15 seconds while it does not answer. While the proxy is
// stopped, main keeps looking at its address, so one started from the
// terminal is picked up.
import { Context, Data, Effect, Layer, Option, Redacted, Schedule, Stream, SubscriptionRef } from "effect"
import type { Event, Report } from "@slopmax/domain"
import { SlopmaxApi } from "@slopmax/domain/api"
import type { ProxyState } from "@slopmax/domain/desktop"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { type Connection, Engine } from "./engine.ts"
import { Notifications } from "./notifications.ts"

/** Waits between tries to reach a proxy that does not answer: 1 s, doubling up to 15 s. */
export const backoff = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("15 seconds")])

/** How soon a stream that was up and dropped is tried again. */
export const again = Schedule.spaced("1 second")

/** One connection to the stream ended; `heard` when the proxy said hello on it first. */
class Dropped extends Data.TaggedError("Dropped")<{ readonly heard: boolean }> {}

export const connected = (state: ProxyState): boolean => state._tag === "Running" || state._tag === "OtherVersion"

export interface Shape {
  /** The last report the proxy sent, if any. */
  readonly report: Effect.Effect<Option.Option<Report>>
  /** The last report now, then each new one. */
  readonly reports: Stream.Stream<Option.Option<Report>>
  /** Follows the proxy for as long as the app runs. */
  readonly follow: Effect.Effect<never>
}

const make = Effect.gen(function* () {
  const engine = yield* Engine
  const notifications = yield* Notifications
  const http = yield* HttpClient.HttpClient
  const report = yield* SubscriptionRef.make(Option.none<Report>())

  const until = (accept: (state: ProxyState) => boolean) =>
    engine.changes.pipe(Stream.filter(accept), Stream.runHead, Effect.asVoid)

  const clientFor = (connection: Connection) =>
    HttpApiClient.make(SlopmaxApi, {
      baseUrl: connection.url,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(connection.key))),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http))

  const onEvent = (event: Event): Effect.Effect<void> => {
    switch (event._tag) {
      case "Hello":
        return engine.heard(event.version)
      case "Status":
        return SubscriptionRef.set(report, Option.some(event.report))
      case "Notice":
        return notifications.notice(event.notice)
      case "Request":
      case "Login":
      case "Ping":
        return Effect.void
    }
  }

  /** One connection: waits for a running proxy, follows its stream until it drops, then sees why. */
  const session = Effect.gen(function* () {
    yield* until(connected)
    const connection = yield* engine.last
    if (Option.isNone(connection)) return yield* new Dropped({ heard: false })
    const client = yield* clientFor(connection.value)
    let heard = false
    yield* client.events.watch().pipe(
      Effect.flatMap((stream) =>
        Stream.runForEach(stream, (event) => {
          if (event._tag === "Hello") heard = true
          return onEvent(event)
        }),
      ),
      Effect.ignore,
    )
    yield* engine.lost
    return yield* new Dropped({ heard })
  })

  const following = session.pipe(
    // Not reached, or refused at once: back off.
    Effect.retry({ schedule: backoff, while: (dropped) => !dropped.heard }),
    // It was up and dropped: try again in a second, backing off afresh.
    Effect.retry({ schedule: again, while: (dropped) => dropped.heard }),
    Effect.orDie,
  )

  /** While the proxy is stopped, looks at its last address now and then; one that answers is taken up. */
  const watching = Effect.gen(function* () {
    yield* until((state) => state._tag === "Stopped")
    const last = yield* engine.last
    if (Option.isNone(last)) return
    if (Option.isSome(yield* engine.alive(last.value.url))) yield* engine.launch
  }).pipe(Effect.repeat(backoff))

  const follow: Shape["follow"] = Effect.all([following, watching], { concurrency: "unbounded" }).pipe(
    Effect.andThen(Effect.never),
  )

  return {
    report: SubscriptionRef.get(report),
    reports: SubscriptionRef.changes(report),
    follow,
  } satisfies Shape
})

export class Follower extends Context.Service<Follower, Shape>()("slopmax-desktop/Follower") {
  static readonly layer: Layer.Layer<Follower, never, Engine | Notifications | HttpClient.HttpClient> = Layer.effect(
    Follower,
    make,
  )
}
