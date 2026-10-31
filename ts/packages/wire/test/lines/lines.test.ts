import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Sse } from "effect/encoding"
import * as fc from "fast-check"
import { lines } from "../../src/index.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Every line the splitter hands over, as text, for the stream cut into these chunks. */
const split = (chunks: ReadonlyArray<string | Uint8Array>, max?: number): Array<string> => {
  const splitter = new lines.Lines(max)
  const seen: Array<string> = []
  const visit: lines.Visit = (buffer, start, end) => {
    seen.push(new TextDecoder().decode(buffer.subarray(start, end)))
    return false
  }
  for (const chunk of chunks) splitter.push(typeof chunk === "string" ? bytes(chunk) : chunk, visit)
  splitter.end(visit)
  return seen
}

/** The text cut at the given offsets. */
const cutAt = (text: string, offsets: ReadonlyArray<number>): Array<Uint8Array> => {
  const whole = bytes(text)
  const points = [...new Set(offsets.map((n) => n % (whole.length + 1)))].toSorted((a, b) => a - b)
  const chunks: Array<Uint8Array> = []
  let from = 0
  for (const point of points) {
    chunks.push(whole.subarray(from, point))
    from = point
  }
  chunks.push(whole.subarray(from))
  return chunks
}

describe("Lines", () => {
  it("splits a stream into lines, joining a line cut between chunks", () => {
    expect(split(['event: a\ndata: {"x"', ":1}\n\nda", "ta: 2\n"])).toEqual([
      "event: a",
      'data: {"x":1}',
      "",
      "data: 2",
    ])
  })

  it("hands over the last line when the stream ends without a newline", () => {
    expect(split(["data: 1\ndata: ", "2"])).toEqual(["data: 1", "data: 2"])
    expect(split(["data: 1\n"])).toEqual(["data: 1"])
    expect(split([])).toEqual([])
  })

  it("passes over lines longer than its limit, in one chunk or across many", () => {
    expect(split(["short\n0123456789\nok\n"], 5)).toEqual(["short", "ok"])
    expect(split(["sho", "rt\n0123", "45", "6789\nok", "\n"], 5)).toEqual(["short", "ok"])
    expect(split(["0123", "456789"], 5)).toEqual([])
    expect(split(["12345\n"], 5)).toEqual(["12345"])
  })

  it("stops where the visitor says to", () => {
    const splitter = new lines.Lines()
    const seen: Array<number> = []
    const stopped = splitter.push(bytes("a\nb\nc\n"), (_, start) => {
      seen.push(start)
      return start === 2
    })
    expect(stopped).toBe(true)
    expect(seen).toEqual([0, 2])
  })

  it("gives the same lines however the stream is cut", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: "grapheme" }).map((s) => s.replaceAll("\n", " ")),
          { maxLength: 12 },
        ),
        fc.array(fc.nat(), { maxLength: 8 }),
        (expected, offsets) => {
          const stream = expected.map((line) => `${line}\n`).join("")
          expect(split(cutAt(stream, offsets))).toEqual(expected)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe("data lines", () => {
  it("are told apart from other lines, with or without a space after the colon", () => {
    const line = bytes('data: {"a":1}')
    expect(lines.dataStart(line, 0, line.length)).toBe(5)
    expect(lines.dataJson(line, 0, line.length)).toEqual({ a: 1 })
    const tight = bytes('data:{"a":2}\r')
    expect(lines.dataJson(tight, 0, tight.length)).toEqual({ a: 2 })
    for (const other of ["event: data", ": comment", "", "dat", "data: not json", "data:"]) {
      const b = bytes(other)
      expect([other, lines.dataJson(b, 0, b.length)]).toEqual([other, undefined])
    }
  })
})

describe("frame", () => {
  it("writes server-sent events: a name when there is one, then compact JSON, then a blank line", () => {
    expect(lines.frame("ping", { a: 1 }) + lines.frame(undefined, 2)).toBe('event: ping\ndata: {"a":1}\n\ndata: 2\n\n')
  })

  it("writes the same bytes as effect's SSE encoder", () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom("message_start", "content_block_delta", "error"), { nil: undefined }),
        fc.jsonValue(),
        (event, data) => {
          const encoded = Sse.encoder.write({
            _tag: "Event",
            event: event ?? "message",
            id: undefined,
            data: JSON.stringify(data),
          })
          expect(lines.frame(event, data)).toBe(encoded)
        },
      ),
      { numRuns: 300 },
    )
  })
})
