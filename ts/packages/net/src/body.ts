// Body types shared by the server and the client. A body is a stream of
// byte chunks; these helpers build, read, prefix, and time them.
import { fmt } from "@slopmax/common"
import { Data, Duration, Effect, Stream } from "effect"

/** A body: buffered, empty, or streamed from upstream. */
export type Body<E = unknown> = Stream.Stream<Uint8Array, E>

const utf8 = new TextEncoder()

export const full = (bytes: Uint8Array | string): Body<never> =>
  Stream.succeed(typeof bytes === "string" ? utf8.encode(bytes) : bytes)

export const empty: Body<never> = Stream.empty

/** A body read by {@link read} went past its limit. The proxy answers 413. */
export class LengthLimitError extends Data.TaggedError("LengthLimitError")<{ readonly limit: number }> {
  override get message(): string {
    return "length limit exceeded"
  }
}

/** A body read by {@link readAll} went past its limit. */
export class TooLarge extends Data.TaggedError("TooLarge")<{ readonly limit: number }> {
  override get message(): string {
    return `body exceeds ${this.limit} bytes`
  }
}

/** Reading a body from its connection failed. */
export class ReadError extends Data.TaggedError("ReadError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason
  }
}

/** A body sent nothing for `idle`. */
export class Stalled extends Data.TaggedError("Stalled")<{ readonly idle: Duration.Duration }> {
  override get message(): string {
    return `no data for ${fmt.debugDuration(Duration.toNanosUnsafe(this.idle))}`
  }
}

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array()
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const collect = <E, X>(body: Body<E>, limit: number, over: (limit: number) => X): Effect.Effect<Uint8Array, E | X> =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = []
    let size = 0
    return body.pipe(
      Stream.runForEach((chunk) => {
        if (size + chunk.length > limit) return Effect.fail(over(limit))
        chunks.push(chunk)
        size += chunk.length
        return Effect.void
      }),
      Effect.map(() => concat(chunks, size)),
    )
  })

/** Reads a whole body, failing once it exceeds `limit` bytes. */
export const read = <E>(body: Body<E>, limit: number): Effect.Effect<Uint8Array, E | LengthLimitError> =>
  collect(body, limit, (over) => new LengthLimitError({ limit: over }))

/**
 * Reads a whole body, failing once it exceeds `limit` bytes with
 * `body exceeds {limit} bytes`.
 */
export const readAll = <E>(body: Body<E>, limit: number): Effect.Effect<Uint8Array, E | TooLarge> =>
  collect(body, limit, (over) => new TooLarge({ limit: over }))

/** A body that yields `held` chunks first, then the rest of `inner`. */
export const prefixed = <E>(held: Iterable<Uint8Array>, inner: Body<E>): Body<E> =>
  Stream.concat(Stream.fromIterable(held), inner)

/**
 * Fails a body that sends nothing for `idle`: a stalled upstream stream
 * should not hold a connection open forever. The wait restarts with every
 * chunk and is measured on the `Clock`.
 */
export const idleTimeout = <E>(inner: Body<E>, idle: Duration.Input): Body<E | Stalled> => {
  const duration = Duration.fromInputUnsafe(idle)
  return Stream.timeoutOrElse(inner, {
    duration,
    orElse: () => Stream.fail(new Stalled({ idle: duration })),
  })
}
