// The answers being relayed right now.
//
// A provider can stop sending partway through an answer without closing it.
// Rather than a timer per stream, every relay notes when its last chunk
// passed, and one sweep every 10 seconds cuts the streams that have been
// silent for 600 seconds, so a stuck answer never holds a client forever.
// Shutdown waits for the same set to empty (at most 10 seconds) before it
// cuts what is left.
import { Clock, Context, Duration, Effect, Layer, Option, Schedule } from "effect"

/** One relayed answer, as the sweeper and shutdown see it. */
export interface LiveStream {
  /** When its last chunk passed (clock milliseconds); the relay sets it on every chunk. */
  lastChunkAt: number
  /** Ends the answer: the client gets an error, the upstream read is cancelled, and it settles. */
  readonly cut: (how: "stalled" | "shutdown", message: string) => void
}

/** How long an answer may send nothing before it is cut. */
export const stallAfter: Duration.Duration = Duration.seconds(600)

/** How often the sweeper looks. */
export const sweepEvery: Duration.Duration = Duration.seconds(10)

/** How long shutdown waits for answers to finish. */
export const drainWait: Duration.Duration = Duration.seconds(10)

/** What a client hears when its answer is cut for silence. */
export const stallMessage = `no data for ${Duration.toSeconds(stallAfter)} s`

export interface Shape {
  /** Starts watching an answer. Synchronous: the relay calls it from its stream. */
  readonly add: (stream: LiveStream) => void
  /** Stops watching an answer that ended. */
  readonly remove: (stream: LiveStream) => void
  /** How many answers are being relayed. */
  readonly size: Effect.Effect<number>
  /** Cuts every answer silent for {@link stallAfter}, returning how many. */
  readonly sweep: Effect.Effect<number>
  /** Waits up to `wait` for every answer to finish, then cuts the rest. */
  readonly drain: (wait?: Duration.Duration) => Effect.Effect<void>
}

const make = Effect.gen(function* () {
  const live = new Set<LiveStream>()
  // Shutdown waits on these; each is called once the set is empty.
  const waiting = new Set<() => void>()

  const remove = (stream: LiveStream): void => {
    live.delete(stream)
    if (live.size > 0 || waiting.size === 0) return
    for (const wake of waiting) wake()
    waiting.clear()
  }

  const sweep = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.sync(() => {
      const limit = Duration.toMillis(stallAfter)
      let cut = 0
      // Cutting removes the stream from the set; a Set visits each entry once even so.
      for (const stream of live) {
        if (now - stream.lastChunkAt < limit) continue
        cut++
        stream.cut("stalled", stallMessage)
      }
      return cut
    }),
  )

  const emptied: Effect.Effect<void> = Effect.callback<void>((resume) => {
    if (live.size === 0) return resume(Effect.void)
    const wake = () => resume(Effect.void)
    waiting.add(wake)
    return Effect.sync(() => void waiting.delete(wake))
  })

  const drain = (wait: Duration.Duration = drainWait): Effect.Effect<void> =>
    Effect.gen(function* () {
      const done = yield* Effect.timeoutOption(emptied, wait)
      if (Option.isSome(done)) return
      for (const stream of live) stream.cut("shutdown", "slopmax is shutting down")
    })

  yield* sweep.pipe(Effect.repeat(Schedule.spaced(sweepEvery)), Effect.forkScoped)

  return {
    add: (stream) => void live.add(stream),
    remove,
    size: Effect.sync(() => live.size),
    sweep,
    drain,
  } satisfies Shape
})

/** The answers being relayed, swept for stalls for the life of the layer. */
export class LiveStreams extends Context.Service<LiveStreams, Shape>()("@slopmax/core/proxy/LiveStreams", { make }) {
  static readonly layer: Layer.Layer<LiveStreams> = Layer.effect(LiveStreams, LiveStreams.make)
}
