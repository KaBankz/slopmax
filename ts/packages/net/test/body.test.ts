import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

import { empty, full, idleTimeout, LengthLimitError, prefixed, read, readAll } from "../src/body.ts"

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("body", () => {
  it.effect("reads_within_the_limit", () =>
    Effect.gen(function* () {
      expect(text(yield* read(full("hello"), 5))).toBe("hello")
      const error = yield* Effect.flip(read(full("hello"), 4))
      expect(error).toBeInstanceOf(LengthLimitError)
    }),
  )

  it.effect("stalled_bodies_fail", () =>
    Effect.gen(function* () {
      const body = idleTimeout(Stream.never, "100 millis")
      const fiber = yield* Effect.forkChild(Effect.flip(read(body, 10)))
      yield* TestClock.adjust("100 millis")
      const error = yield* Fiber.join(fiber)
      expect(error.message).toBe("no data for 100ms")
    }),
  )

  it.effect("the idle wait restarts with every chunk", () =>
    Effect.gen(function* () {
      const chunks = Stream.make("a", "b", "c").pipe(
        Stream.mapEffect((c) => Effect.as(Effect.sleep("80 millis"), new TextEncoder().encode(c))),
      )
      const fiber = yield* Effect.forkChild(read(idleTimeout(chunks, "100 millis"), 10))
      yield* TestClock.adjust("80 millis")
      yield* TestClock.adjust("80 millis")
      yield* TestClock.adjust("80 millis")
      expect(text(yield* Fiber.join(fiber))).toBe("abc")
    }),
  )

  it.effect("read_all fails past its limit with the size in the message", () =>
    Effect.gen(function* () {
      expect(text(yield* readAll(Stream.make(new Uint8Array([104, 105])), 2))).toBe("hi")
      const error = yield* Effect.flip(readAll(Stream.make(new Uint8Array(3), new Uint8Array(1)), 3))
      expect(error.message).toBe("body exceeds 3 bytes")
      expect(new LengthLimitError({ limit: 1 }).message).toBe("length limit exceeded")
    }),
  )

  it.effect("a prefixed body yields its held chunks first", () =>
    Effect.gen(function* () {
      const body = prefixed([new TextEncoder().encode("ab"), new TextEncoder().encode("c")], full("de"))
      expect(text(yield* read(body, 100))).toBe("abcde")
      expect((yield* read(empty, 0)).length).toBe(0)
    }),
  )
})
