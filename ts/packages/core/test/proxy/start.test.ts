// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

import { body } from "@slopmax/net"

import { hold } from "../../src/proxy/start.ts"

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const read = <E>(stream: Stream.Stream<Uint8Array, E>) => Effect.map(body.read(stream, Number.MAX_SAFE_INTEGER), decode)

describe("proxy/start", () => {
  it.effect("content_streams_with_the_held_start_replayed", () =>
    Effect.gen(function* () {
      const stream =
        'data: {"type":"response.created"}\n\ndata: {"type":"response.output_item.added"}\n\ndata: {"type":"response.completed"}\n\n'
      const start = yield* hold(body.full(stream), "responses")
      if (start._tag !== "Streaming") throw new Error("content is not a refusal")
      expect(yield* read(start.body)).toBe(stream)
    }),
  )

  it.effect("a_spent_quota_is_caught_before_the_agent_sees_it", () =>
    Effect.gen(function* () {
      const stream =
        'data: {"type":"response.created"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n'
      const start = yield* hold(body.full(stream), "responses")
      if (start._tag !== "Refused") throw new Error("should be refused")
      expect(start.exhausted).toBe(true)
      expect(decode(start.held)).toBe(stream)
    }),
  )

  it.effect("request_failures_go_to_the_agent", () =>
    Effect.gen(function* () {
      const stream = 'data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}\n\n'
      const start = yield* hold(body.full(stream), "responses")
      expect(start._tag).toBe("Streaming")
    }),
  )
})

describe("proxy/start, beyond the Rust tests", () => {
  it.effect("a slow start streams after 3 s, the chunk being read included", () =>
    Effect.gen(function* () {
      const created = 'data: {"type":"response.created"}\n\n'
      const later = 'data: {"type":"response.completed"}\n\n'
      const slow = Stream.concat(
        Stream.make(new TextEncoder().encode(created)),
        Stream.fromEffect(Effect.as(Effect.sleep("5 seconds"), new TextEncoder().encode(later))),
      )
      const fiber = yield* Effect.forkChild(hold(slow, "responses"))
      yield* Effect.yieldNow
      yield* TestClock.adjust("3 seconds")
      const start = yield* Fiber.join(fiber)
      if (start._tag !== "Streaming") throw new Error("a slow start is no refusal")
      const reading = yield* Effect.forkChild(read(start.body))
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      expect(yield* Fiber.join(reading)).toBe(created + later)
    }),
  )

  it.effect("throttling inside the stream is a refusal, not exhaustion; an ended start streams what it held", () =>
    Effect.gen(function* () {
      const busy =
        'data: {"type":"response.created"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n'
      const refused = yield* hold(body.full(busy), "responses")
      expect(refused._tag === "Refused" && !refused.exhausted).toBe(true)
      const short = 'data: {"type":"response.created"}\n\n'
      const ended = yield* hold(body.full(short), "responses")
      if (ended._tag !== "Streaming") throw new Error("an ended start streams")
      expect(yield* read(ended.body)).toBe(short)
    }),
  )
})
