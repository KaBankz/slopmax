// Relaying an answer to the client as it arrives.
//
// The upstream body is read only as fast as the client reads (the stream
// pulls one chunk per read, holding nothing ahead), so a slow client never
// makes slopmax buffer an answer. Each chunk passes the tap, which watches
// for usage and refusals, and, when the request was translated, the
// transcoder, which retells it in the client's format. However the answer
// ends (it ran out, the upstream broke off, the client hung up, or it went
// silent too long) the tap reports exactly once, and that report settles
// the request.
import type { ReportingTap, TapEnd, Transcoder } from "@slopmax/wire"
import type { Clock } from "effect"
import type { Reader, ReadResult } from "./hold.ts"
import type { LiveStream, Shape as LiveShape } from "./live.ts"

/** What a relay needs: the upstream body (with anything held back), the tap, and the retelling, if any. */
export interface RelayPlan {
  readonly reader: Reader
  /** Chunks already read while the start was held; they go first. */
  readonly held: ReadonlyArray<Uint8Array>
  /** A read in flight when holding stopped; it is awaited before reading on. */
  readonly pending: Promise<ReadResult> | undefined
  /** Watches the upstream's bytes; its report settles the request. */
  readonly tap: ReportingTap
  /** Retells the answer in the client's format, for a translated request. */
  readonly transcoder: Transcoder | undefined
  /** The clock the stall sweeper reads, so a test clock drives both. */
  readonly clock: Clock.Clock
}

const noChunks: ReadonlyArray<Uint8Array> = []

/** Ends a translated answer with what the transcoder makes of its end: an error in the client's format when cut. */
const closeTranslated = (controller: ReadableStreamDefaultController<Uint8Array>, retell: Transcoder): void => {
  for (const bytes of retell.end()) controller.enqueue(bytes)
  controller.close()
}

/** The client's side of a relayed answer. */
export const relay = (plan: RelayPlan, live: LiveShape): ReadableStream<Uint8Array> => {
  const { reader, tap, transcoder, clock } = plan
  let held = plan.held
  let next = 0
  let pending = plan.pending
  let finished = false
  let entry: LiveStream | undefined

  /** Settles once, however the answer ended. */
  const finish = (how: TapEnd): boolean => {
    if (finished) return false
    finished = true
    if (entry !== undefined) live.remove(entry)
    held = noChunks
    tap.end(how)
    return true
  }

  const stopUpstream = (reason: unknown): void => {
    reader.cancel(reason).catch(() => undefined)
  }

  const failWith = (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): void => {
    if (transcoder === undefined) controller.error(error)
    else closeTranslated(controller, transcoder)
  }

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const stream: LiveStream = {
          lastChunkAt: clock.currentTimeMillisUnsafe(),
          cut: (how, message) => {
            if (!finish(how === "stalled" ? "stalled" : "errored")) return
            stopUpstream(message)
            failWith(controller, new Error(message))
          },
        }
        entry = stream
        live.add(stream)
      },
      async pull(controller) {
        for (;;) {
          let chunk: Uint8Array
          const replay = held[next]
          if (replay !== undefined) {
            next++
            chunk = replay
          } else {
            let result: ReadResult
            try {
              result = await (pending ?? reader.read())
            } catch (error) {
              if (finish("errored")) failWith(controller, error)
              return
            }
            pending = undefined
            // The stall sweeper or shutdown may have cut the answer while the read was out.
            if (finished) return
            const value = result.value
            if (result.done || value === undefined) {
              finish("ended")
              if (transcoder === undefined) controller.close()
              else closeTranslated(controller, transcoder)
              return
            }
            chunk = value
          }
          if (entry !== undefined) entry.lastChunkAt = clock.currentTimeMillisUnsafe()
          tap.chunk(chunk)
          if (transcoder === undefined) {
            controller.enqueue(chunk)
            return
          }
          // A chunk may complete no event yet; read on until there is something to send.
          const out = transcoder.push(chunk)
          if (out.length > 0) {
            for (const bytes of out) controller.enqueue(bytes)
            return
          }
        }
      },
      cancel(reason) {
        if (finish("dropped")) stopUpstream(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
