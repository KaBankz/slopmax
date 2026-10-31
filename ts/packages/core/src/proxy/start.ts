// Holding back the start of a stream until it opens.
//
// A refusal can arrive inside a 200 stream, right after the response is
// created. Holding the first events back for a moment lets the proxy see
// it and move to another account before the agent has received anything.
// Once content starts (or the wait runs out) the held bytes are replayed
// and the stream passes through untouched.
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import type * as Arr from "effect/Array"

import { Dialect, json, Opening } from "@slopmax/wire"

import { dataOf, Growable } from "./sse.ts"

/**
 * Longest the start is held: refusals arrive at once, and a slow first
 * token should not wait on this.
 */
const WAIT = Duration.seconds(3)
/** Most held back before giving up and streaming. */
const LIMIT = 256 * 1024

const NEWLINE = 0x0a

export type Start<E> =
  /** Stream this (the held start, then the rest). */
  | { readonly _tag: "Streaming"; readonly body: Stream.Stream<Uint8Array, E> }
  /** The stream opened with a refusal; these are the bytes received. */
  | { readonly _tag: "Refused"; readonly exhausted: boolean; readonly held: Uint8Array }

type Chunks = Arr.NonEmptyReadonlyArray<Uint8Array>

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let size = 0
  for (const chunk of chunks) size += chunk.length
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/**
 * Reads the start of `body` until it opens. The upstream body is read in
 * a scope of its own under the caller's: a refusal closes it at once; a
 * stream that goes on closes it when it ends (or with the caller's scope).
 */
export const hold = <E>(
  body: Stream.Stream<Uint8Array, E>,
  dialect: Dialect,
): Effect.Effect<Start<E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const pull = yield* Scope.provide(Stream.toPull(body), scope)
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(WAIT)
    const held: Array<Uint8Array> = []
    let size = 0
    const line = new Growable()
    // A read still under way when the wait ran out: interrupting it could
    // lose the chunk it is reading, so the stream picks it up instead.
    let pending: Fiber.Fiber<Chunks, E | Cause.Done> | undefined
    // How the body ended (or failed) while the start was held.
    let ended: Exit.Exit<Chunks, E | Cause.Done> | undefined

    const streaming = (): Start<E> => {
      const rest = Effect.suspend((): Effect.Effect<Chunks, E | Cause.Done> => {
        if (pending !== undefined) {
          const fiber = pending
          pending = undefined
          return Fiber.join(fiber)
        }
        if (ended !== undefined) {
          const exit = ended
          ended = undefined
          return exit
        }
        return pull
      })
      const replayed = Stream.concat(Stream.fromIterable(held), Stream.fromPull(Effect.succeed(rest)))
      return { _tag: "Streaming", body: Stream.ensuring(replayed, Scope.close(scope, Exit.void)) }
    }

    while (size < LIMIT) {
      const now = yield* Clock.currentTimeMillis
      const fiber = yield* Effect.forkIn(pull, scope)
      const waited = yield* Effect.timeoutOption(Fiber.await(fiber), Math.max(0, deadline - now))
      // Waited long enough, ended, or failed: let the stream say so.
      if (Option.isNone(waited)) {
        pending = fiber
        break
      }
      const exit = waited.value
      if (Exit.isFailure(exit)) {
        ended = exit
        break
      }
      const chunks = exit.value
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] ?? new Uint8Array(0)
        size += chunk.length
        held.push(chunk)
        let start = 0
        for (;;) {
          const newline = chunk.indexOf(NEWLINE, start)
          if (newline < 0) break
          line.push(chunk.subarray(start, newline))
          const event = eventOf(line.view())
          line.clear()
          start = newline + 1
          const opening = event === undefined ? Opening.Wait : Dialect.opening(dialect, event)
          if (opening._tag === "Content") {
            // What was read with this chunk goes out with it.
            for (let j = i + 1; j < chunks.length; j++) held.push(chunks[j] ?? new Uint8Array(0))
            return streaming()
          }
          if (opening._tag === "Refused") {
            yield* Scope.close(scope, Exit.void)
            return { _tag: "Refused", exhausted: opening.exhausted, held: concat(held) }
          }
        }
        line.push(chunk.subarray(start))
      }
    }
    return streaming()
  })

/** The JSON of an SSE `data:` line. */
const eventOf = (line: Uint8Array): json.Json | undefined => {
  const data = dataOf(line)
  return data === undefined ? undefined : json.parse(json.trimAscii(data))
}
