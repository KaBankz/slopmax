// Re-encoding an upstream answer for a client that speaks another format,
// as it streams.
//
// Lines of the upstream's event stream are read as answer events, which
// the client's encoder writes out at once. An upstream that answered with
// one JSON document is read whole at the end. If the upstream breaks off,
// the client hears a failure in its own format instead of a cut stream.
import { Stream } from "effect"

import type { ir, translate } from "@slopmax/wire"

import { dataOf, Growable } from "./sse.ts"

/** Longest line or JSON body buffered. */
const MAX_BUFFER = 64 * 1024 * 1024

const NEWLINE = 0x0a
const RETURN = 0x0d

const utf8 = new TextEncoder()

/** Sees every event before the client does. */
export type Watch = (event: ir.Event) => void

/** A line without one trailing `\r`. */
const stripReturn = (line: Uint8Array): Uint8Array =>
  line.length > 0 && line[line.length - 1] === RETURN ? line.subarray(0, line.length - 1) : line

class Transcode {
  private readonly buffer = new Growable()

  constructor(
    /** The upstream answered with one JSON document rather than events. */
    private readonly json: boolean,
    private readonly decoder: translate.Decoder,
    private readonly encoder: translate.Encoder,
    private readonly watch: Watch,
  ) {}

  private write(events: ReadonlyArray<ir.Event>): string {
    let out = ""
    for (const event of events) {
      this.watch(event)
      out += this.encoder.event(event)
    }
    return out
  }

  /** What the client gets for one upstream chunk (often nothing yet). */
  feed(chunk: Uint8Array): string {
    if (this.buffer.length + chunk.length > MAX_BUFFER) {
      // Too much to hold: let the end of the stream report it.
      return ""
    }
    if (this.json) {
      this.buffer.push(chunk)
      return ""
    }
    const events: Array<ir.Event> = []
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start)
      if (newline < 0) break
      if (this.buffer.length === 0) {
        this.line(chunk.subarray(start, newline), events)
      } else {
        this.buffer.push(chunk.subarray(start, newline))
        this.line(this.buffer.view(), events)
        this.buffer.clear()
      }
      start = newline + 1
    }
    this.buffer.push(chunk.subarray(start))
    return this.write(events)
  }

  private line(line: Uint8Array, events: Array<ir.Event>): void {
    const data = dataOf(stripReturn(line))
    if (data !== undefined) this.decoder.data(data, events)
  }

  /** What the client gets once the upstream ends or breaks off. */
  end(): string {
    const events: Array<ir.Event> = []
    const rest = this.buffer.take()
    if (this.json) {
      this.decoder.whole(rest, events)
    } else {
      this.line(rest, events)
      this.decoder.finish(events)
    }
    return this.write(events)
  }
}

/**
 * `inner` (the upstream's answer) re-encoded for the client as it streams.
 * A broken upstream ends the answer like a cut stream.
 */
export const transcode = <E, R>(
  inner: Stream.Stream<Uint8Array, E, R>,
  json: boolean,
  decoder: translate.Decoder,
  encoder: translate.Encoder,
  watch: Watch,
): Stream.Stream<Uint8Array, never, R> =>
  Stream.suspend(() => {
    const coder = new Transcode(json, decoder, encoder, watch)
    const body = inner.pipe(
      Stream.ignore,
      Stream.map((chunk) => coder.feed(chunk)),
      Stream.filter((out) => out.length > 0),
    )
    const end = Stream.suspend(() => {
      const out = coder.end()
      return out.length > 0 ? Stream.succeed(out) : Stream.empty
    })
    return Stream.map(Stream.concat(body, end), (out) => utf8.encode(out))
  })

/** Every event of a whole upstream body, each shown to `watch` first. */
export const events = (decoder: translate.Decoder, json: boolean, body: Uint8Array, watch: Watch): Array<ir.Event> => {
  const out: Array<ir.Event> = []
  if (json) {
    decoder.whole(body, out)
  } else {
    let start = 0
    for (;;) {
      const newline = body.indexOf(NEWLINE, start)
      const end = newline < 0 ? body.length : newline
      const data = dataOf(stripReturn(body.subarray(start, end)))
      if (data !== undefined) decoder.data(data, out)
      if (newline < 0) break
      start = newline + 1
    }
    decoder.finish(out)
  }
  for (const event of out) watch(event)
  return out
}

interface Remembered {
  readonly account: string
  readonly state: string
  readonly at: number
}

/**
 * Reasoning state upstreams issued alongside tool calls, kept for the
 * next turn when the client's format cannot carry it back. Keyed by the
 * call it preceded, and only replayed to the account that issued it.
 */
export class Replay {
  /** Entries kept at most; the oldest go first. */
  static readonly MAX = 4096
  /** How long state stays useful: a turn's tool loop, with room to spare. */
  static readonly TTL = 2 * 3600 * 1000

  // A Map keeps its keys in insertion order, and setting a key it has keeps
  // its place, so its first key is always the oldest.
  private readonly entries = new Map<string, Remembered>()

  get size(): number {
    return this.entries.size
  }

  /** `now` is the clock's time in milliseconds. */
  remember(call: string, account: string, state: string, now: number): void {
    if (this.entries.size >= Replay.MAX) {
      const oldest = this.entries.keys().next()
      if (oldest.done !== true) this.entries.delete(oldest.value)
    }
    this.entries.set(call, { account, state, at: now })
  }

  recall(call: string, account: string, now: number): string | undefined {
    const entry = this.entries.get(call)
    if (entry === undefined) return undefined
    return entry.account === account && now - entry.at < Replay.TTL ? entry.state : undefined
  }
}
