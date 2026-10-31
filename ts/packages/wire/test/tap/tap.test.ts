import { describe, expect } from "bun:test"
import type { Dialect } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import * as fc from "fast-check"
import {
  maxDocument,
  ReportingTap,
  shapeOf,
  Tap,
  type TapEnd,
  type TapOutcome,
  type TapReport,
} from "../../src/index.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Runs a whole answer, cut into these chunks, through a tap. */
const tapped = (
  dialect: Dialect,
  chunks: ReadonlyArray<string | Uint8Array>,
  headers: Record<string, string> = {},
): TapOutcome => {
  const tap = Tap.forResponse(dialect, new Headers(headers))
  for (const chunk of chunks) tap.chunk(typeof chunk === "string" ? bytes(chunk) : chunk)
  return tap.finish()
}

const json = { "content-type": "application/json" }

const claudeStream = [
  "event: message_start\n",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}',
  "\n\nevent: content_block_delta\n",
  'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
  "\n\nevent: message_delta\n",
  'data: {"type":"message_delta","usage":{"output_tokens":15}}',
  "\n\n",
].join("")

describe("shapeOf", () => {
  it("reads compressed answers as opaque, JSON ones as a document, and the rest as events", () => {
    expect(shapeOf(new Headers({ "content-encoding": "gzip", ...json }))).toBe("opaque")
    expect(shapeOf(new Headers({ "content-encoding": "identity", ...json }))).toBe("document")
    expect(shapeOf(new Headers({ "content-type": "application/json; charset=utf-8" }))).toBe("document")
    expect(shapeOf(new Headers({ "content-type": "text/event-stream" }))).toBe("events")
    expect(shapeOf(new Headers())).toBe("events")
  })
})

describe("Tap over events", () => {
  it("merges Messages usage from the start and the last delta, across a line cut between chunks", () => {
    const outcome = tapped("messages", [claudeStream.slice(0, 70), claudeStream.slice(70)])
    expect(outcome.usage).toMatchObject({ requests: 1, input: 2095, output: 15, cacheRead: 355_598, cacheWrite: 7185 })
    expect(outcome.exhausted).toBe(false)
  })

  it("separates cached input in a Responses stream", () => {
    const outcome = tapped("responses", [
      'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":25},"output_tokens":40,"total_tokens":140}}}',
      "\n\n",
    ])
    expect(outcome.usage).toMatchObject({ input: 75, cacheRead: 25, output: 40 })
  })

  it("marks the account spent when a Responses stream fails with a usage limit", () => {
    const outcome = tapped("responses", [
      'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n',
    ])
    expect(outcome.exhausted).toBe(true)
  })

  it("reads the last line even when the stream ends without a newline", () => {
    const outcome = tapped("messages", ['data: {"type":"message_delta","usage":{"output_tokens":7}}'])
    expect(outcome.usage.output).toBe(7)
  })

  it("always counts one request, even for an answer that said nothing", () => {
    expect(tapped("chat", []).usage).toMatchObject({ requests: 1, input: 0, output: 0 })
    expect(tapped("messages", ["data: not json, but it mentions usage\n"]).usage.requests).toBe(1)
  })

  it("reads a line that carries an error even when its usage is null", () => {
    const outcome = tapped("chat", [
      'data: {"choices":[],"usage":null}\n\n',
      'data: {"usage": null,"error":{"message":"cut off"}}\n\n',
    ])
    expect(outcome.failed).toBe(true)
    expect(outcome.usage.input).toBe(0)
  })

  it("reads usage that follows a null mention on the same line", () => {
    const outcome = tapped("responses", [
      'data: {"type":"response.completed","response":{"error":null,"usage":{"input_tokens":4,"output_tokens":2}}}\n',
    ])
    expect(outcome.usage).toMatchObject({ input: 4, output: 2 })
  })

  it("passes over a line longer than 16 MiB and reads the lines after it", () => {
    const huge = `data: {"usage":"${"x".repeat(16 * 1024 * 1024)}"}\n`
    const outcome = tapped("messages", [
      huge.slice(0, 1000),
      huge.slice(1000),
      'data: {"type":"message_delta","usage":{"output_tokens":3}}\n',
    ])
    expect(outcome.usage.output).toBe(3)
  })

  it("reaches the same outcome however the stream is cut", () => {
    const stream = bytes(claudeStream)
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: stream.length }), { maxLength: 10 }), (offsets) => {
        const points = [...new Set(offsets)].toSorted((a, b) => a - b)
        const chunks: Array<Uint8Array> = []
        let from = 0
        for (const point of points) {
          chunks.push(stream.subarray(from, point))
          from = point
        }
        chunks.push(stream.subarray(from))
        expect(tapped("messages", chunks).usage).toMatchObject({ input: 2095, output: 15, cacheWrite: 7185 })
      }),
      { numRuns: 200 },
    )
  })
})

