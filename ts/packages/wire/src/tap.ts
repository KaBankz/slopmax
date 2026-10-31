// Watching an answer on its way to the client.
//
// Every answer the proxy relays passes through a tap: the bytes go on
// untouched, while the tap picks out the token usage and any refusal inside
// the stream. When the answer ends, is cut, or the client hangs up, the tap's
// outcome settles the request: the pool counts it and the ledger records it.
//
// The tap is a small state machine over bytes, and cheap on purpose: it splits
// lines in place and parses only the `data:` lines that mention usage or an
// error, which are a handful per answer.
import type { Dialect } from "@slopmax/domain"
import { dataStart, Lines, maxLine, parseJson, parseText } from "./lines.ts"
import { observers, TapOutcome, type Observer } from "./observe.ts"

/**
 * How an answer's body is read, from its headers:
 * - `opaque`: compressed, so nothing is read and only the request counts;
 * - `document`: one JSON answer, kept (up to 16 MiB) and read when it ends;
 * - `events`: server-sent events, read line by line.
 */
export type TapShape = "opaque" | "document" | "events"

/** The part of `Headers` a tap reads. */
export interface HeaderLookup {
  readonly get: (name: string) => string | null
}

/** The shape of the answer whose response headers these are. */
export const shapeOf = (headers: HeaderLookup): TapShape => {
  const encoding = headers.get("content-encoding")
  if (encoding !== null && encoding !== "identity") return "opaque"
  return headers.get("content-type")?.includes("json") === true ? "document" : "events"
}

/** Largest whole JSON answer the tap keeps to read at the end; a larger one only counts as a request. */
export const maxDocument = 16 * 1024 * 1024

/**
 * Watches one answer. `chunk` reads each piece on its way to the client,
 * never changing or keeping the bytes it is given; `finish` reads what is
 * left and gives the outcome. The first `finish` decides: later calls return
 * the same outcome, and chunks after it are ignored.
 */
export class Tap {
  private readonly observe: Observer
  private readonly lines: Lines | undefined
  private outcome = TapOutcome.empty
  private finished: TapOutcome | undefined
  /** A document's text so far, decoded as it arrives. */
  private document: Array<string> = []
  private documentBytes = 0
  private readonly decoder: TextDecoder | undefined

  constructor(
    readonly dialect: Dialect,
    readonly shape: TapShape = "events",
  ) {
    this.observe = observers[dialect]
    this.lines = shape === "events" ? new Lines(maxLine) : undefined
    this.decoder = shape === "document" ? new TextDecoder() : undefined
  }

  /** A tap for the answer with these response headers. */
  static forResponse(dialect: Dialect, headers: HeaderLookup): Tap {
    return new Tap(dialect, shapeOf(headers))
  }

  /** Reads one chunk of the answer. */
  chunk(bytes: Uint8Array): void {
    if (this.finished !== undefined) return
    if (this.lines !== undefined) {
      this.lines.push(bytes, this.line)
    } else if (this.decoder !== undefined && this.documentBytes <= maxDocument) {
      this.documentBytes += bytes.length
      if (this.documentBytes > maxDocument) this.document = []
      else this.document.push(this.decoder.decode(bytes, { stream: true }))
    }
  }

  /** The answer's outcome: the last line (or the whole document) read, and the request counted. */
  finish(): TapOutcome {
    if (this.finished !== undefined) return this.finished
    if (this.lines !== undefined) {
      this.lines.end(this.line)
    } else if (this.decoder !== undefined && this.documentBytes <= maxDocument) {
      this.document.push(this.decoder.decode())
      const value = parseText(this.document.join(""))
      if (value !== undefined) this.outcome = this.observe(this.outcome, value)
      this.document = []
    }
    this.finished = this.outcome.counted()
    return this.finished
  }

  /** Only `data:` lines worth reading can change the outcome, so only they are parsed. */
  private readonly line = (bytes: Uint8Array, start: number, end: number): boolean => {
    const data = dataStart(bytes, start, end)
    if (data >= 0 && worthReading(bytes, data, end)) {
      const event = parseJson(bytes, data, end)
      if (event !== undefined) this.outcome = this.observe(this.outcome, event)
    }
    return false
  }
}

const QUOTE = 0x22
const COLON = 0x3a
const SPACE = 0x20

const spelled = (bytes: Uint8Array, at: number, word: ReadonlyArray<number>): boolean => {
  for (let k = 0; k < word.length; k++) if (bytes[at + k] !== word[k]) return false
  return true
}

const USAGE = [0x75, 0x73, 0x61, 0x67, 0x65]
const ERROR = [0x65, 0x72, 0x72, 0x6f, 0x72]
const FAILED = [0x66, 0x61, 0x69, 0x6c, 0x65, 0x64]
const NULL = [0x6e, 0x75, 0x6c, 0x6c]

/** Whether a member named just before `at` is `null`: `":null` or `": null`. */
const nullAfter = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === QUOTE &&
  bytes[at + 1] === COLON &&
  (spelled(bytes, at + 2, NULL) || (bytes[at + 2] === SPACE && spelled(bytes, at + 3, NULL)))

/**
 * Whether a data line mentions usage, an error or a failure, in one pass over
 * its bytes. A member that is only `null` (`"usage":null` on every Chat chunk,
 * `"error":null` in each Responses lifecycle event) says nothing, so it does
 * not count.
 */
const worthReading = (bytes: Uint8Array, start: number, end: number): boolean => {
  for (let i = start; i < end; i++) {
    const b = bytes[i] ?? 0
    // Most bytes start none of the words; three compares pass over them.
    if (b !== 0x75 && b !== 0x65 && b !== 0x66) continue
    const word = b === 0x75 ? USAGE : b === 0x65 ? ERROR : FAILED
    if (i + word.length <= end && spelled(bytes, i, word) && !nullAfter(bytes, i + word.length)) return true
  }
  return false
}

/**
 * How a relayed answer ended: it ran to its end, its body failed, the client
 * hung up first, or it was cut for sending nothing for too long.
 */
export type TapEnd = "ended" | "errored" | "dropped" | "stalled"

/**
 * What a watched answer reported when it ended: how it ended, its outcome,
 * and when its first chunk passed (clock milliseconds; absent when none did).
 */
export interface TapReport {
  readonly how: TapEnd
  readonly outcome: TapOutcome
  readonly firstByteAt?: number
}

/**
 * A tap that reports exactly once, however its answer ends. The relay calls
 * `end` on each of those paths (its end, a body error, the client hanging up,
 * the stall sweeper), and this is its one guard: only the first call reports,
 * and the report goes straight to settling the request. `now` is read when
 * the first chunk passes, so a test clock drives it.
 */
export class ReportingTap {
  private firstByteAt: number | undefined
  private reported = false

  constructor(
    readonly tap: Tap,
    private readonly now: () => number,
    private readonly report: (report: TapReport) => void,
  ) {}

  /** Reads one chunk on its way to the client. */
  chunk(bytes: Uint8Array): void {
    if (this.reported) return
    if (this.firstByteAt === undefined && bytes.length > 0) this.firstByteAt = this.now()
    this.tap.chunk(bytes)
  }

  /** The answer is over, the way `how` says: report it, unless that already happened. */
  end(how: TapEnd): void {
    if (this.reported) return
    this.reported = true
    const outcome = this.tap.finish()
    this.report(this.firstByteAt === undefined ? { how, outcome } : { how, outcome, firstByteAt: this.firstByteAt })
  }

  /** Whether the answer has been reported. */
  get done(): boolean {
    return this.reported
  }
}
