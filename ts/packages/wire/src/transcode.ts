// Telling an upstream's answer to a client that speaks another format, as it
// streams.
//
// The upstream's server-sent events are read into answer events, which the
// client's writer turns into its own frames at once, so the client sees the
// answer as fast as the upstream gives it. An upstream that answered with one
// JSON document is read whole when it ends. If the upstream breaks off, the
// client hears a failure in its own format instead of a cut stream.
//
// A `Transcoder` is a plain state machine over bytes: the proxy's relay feeds
// it each upstream chunk and sends on whatever it returns.
import type { Dialect } from "@slopmax/domain"
import { Sse } from "effect/encoding"
import {
  type AnswerReader,
  type AnswerWriter,
  Event,
  type ReplyContext,
  type Request,
  type UpstreamDialect,
} from "./common.ts"
import { formats } from "./format.ts"
import { parseText } from "./lines.ts"
import type { HeaderLookup } from "./tap.ts"

/** Most of an answer held at once: one pending event, or a whole JSON answer. Past it the answer fails at once. */
export const maxHeld = 64 * 1024 * 1024

const tooLarge = Event.Failed({ failure: { status: 502, message: "the upstream answer was larger than 64 MiB" } })

/** Whether an answer with these response headers came as one JSON document rather than as events. */
export const isDocument = (headers: HeaderLookup): boolean => headers.get("content-type")?.includes("json") === true

/**
 * Reads an upstream body into answer events, chunk by chunk: event data goes
 * to the format's reader as it completes; a JSON document is kept and read at
 * the end. Whatever the body, the end finishes the answer.
 */
class AnswerBody {
  private readonly text = new TextDecoder()
  private readonly parser: Sse.Parser
  private readonly kept: Array<Uint8Array> = []
  private keptBytes = 0
  private overflowed = false
  /** Where the parser's events go during one `push` or `end`. */
  private out: Array<Event> = []

  constructor(
    private readonly reader: AnswerReader,
    private readonly document: boolean,
  ) {
    this.parser = Sse.makeParser(this.parsed, { maxEventSize: maxHeld })
  }

  push(chunk: Uint8Array, out: Array<Event>): void {
    if (this.overflowed) return
    if (this.document) {
      this.keptBytes += chunk.length
      if (this.keptBytes > maxHeld) this.overflow(out)
      else this.kept.push(chunk)
      return
    }
    this.out = out
    if (this.parser.feed(this.text.decode(chunk, { stream: true })) !== undefined) this.overflow(out)
  }

  end(out: Array<Event>): void {
    if (this.overflowed) return
    if (this.document) {
      const body = parse(this.text.decode(concat(this.kept, this.keptBytes)))
      this.kept.length = 0
      if (body === undefined) this.reader.finish(out)
      else this.reader.document(body, out)
      return
    }
    this.out = out
    // The last event may lack its blank line, or even its newline.
    this.parser.feed(`${this.text.decode()}\n\n`)
    this.reader.finish(out)
  }

  /**
   * An event or document too large to hold. Dropping only that piece would
   * hand the client an answer with a hole in it (half a tool call's
   * arguments, say) that it would take as whole, so the answer fails here
   * and the rest of the body is let go.
   */
  private overflow(out: Array<Event>): void {
    this.overflowed = true
    this.kept.length = 0
    this.parser.reset()
    if (!this.reader.done) out.push(tooLarge)
  }

  private readonly parsed = (event: Sse.AnyEvent): void => {
    if (event._tag !== "Event") return
    const data = event.data.trim()
    if (data === "[DONE]") {
      this.reader.finish(this.out)
      return
    }
    const value = parse(data)
    if (value !== undefined) {
      this.reader.event(value, this.out)
      return
    }
    // A server that leaves out the blank lines runs several events' data into one: read each line on its own.
    if (!data.includes("\n")) return
    for (const line of data.split("\n")) {
      const one = line.trim()
      if (one === "[DONE]") this.reader.finish(this.out)
      else {
        const lineValue = parse(one)
        if (lineValue !== undefined) this.reader.event(lineValue, this.out)
      }
    }
  }
}

const parse = (text: string): unknown => (text.length === 0 ? undefined : parseText(text))

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  const whole = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.length
  }
  return whole
}

/** What a translated answer needs: the request it answers, how to write the reply, and how the upstream sent it. */
export interface TranscodeOptions {
  readonly request: Request
  readonly context: ReplyContext
  /** The upstream answered with one JSON document rather than an event stream (`isDocument`). */
  readonly document: boolean
  /** Sees every event before the client does: the proxy remembers reasoning state with it. */
  readonly watch?: (event: Event) => void
}

const encoder = new TextEncoder()

/**
 * Re-tells one upstream answer in the client's format. `push` takes each
 * upstream chunk and `end` the end of the body (however it ended); each
 * returns the bytes to send the client, or nothing when there are none yet.
 */
export class Transcoder {
  private readonly body: AnswerBody
  private readonly writer: AnswerWriter
  private readonly watch: ((event: Event) => void) | undefined
  private ended = false

  constructor(reader: AnswerReader, writer: AnswerWriter, options: Pick<TranscodeOptions, "document" | "watch">) {
    this.body = new AnswerBody(reader, options.document)
    this.writer = writer
    this.watch = options.watch
  }

  push(chunk: Uint8Array): ReadonlyArray<Uint8Array> {
    if (this.ended) return []
    const events: Array<Event> = []
    this.body.push(chunk, events)
    return this.write(events)
  }

  end(): ReadonlyArray<Uint8Array> {
    if (this.ended) return []
    this.ended = true
    const events: Array<Event> = []
    this.body.end(events)
    return this.write(events)
  }

  private write(events: ReadonlyArray<Event>): ReadonlyArray<Uint8Array> {
    if (events.length === 0) return []
    let out = ""
    for (const event of events) {
      this.watch?.(event)
      out += this.writer.write(event)
    }
    return out.length === 0 ? [] : [encoder.encode(out)]
  }
}

/** A transcoder for an answer from an upstream speaking `from` to a client speaking `to`. */
export const transcoder = (from: UpstreamDialect, to: Dialect, options: TranscodeOptions): Transcoder =>
  new Transcoder(
    formats[from].reader(options.request, options.context.token),
    formats[to].writer(options.request, options.context),
    options,
  )

/**
 * Every event of a whole upstream body (a client that asked for one answer,
 * or a warmup), each shown to `watch` first. The body is read by the same
 * rules as a stream, then finished.
 */
export const readAnswer = (
  from: UpstreamDialect,
  body: Uint8Array,
  options: Pick<TranscodeOptions, "request" | "document" | "watch"> & { readonly token: () => string },
): ReadonlyArray<Event> => {
  const reading = new AnswerBody(formats[from].reader(options.request, options.token), options.document)
  const events: Array<Event> = []
  reading.push(body, events)
  reading.end(events)
  if (options.watch !== undefined) for (const event of events) options.watch(event)
  return events
}
