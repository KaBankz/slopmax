// Watches streamed responses without altering them.
//
// Bytes pass straight through to the agent while a line parser hands each
// event to the dialect, which picks out token usage and refusals that
// arrive inside a 200 stream.
import { Buffer } from "node:buffer"

import { Clock, Effect, type Scope, Stream } from "effect"

import { Dialect, json, Outcome } from "@slopmax/wire"

import { header } from "./headers.ts"

/** Longest line the tap will buffer; longer lines pass through unparsed. */
const MAX_LINE = 16 * 1024 * 1024

const NEWLINE = 0x0a

/**
 * Bytes collected across chunks: a buffer that grows by doubling and is
 * reused once cleared, as a `Vec<u8>` is.
 */
export class Growable {
  private bytes: Uint8Array = new Uint8Array(0)
  length = 0

  push(chunk: Uint8Array): void {
    const needed = this.length + chunk.length
    if (needed > this.bytes.length) {
      const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2, 256))
      grown.set(this.bytes.subarray(0, this.length))
      this.bytes = grown
    }
    this.bytes.set(chunk, this.length)
    this.length = needed
  }

  /** The bytes so far, as a view that the next push or clear may overwrite. */
  view(): Uint8Array {
    return this.bytes.subarray(0, this.length)
  }

  /** The bytes so far, as a copy of their own, and the buffer emptied. */
  take(): Uint8Array {
    const out = this.bytes.slice(0, this.length)
    this.length = 0
    return out
  }

  clear(): void {
    this.length = 0
  }
}

/** `data:` */
const DATA = [0x64, 0x61, 0x74, 0x61, 0x3a] as const

/** The payload of an SSE `data:` line, or undefined for any other line. */
export const dataOf = (line: Uint8Array): Uint8Array | undefined => {
  if (line.length < 5) return undefined
  for (let i = 0; i < 5; i++) if (line[i] !== DATA[i]) return undefined
  return line.subarray(5)
}

// A view of `bytes` with Buffer's native substring search, without a copy.
const searchable = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// Encoded once: a string needle is encoded again on every search.
const USAGE = Buffer.from("usage")
const ERROR = Buffer.from("error")
const FAILED = Buffer.from("failed")

/** How a response body is read. */
type Shape =
  /** Server-sent events, read line by line. */
  | "Events"
  /** One JSON document, read whole at the end. */
  | "Json"
  /** Compressed: passed through unread; only the request counts. */
  | "Opaque"

export class Tap {
  private readonly line = new Growable()
  private overflow = false
  private readonly outcome: Outcome = Outcome.make()

  private constructor(
    private readonly dialect: Dialect,
    private readonly shape: Shape,
  ) {}

  /** A tap for an event stream. */
  static make(dialect: Dialect): Tap {
    return new Tap(dialect, "Events")
  }

  /**
   * A tap shaped by the response headers: compressed bodies pass through
   * unread, JSON bodies are read whole, anything else as events.
   */
  static forResponse(dialect: Dialect, headers: Headers): Tap {
    const encoding = header(headers, "content-encoding")
    const shape: Shape =
      encoding !== undefined && encoding !== "identity"
        ? "Opaque"
        : header(headers, "content-type")?.includes("json") === true
          ? "Json"
          : "Events"
    return new Tap(dialect, shape)
  }

  feed(chunk: Uint8Array): void {
    switch (this.shape) {
      case "Opaque":
        return
      case "Json":
        if (this.line.length + chunk.length > MAX_LINE) this.overflow = true
        else if (!this.overflow) this.line.push(chunk)
        return
      case "Events":
        break
    }
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start)
      if (newline < 0) break
      if (!this.overflow) {
        if (this.line.length === 0) {
          // The whole line is in this chunk: read it in place.
          this.read(chunk.subarray(start, newline))
        } else {
          this.line.push(chunk.subarray(start, newline))
          this.read(this.line.view())
          // Keep the buffer for the next split line.
          this.line.clear()
        }
      }
      this.overflow = false
      start = newline + 1
    }
    const rest = chunk.subarray(start)
    if (this.line.length + rest.length > MAX_LINE) {
      this.overflow = true
      this.line.clear()
    } else if (!this.overflow) {
      this.line.push(rest)
    }
  }

  finish(): Outcome {
    const line = this.line.take()
    switch (this.shape) {
      case "Events":
        this.read(line)
        break
      case "Json":
        if (!this.overflow) {
          const body = json.parse(line)
          if (body !== undefined) Dialect.observe(this.dialect, body, this.outcome)
        }
        break
      case "Opaque":
        break
    }
    this.outcome.usage = { ...this.outcome.usage, requests: 1 }
    return this.outcome
  }

  private read(line: Uint8Array): void {
    const data = dataOf(line)
    if (data === undefined) return
    const text = searchable(data)
    const interesting = text.includes(USAGE) || text.includes(ERROR) || text.includes(FAILED)
    if (!interesting) return
    const event = json.parse(json.trimAscii(data))
    if (event === undefined) return
    Dialect.observe(this.dialect, event, this.outcome)
  }
}

/**
 * The body as it came, reporting its `Outcome` once, when it ends, fails,
 * or is dropped early (the agent disconnected), with the clock's time when
 * its first chunk went out. The report is also tied to the scope, so a body
 * that is never read at all reports when the scope closes.
 */
export const tapped = <E, R>(
  inner: Stream.Stream<Uint8Array, E, R>,
  tap: Tap,
  done: (outcome: Outcome, firstByte: number | undefined) => Effect.Effect<void>,
): Effect.Effect<Stream.Stream<Uint8Array, E, R>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    let firstByte: number | undefined
    let reported = false
    const report = Effect.suspend(() => {
      if (reported) return Effect.void
      reported = true
      return done(tap.finish(), firstByte)
    })
    yield* Effect.addFinalizer(() => report)
    return inner.pipe(
      Stream.mapArray((chunks) => {
        if (firstByte === undefined) firstByte = clock.currentTimeMillisUnsafe()
        for (const chunk of chunks) tap.feed(chunk)
        return chunks
      }),
      Stream.onExit(() => report),
    )
  })
