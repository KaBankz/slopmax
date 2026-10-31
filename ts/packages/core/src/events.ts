// The live feed every front end watches: the dashboard, the desktop window,
// its menu bar and `slopmax status --watch` all read this one stream (served
// as `GET /events`), so none of them polls.
//
// A connection hears `Hello` first, which is how a front end knows the proxy
// is live, then the latest status report when one is current, then every
// event as it happens, with a `Ping` every 15 seconds so proxies in between
// keep the stream open. Events go through a sliding buffer of 256: a reader
// that falls behind loses the oldest events it has not read, and nothing that
// publishes (a request settling, a notice) ever waits for a reader.
import { Event, slopmaxVersion } from "@slopmax/domain"
import { Context, Duration, Effect, Layer, Option, PubSub, Stream, SubscriptionRef } from "effect"

/** How many unread events a connection may fall behind before it skips the oldest. */
export const backlog = 256

/** How often a quiet connection hears a ping. */
export const pingEvery: Duration.Duration = Duration.seconds(15)

type StatusEvent = typeof Event.cases.Status.Type

export interface Shape {
  /** Tells every connection; never waits. */
  readonly publish: (event: Event) => Effect.Effect<void>
  /** `Hello`, the current `Status` when there is one, then live events and pings, until the reader goes. */
  readonly subscribe: Stream.Stream<Event>
  /** Whether anyone is connected, so work only a watcher needs (building reports) can be skipped. */
  readonly watching: Effect.Effect<boolean>
  /** The number of connections now and after every change, so a status publisher can wake when someone arrives. */
  readonly watchers: Stream.Stream<number>
}

const hello = Event.cases.Hello.make({ version: slopmaxVersion })
const ping = Event.cases.Ping.make({})

interface Watching {
  /** Connections open now. */
  readonly count: number
  /**
   * The last report sent, for a connection that arrives between reports.
   * Kept only while someone watches: nobody builds reports while nobody
   * watches, so it would be stale by the time someone came back. Held with
   * the count so a connection leaving and one arriving never race over it.
   */
  readonly latest: Option.Option<StatusEvent>
}

export const make: Effect.Effect<Shape> = Effect.gen(function* () {
  const hub = yield* PubSub.sliding<Event>(backlog)
  const state = yield* SubscriptionRef.make<Watching>({ count: 0, latest: Option.none() })

  // Untraced: every request that settles publishes here, and a span each
  // would cost more than the publish.
  const publish = Effect.fnUntraced(function* (event: Event) {
    if (event._tag === "Status") {
      yield* SubscriptionRef.update(state, (now) => (now.count > 0 ? { ...now, latest: Option.some(event) } : now))
    }
    yield* PubSub.publish(hub, event)
  })

  /** Counts a connection in and gives it the latest report. */
  const arrive = SubscriptionRef.modify(state, (now) => [now.latest, { ...now, count: now.count + 1 }] as const)
  const leave = SubscriptionRef.update(state, (now) =>
    now.count <= 1 ? { count: 0, latest: Option.none() } : { ...now, count: now.count - 1 },
  )

  const subscribe: Stream.Stream<Event> = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the latest report is read, so nothing published in
      // between is missed.
      const subscription = yield* PubSub.subscribe(hub)
      const status = yield* Effect.acquireRelease(arrive, () => leave)
      const pings = Stream.tick(pingEvery).pipe(
        Stream.drop(1),
        Stream.map((): Event => ping),
      )
      return Stream.concat(
        Stream.fromIterable<Event>([hello, ...Option.toArray(status)]),
        Stream.merge(Stream.fromSubscription(subscription), pings),
      )
    }),
  )

  return {
    publish,
    subscribe,
    watching: Effect.map(SubscriptionRef.get(state), (now) => now.count > 0),
    watchers: SubscriptionRef.changes(state).pipe(
      Stream.map((now) => now.count),
      Stream.changes,
    ),
  }
})

/** The event feed. */
export class Events extends Context.Service<Events, Shape>()("@slopmax/core/Events", { make }) {
  static readonly layer: Layer.Layer<Events> = Layer.effect(Events, Events.make)
}
