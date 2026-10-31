// Server-sent event lines, in and out.
//
// The proxy watches every answer stream for the few events that matter to it
// (token usage, a refusal), while the bytes go on to the client untouched.
// That watching splits the stream on newlines as it passes, keeping only a
// line cut between two chunks, and reads a `data:` line's JSON only when the
// caller asks for it. The other way, translated answers are written as SSE
// frames.

/** Longest line kept across chunks. Longer lines are passed over unread; no event slopmax reads is near this long. */
export const maxLine = 16 * 1024 * 1024

/**
 * Handed each complete line: the bytes holding it, and where it starts and
 * ends (the newline excluded). The bytes are only valid during the call.
 * Returning true stops the splitting there.
 */
export type Visit = (bytes: Uint8Array, start: number, end: number) => boolean

const NEWLINE = 0x0a

/**
 * Splits a byte stream into lines as its chunks arrive. A line inside one
 * chunk is handed over in place; only a line cut between chunks is copied,
 * into a buffer that is reused for the next one.
 */
export class Lines {
  private carry = new Uint8Array(0)
  private carried = 0
  /** Inside a line longer than `max`: everything up to the next newline is dropped. */
  private skipping = false

  constructor(readonly max: number = maxLine) {}

  /**
   * Hands `visit` every line this chunk completes. True when `visit` stopped
   * it; the rest of the chunk is then left unread, and a caller that stops
   * pushes no more.
   */
  push(chunk: Uint8Array, visit: Visit): boolean {
    let from = 0
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, from)
      if (newline < 0) break
      if (this.skipping) {
        this.skipping = false
      } else if (this.carried === 0) {
        if (newline - from <= this.max && visit(chunk, from, newline)) return true
      } else if (this.carried + newline - from <= this.max) {
        this.keep(chunk, from, newline)
        const length = this.carried
        this.carried = 0
        if (visit(this.carry, 0, length)) return true
      } else {
        this.carried = 0
      }
      from = newline + 1
    }
    if (from < chunk.length && !this.skipping) {
      if (this.carried + chunk.length - from > this.max) {
        this.carried = 0
        this.skipping = true
      } else {
        this.keep(chunk, from, chunk.length)
      }
    }
    return false
  }

  /** Hands `visit` the last line, when the stream ended without a newline after it. */
  end(visit: Visit): boolean {
    const length = this.skipping ? 0 : this.carried
    this.carried = 0
    this.skipping = false
    return length > 0 && visit(this.carry, 0, length)
  }

  private keep(chunk: Uint8Array, from: number, to: number): void {
    const needed = this.carried + (to - from)
    if (needed > this.carry.length) {
      const grown = new Uint8Array(Math.max(needed, this.carry.length * 2, 1024))
      grown.set(this.carry.subarray(0, this.carried))
      this.carry = grown
    }
    this.carry.set(chunk.subarray(from, to), this.carried)
    this.carried = needed
  }
}

/** Where a `data:` line's payload starts, or -1 when the line is something else (`event:`, a comment, a blank). */
export const dataStart = (bytes: Uint8Array, start: number, end: number): number =>
  end - start >= 5 &&
  bytes[start] === 0x64 &&
  bytes[start + 1] === 0x61 &&
  bytes[start + 2] === 0x74 &&
  bytes[start + 3] === 0x61 &&
  bytes[start + 4] === 0x3a
    ? start + 5
    : -1

const text = new TextDecoder()

/** The JSON value in `source`, or undefined when it holds none. */
export const parseText = (source: string): unknown => {
  try {
    const value: unknown = JSON.parse(source)
    return value
  } catch {
    return undefined
  }
}

/** The JSON value in the bytes from `start` to `end` (whitespace around it allowed); undefined when they hold none. */
export const parseJson = (bytes: Uint8Array, start: number, end: number): unknown =>
  start >= end ? undefined : parseText(text.decode(bytes.subarray(start, end)))

/** The JSON of a `data:` line, or undefined when the line is not one or does not hold JSON. */
export const dataJson = (bytes: Uint8Array, start: number, end: number): unknown => {
  const data = dataStart(bytes, start, end)
  return data < 0 ? undefined : parseJson(bytes, data, end)
}

/**
 * One server-sent event: `event: <name>` when it is named, then the data as
 * compact JSON, then a blank line. These are the bytes `effect/encoding`'s
 * `Sse.encoder` writes for the same event (it leaves out SSE's default name
 * `message`, which no format slopmax writes uses), without its pass that
 * splits data on newlines: compact JSON never holds a raw newline, and a
 * translated answer writes one frame for every piece of text it streams.
 */
export const frame = (event: string | undefined, data: unknown): string =>
  event === undefined ? `data: ${JSON.stringify(data)}\n\n` : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
