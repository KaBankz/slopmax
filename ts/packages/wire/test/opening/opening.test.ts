import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import * as fc from "fast-check"
import { holdsStart, judge, Opening, Verdict } from "../../src/index.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const created = 'data: {"type":"response.created","response":{"id":"r"}}\n\n'
const spentEvent = 'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n'
const outputAdded = 'data: {"type":"response.output_item.added"}\n\n'

/** The verdict after feeding these chunks in turn. */
const opens = (chunks: ReadonlyArray<string | Uint8Array>): Verdict => {
  const opening = new Opening("responses")
  let verdict: Verdict = Verdict.Wait()
  for (const chunk of chunks) verdict = opening.feed(typeof chunk === "string" ? bytes(chunk) : chunk)
  return verdict
}

describe("holdsStart", () => {
  it("holds only Responses streams, the one format that refuses inside a 200", () => {
    expect(holdsStart("responses")).toBe(true)
    expect(holdsStart("messages")).toBe(false)
    expect(holdsStart("chat")).toBe(false)
  })
})

describe("judge", () => {
  it("finds a spent quota in Responses, and treats anything in the other formats as content", () => {
    const failed = { type: "error", error: { code: "usage_limit_reached" } }
    expect(judge("responses", failed)).toEqual(Verdict.Refused({ exhausted: true }))
    expect(judge("messages", failed)).toEqual(Verdict.Content())
    expect(judge("chat", failed)).toEqual(Verdict.Content())
  })

  it("waits through the lifecycle events that say nothing yet", () => {
    for (const type of ["response.created", "response.in_progress", "response.queued"]) {
      expect(judge("responses", { type })).toEqual(Verdict.Wait())
    }
  })

  it("tells a spent quota from throttling, wherever the failure keeps its code", () => {
    for (const code of ["usage_limit_reached", "usage_limit_exceeded"]) {
      expect(judge("responses", { type: "response.failed", response: { error: { code } } })).toEqual(
        Verdict.Refused({ exhausted: true }),
      )
    }
    for (const code of ["server_is_overloaded", "slow_down", "rate_limit_exceeded"]) {
      expect(judge("responses", { type: "error", error: { code } })).toEqual(Verdict.Refused({ exhausted: false }))
      expect(judge("responses", { type: "error", error: { type: code } })).toEqual(
        Verdict.Refused({ exhausted: false }),
      )
    }
  })

  it("passes failures that belong to the request, and content, on to the client", () => {
    expect(
      judge("responses", { type: "response.failed", response: { error: { code: "context_length_exceeded" } } }),
    ).toEqual(Verdict.Content())
    expect(judge("responses", { type: "error" })).toEqual(Verdict.Content())
    expect(judge("responses", { type: "response.output_text.delta", delta: "hi" })).toEqual(Verdict.Content())
  })
})

describe("Opening", () => {
  it("opens with content once something past the lifecycle arrives", () => {
    const opening = new Opening("responses")
    expect(opening.feed(bytes(created))._tag).toBe("Wait")
    expect(opening.feed(bytes(outputAdded))._tag).toBe("Content")
  })

  it("catches a spent quota before the client sees anything", () => {
    expect(opens([created, spentEvent])).toEqual(Verdict.Refused({ exhausted: true }))
  })

  it("lets a request's own failure through to the client", () => {
    expect(
      opens(['data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}\n\n'])._tag,
    ).toBe("Content")
  })

  it("says nothing on event names, blank lines, comments or lines still unfinished", () => {
    expect(opens(["event: response.created\n", ": keepalive\n\n", 'data: {"type":"response.fai'])._tag).toBe("Wait")
  })

  it("keeps its first verdict", () => {
    const opening = new Opening("responses")
    expect(opening.feed(bytes(spentEvent))._tag).toBe("Refused")
    expect(opening.feed(bytes(outputAdded))._tag).toBe("Refused")
  })

  it("reaches the same verdict however the stream is cut", () => {
    const stream = bytes(created + spentEvent + outputAdded)
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: stream.length }), { maxLength: 6 }), (offsets) => {
        const points = [...new Set(offsets)].toSorted((a, b) => a - b)
        const chunks: Array<Uint8Array> = []
        let from = 0
        for (const point of points) {
          chunks.push(stream.subarray(from, point))
          from = point
        }
        chunks.push(stream.subarray(from))
        expect(opens(chunks)).toEqual(Verdict.Refused({ exhausted: true }))
      }),
      { numRuns: 200 },
    )
  })
})
