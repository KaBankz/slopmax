// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { describe, expect } from "bun:test"
import { Buffer } from "node:buffer"
import { it } from "@slopmax/test"
import { Effect } from "effect"

import {
  acceptKey,
  type ByteSink,
  type ByteSource,
  frame,
  MAX_MESSAGE,
  Message,
  newKey,
  Reader,
  Writer,
} from "../src/ws.ts"

// Bytes to read, handed out in chunks of `step`.
const source = (bytes: Uint8Array, step = bytes.length || 1): ByteSource<never> => {
  let at = 0
  return {
    read: Effect.sync(() => {
      if (at >= bytes.length) return undefined
      const chunk = bytes.subarray(at, at + step)
      at += step
      return chunk
    }),
  }
}

// Collects what is written.
const sink = (): ByteSink<never> & { readonly bytes: () => Uint8Array } => {
  const chunks: Array<Uint8Array> = []
  return {
    write: (bytes) => Effect.sync(() => void chunks.push(bytes)),
    bytes: () => Buffer.concat(chunks),
  }
}

const text = (t: string): Uint8Array => new TextEncoder().encode(t)

// A frame head with a 64-bit length.
const head = (first: number, n: number): Uint8Array =>
  Uint8Array.of(first, 0x7f, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)

describe("ws", () => {
  it("accept_key_matches_the_rfc", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    expect(Buffer.from(newKey(), "base64").length).toBe(16)
    expect(acceptKey("  dGhlIHNhbXBsZSBub25jZQ== ")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  })

  it.effect("reads_the_rfcs_frames", () =>
    Effect.gen(function* () {
      // RFC 6455 5.7: an unmasked and a masked "Hello", then a fragmented
      // "Hello" with a ping between its fragments.
      const bytes = Buffer.concat([
        Uint8Array.of(0x81, 0x05, ...text("Hello")),
        Uint8Array.of(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58),
        Uint8Array.of(0x01, 0x03, ...text("Hel")),
        Uint8Array.of(0x89, 0x00),
        Uint8Array.of(0x80, 0x02, ...text("lo")),
      ])
      for (const step of [bytes.length, 1, 3]) {
        const reader = new Reader(source(bytes, step))
        for (const expected of [Message.text("Hello"), Message.text("Hello"), Message.ping(), Message.text("Hello")]) {
          expect(yield* reader.message).toEqual(expected)
        }
        expect(yield* reader.message).toBeUndefined()
      }
    }),
  )

  it.effect("round_trips_every_size_masked_or_not", () =>
    Effect.gen(function* () {
      for (const masked of [false, true]) {
        for (const len of [0, 125, 126, 65_535, 65_536, 200_000]) {
          const body = "x".repeat(len)
          const wire = sink()
          const writer = masked ? Writer.client(wire) : Writer.server(wire)
          yield* writer.send(Message.text(body))
          yield* writer.send(Message.close(1000, "bye"))
          const bytes = wire.bytes()
          expect(((bytes[1] ?? 0) & 0x80) !== 0).toBe(masked)
          const reader = new Reader(source(bytes, 4096))
          expect(yield* reader.message).toEqual(Message.text(body))
          expect(yield* reader.message).toEqual(Message.close(1000, "bye"))
        }
      }
    }),
  )

  it.effect("rejects_broken_frames", () =>
    Effect.gen(function* () {
      // Reserved bits, a long control frame, and a stray continuation.
      for (const bytes of [
        Uint8Array.of(0xc1, 0x00),
        Uint8Array.of(0x89, 0x7e, 0x00, 0x80),
        Uint8Array.of(0x80, 0x00),
      ]) {
        const error = yield* Effect.flip(new Reader(source(bytes)).message)
        expect(error._tag).toBe("WsError")
      }
    }),
  )

  it.effect("every broken frame gets its own error", () =>
    Effect.gen(function* () {
      const cases: Array<[Uint8Array, string]> = [
        [Uint8Array.of(0xc1, 0x00), "reserved bits set without an extension"],
        [Uint8Array.of(0x89, 0x7e, 0x00, 0x80), "control frames are short and whole"],
        [Uint8Array.of(0x09, 0x00), "control frames are short and whole"],
        [Uint8Array.of(0x80, 0x00), "a continuation frame without a message"],
        [Uint8Array.of(0x01, 0x01, 0x61, 0x81, 0x01, 0x62), "a new message began inside a fragmented one"],
        [Uint8Array.of(0x83, 0x00), "unknown opcode"],
        [Uint8Array.of(0x81, 0x02, 0xc3, 0x28), "a text message that is not UTF-8"],
        [Uint8Array.of(0x82, 0x7f, 0, 0, 0, 0, 4, 0, 0, 1), "message too large"],
        // The end inside a 16- or 64-bit length reads as tokio's `read_u16`
        // says it; inside a key or payload, as its `read_exact` does.
        [Uint8Array.of(0x81, 0x05, 0x61), "early eof"],
        [Uint8Array.of(0x81, 0x85, 0x01, 0x02), "early eof"],
        [Uint8Array.of(0x81, 0x7e, 0x00), "unexpected end of file"],
        [Uint8Array.of(0x81, 0x7f, 0, 0, 0), "unexpected end of file"],
      ]
      for (const [bytes, reason] of cases) {
        const error = yield* Effect.flip(new Reader(source(bytes)).message)
        expect(error.message).toBe(reason)
      }
      expect(MAX_MESSAGE).toBe(64 * 1024 * 1024)
    }),
  )

  it.effect("an end of stream inside a frame's first two bytes ends the stream, as between frames", () =>
    Effect.gen(function* () {
      expect(yield* new Reader(source(Uint8Array.of(0x81))).message).toBeUndefined()
      expect(yield* new Reader(source(new Uint8Array())).message).toBeUndefined()
    }),
  )

  it.effect("frames split anywhere read the same, and reading leaves the source's bytes alone", () =>
    Effect.gen(function* () {
      const wire = sink()
      const writer = Writer.client(wire)
      const sent = [Message.text("a".repeat(300)), Message.binary(new Uint8Array(70_000).fill(7)), Message.ping()]
      for (const message of sent) yield* writer.send(message)
      const bytes = wire.bytes()
      const before = Buffer.from(bytes)
      for (const step of [1, 7, 4096, bytes.length]) {
        const reader = new Reader(source(bytes, step))
        for (const message of sent) expect(yield* reader.message).toEqual(message)
        expect(yield* reader.message).toBeUndefined()
      }
      expect(Buffer.from(bytes).equals(before)).toBe(true)
    }),
  )

  it.effect("fragments past 64 MiB in all are refused", () =>
    Effect.gen(function* () {
      const half = MAX_MESSAGE / 2
      const zeros = new Uint8Array(half)
      const bytes = Buffer.concat([head(0x02, half), zeros, head(0x00, half), zeros, head(0x80, 1), Uint8Array.of(0)])
      const error = yield* Effect.flip(new Reader(source(bytes, 1 << 20)).message)
      expect(error.message).toBe("message too large")
    }),
  )

  it.effect("closes carry their code and a lossy reason; short ones are bare", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.of(0x88, 0x04, 0x03, 0xe8, 0x61, 0xff, 0x88, 0x01, 0x03, 0x88, 0x00)
      const reader = new Reader(source(bytes))
      expect(yield* reader.message).toEqual(Message.close(1000, "a�"))
      expect(yield* reader.message).toEqual(Message.closeBare)
      expect(yield* reader.message).toEqual(Message.closeBare)
      expect(yield* reader.message).toBeUndefined()
    }),
  )

  it("writes one final frame per message, with 7-, 16-, or 64-bit lengths and close reasons cut to 123 bytes", () => {
    expect([...frame(Message.binary(Uint8Array.of(1, 2)), false)]).toEqual([0x82, 0x02, 1, 2])
    expect([...frame(Message.pong(), false)]).toEqual([0x8a, 0x00])
    expect([...frame(Message.closeBare, false)]).toEqual([0x88, 0x00])
    expect([...frame(Message.text("x".repeat(126)), false).subarray(0, 4)]).toEqual([0x81, 126, 0, 126])
    expect([...frame(Message.text("x".repeat(65_536)), false).subarray(0, 10)]).toEqual([
      0x81, 127, 0, 0, 0, 0, 0, 1, 0, 0,
    ])
    const close = frame(Message.close(1011, "y".repeat(200)), false)
    expect(close[1]).toBe(125)
    // A client picks a fresh key for every frame.
    const a = frame(Message.text("same"), true)
    const b = frame(Message.text("same"), true)
    expect(a.length).toBe(10)
    expect(
      Buffer.from(a.subarray(2, 6)).equals(Buffer.from(b.subarray(2, 6))) && Buffer.from(a).equals(Buffer.from(b)),
    ).toBe(false)
  })
})
