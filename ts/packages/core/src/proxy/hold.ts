// Holding back the start of an answer that may still refuse.
//
// ChatGPT answers 200 and only then says, inside the stream, that the
// account's quota is spent or the service is busy. Had the client already
// seen the stream start, it would have to show that error. So the first
// events are held (at most 3 seconds and 256 KiB) and judged: once content
// begins, what was held is replayed and the rest streams; a refusal moves
// the request to another account before the client has seen a byte.
//
// The wait can run out while a read is in flight. That read is kept, not
// cancelled, and handed to the relay, which awaits it first: no chunk is
// ever lost between holding and relaying.
import type { Opening } from "@slopmax/wire"
import { Clock, Data, Duration, Effect, Option } from "effect"

/** One read of a body: a chunk, or its end. */
export interface ReadResult {
  readonly done: boolean
  readonly value?: Uint8Array | undefined
}

/** A body's reader, as the proxy uses one. */
export interface Reader {
  read(): Promise<ReadResult>
  cancel(reason?: unknown): Promise<void>
}

/** How the held start came out. */
export type Held = Data.TaggedEnum<{
  /**
   * The answer streams: `held` first, then `pending` (a read still in
   * flight when the wait ran out, or one that failed), then the reader.
   */
  Streaming: {
    readonly reader: Reader
    readonly held: ReadonlyArray<Uint8Array>
    readonly pending: Promise<ReadResult> | undefined
  }
  /** The account refused before any content: the held bytes, and whether its quota is spent. */
  Refused: { readonly bytes: Uint8Array; readonly exhausted: boolean }
}>
export const Held = Data.taggedEnum<Held>()

/** The most of an answer held back. */
export const holdLimit = 256 * 1024

/** The longest an answer's start is held. */
export const holdWait: Duration.Duration = Duration.seconds(3)

/** A read's outcome, or that it failed; the failure itself is the relay's to report. */
type Awaited = { readonly ok: true; readonly result: ReadResult } | { readonly ok: false }

/**
 * Waits on a read already in flight. Giving up the wait (on the timeout)
 * leaves the read itself running, so whoever awaits it next gets its chunk.
 */
const awaitRead = (pending: Promise<ReadResult>): Effect.Effect<Awaited> =>
  Effect.callback<Awaited>((resume) => {
    pending.then(
      (result) => resume(Effect.succeed({ ok: true, result })),
      () => resume(Effect.succeed({ ok: false })),
    )
  })

/** Chunks as one body in a plain buffer: an answer that refused, or a request sent in chunks. */
export const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const only = chunks.length === 1 ? chunks[0] : undefined
  if (only !== undefined && only.buffer instanceof ArrayBuffer)
    return new Uint8Array(only.buffer, only.byteOffset, only.byteLength)
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

/** Stops reading an answer that will not be relayed. */
export const cancelReader = (reader: Reader): Effect.Effect<void> =>
  Effect.sync(() => void reader.cancel().catch(() => undefined))

/**
 * Holds an answer's start until `judge` says it opened with content or
 * refused, the wait or the size limit runs out, or the body ends or fails.
 * If the request is interrupted meanwhile, the upstream read is cancelled:
 * from the moment the body is locked to a reader, nothing else can.
 */
export const holdStart = (body: ReadableStream<Uint8Array>, judge: Opening): Effect.Effect<Held> =>
  Effect.uninterruptibleMask((restore) => {
    const reader: Reader = body.getReader()
    return restore(hold(reader, judge)).pipe(Effect.onInterrupt(() => cancelReader(reader)))
  })

const hold = Effect.fnUntraced(function* (reader: Reader, judge: Opening) {
  const held: Array<Uint8Array> = []
  let size = 0
  let pending: Promise<ReadResult> | undefined
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(holdWait)
  while (size < holdLimit) {
    pending ??= reader.read()
    const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
    const next = yield* awaitRead(pending).pipe(Effect.timeoutOption(Duration.millis(left)))
    if (Option.isNone(next)) return Held.Streaming({ reader, held, pending })
    // A failed read stays pending: the relay reports it as the answer's error.
    if (!next.value.ok) return Held.Streaming({ reader, held, pending })
    pending = undefined
    const { result } = next.value
    const chunk = result.value
    if (result.done || chunk === undefined) return Held.Streaming({ reader, held, pending: Promise.resolve(result) })
    held.push(chunk)
    size += chunk.byteLength
    const verdict = judge.feed(chunk)
    if (verdict._tag === "Content") return Held.Streaming({ reader, held, pending: undefined })
    if (verdict._tag === "Refused") {
      yield* cancelReader(reader)
      return Held.Refused({ bytes: concat(held), exhausted: verdict.exhausted })
    }
  }
  return Held.Streaming({ reader, held, pending: undefined })
})