describe("Tap over a whole answer", () => {
  it("reads usage from a JSON answer when it ends", () => {
    const claude = tapped(
      "messages",
      [
        '{"type":"message","content":[],"usage":{"input_tokens":12,',
        '"output_tokens":3,"cache_read_input_tokens":40}}',
      ],
      json,
    )
    expect(claude.usage).toMatchObject({ input: 12, output: 3, cacheRead: 40 })
    const codex = tapped(
      "responses",
      [
        '{"object":"response","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":20},"output_tokens":5}}',
      ],
      json,
    )
    expect(codex.usage).toMatchObject({ input: 30, cacheRead: 20, output: 5 })
  })

  it("keeps multi-byte text cut between chunks intact", () => {
    const answer = bytes('{"type":"message","content":[{"text":"café"}],"usage":{"output_tokens":2}}')
    const cut = answer.indexOf(0xc3) + 1
    expect(tapped("messages", [answer.subarray(0, cut), answer.subarray(cut)], json).usage.output).toBe(2)
  })

  it("only counts the request for a document past 16 MiB, or a compressed answer", () => {
    const big = `{"usage":{"prompt_tokens":5},"pad":"${"x".repeat(maxDocument)}"}`
    expect(tapped("chat", [big], json).usage).toMatchObject({ requests: 1, input: 0 })
    const gzip = tapped("messages", [new Uint8Array([0x1f, 0x8b])], { "content-encoding": "gzip", ...json })
    expect(gzip.usage).toMatchObject({ requests: 1, input: 0, output: 0 })
  })
})

describe("Tap.finish", () => {
  it("decides once: later calls give the same outcome and later chunks are ignored", () => {
    const tap = new Tap("messages")
    tap.chunk(bytes('data: {"type":"message_delta","usage":{"output_tokens":3}}\n'))
    const first = tap.finish()
    tap.chunk(bytes('data: {"type":"message_delta","usage":{"output_tokens":9}}\n'))
    expect(tap.finish()).toBe(first)
    expect(first.usage.output).toBe(3)
  })
})

describe("ReportingTap", () => {
  const delta = bytes('data: {"type":"message_delta","usage":{"output_tokens":3}}\n')

  it("reports once even when the client drops the answer after its first chunk", () => {
    const reports: Array<TapReport> = []
    const reporting = new ReportingTap(
      new Tap("messages"),
      () => 1_000,
      (report) => reports.push(report),
    )
    reporting.chunk(delta)
    // The client hangs up; then the body's own end and error paths fire too.
    reporting.end("dropped")
    reporting.chunk(bytes("data: tail\n"))
    reporting.end("ended")
    reporting.end("errored")
    expect(reports).toHaveLength(1)
    expect(reports[0]?.how).toBe("dropped")
    expect(reports[0]?.outcome.usage.output).toBe(3)
    expect(reports[0]?.firstByteAt).toBe(1_000)
    expect(reporting.done).toBe(true)
  })

  it.effect("stamps the moment the first chunk passed by the clock it is given", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const reports: Array<TapReport> = []
      const reporting = new ReportingTap(
        new Tap("messages"),
        () => clock.currentTimeMillisUnsafe(),
        (report) => reports.push(report),
      )
      yield* TestClock.adjust("2 seconds")
      reporting.chunk(new Uint8Array(0))
      yield* TestClock.adjust("3 seconds")
      reporting.chunk(delta)
      yield* TestClock.adjust("4 seconds")
      reporting.chunk(delta)
      reporting.end("ended")
      expect(reports[0]?.firstByteAt).toBe(5_000)
    }),
  )

  it("reports an answer that never sent a chunk with no first-chunk time", () => {
    const reports: Array<TapReport> = []
    new ReportingTap(
      new Tap("chat"),
      () => 1,
      (report) => reports.push(report),
    ).end("stalled")
    expect(reports).toHaveLength(1)
    expect(reports[0]?.how).toBe("stalled")
    expect(reports[0] !== undefined && "firstByteAt" in reports[0]).toBe(false)
    expect(reports[0]?.outcome.usage.requests).toBe(1)
  })

  it("reports exactly once wherever the answer is cut short", () => {
    const stream = bytes(claudeStream)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: stream.length }),
        fc.array(fc.constantFrom<TapEnd>("ended", "errored", "dropped", "stalled"), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 64 }),
        (cut, ends, size) => {
          const reports: Array<TapReport> = []
          const reporting = new ReportingTap(
            new Tap("messages"),
            () => 7,
            (report) => reports.push(report),
          )
          for (let from = 0; from < cut; from += size)
            reporting.chunk(stream.subarray(from, Math.min(cut, from + size)))
          for (const how of ends) reporting.end(how)
          expect(reports).toHaveLength(1)
          expect(reports[0]?.how).toBe(ends[0])
          expect(reports[0]?.firstByteAt).toBe(cut > 0 ? 7 : undefined)
        },
      ),
      { numRuns: 200 },
    )
  })
})
