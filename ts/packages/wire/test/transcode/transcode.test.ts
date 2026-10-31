import { describe, expect } from "bun:test"
import type { Dialect } from "@slopmax/domain"
import { it } from "@slopmax/test"
import * as fc from "fast-check"
import {
  common,
  isDocument,
  maxHeld,
  readAnswer,
  type TranscodeOptions,
  transcoder,
  type UpstreamDialect,
} from "../../src/index.ts"
import { bytes, context, framesOf } from "../common/fixtures.ts"

const { Event } = common

const text = new TextDecoder()

/** What the client hears from these pieces, as text. */
const said = (pieces: ReadonlyArray<Uint8Array>): string => pieces.map((piece) => text.decode(piece)).join("")

const options = (fields: Partial<TranscodeOptions> = {}): TranscodeOptions => ({
  request: common.emptyRequest("m"),
  context: context("grok-4"),
  document: false,
  ...fields,
})

/** Everything a transcoder sends the client for these upstream chunks, as text. */
const run = (
  from: UpstreamDialect,
  to: Dialect,
  chunks: ReadonlyArray<string | Uint8Array>,
  fields: Partial<TranscodeOptions> = {},
): string => {
  const transcode = transcoder(from, to, options(fields))
  const out: Array<Uint8Array> = []
  for (const chunk of chunks) out.push(...transcode.push(typeof chunk === "string" ? bytes(chunk) : chunk))
  out.push(...transcode.end())
  return out.map((piece) => text.decode(piece)).join("")
}

const chatStream = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Héllo, "}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking ✓"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"wörld 🌍"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Bash","arguments":"{\\"cmd\\""}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ls\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
  "data: [DONE]\n\n",
].join("")

const responsesStream = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
  'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added"}\n\n',
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Plän"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"gAAA"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m","delta":"Ça va "}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m","delta":"✓"}\n\n',
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c9","name":"Bash","arguments":"{}"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n',
].join("")

/** Cuts `whole` into pieces at the given byte offsets, which may fall inside a character. */
const cutAt = (whole: Uint8Array, offsets: ReadonlyArray<number>): Array<Uint8Array> => {
  const points = [...new Set(offsets)].toSorted((a, b) => a - b)
  const pieces: Array<Uint8Array> = []
  let from = 0
  for (const point of points) {
    pieces.push(whole.subarray(from, point))
    from = point
  }
  pieces.push(whole.subarray(from))
  return pieces
}

describe("transcoder", () => {
  it("turns Chat chunks split anywhere into Messages events", () => {
    const watched: Array<common.Event> = []
    const out = run(
      "chat",
      "messages",
      [
        'data: {"choices":[{"index":0,"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        "\ndata: [DONE]\n\n",
      ],
      { watch: (event) => watched.push(event) },
    )
    expect(out).toContain('"text":"Hello"')
    expect(out).toContain("message_stop")
    expect(watched[0]).toEqual(Event.Text({ text: "Hello" }))
  })

  it("tells the same answer however the upstream's bytes are split", () => {
    const cases: ReadonlyArray<readonly [UpstreamDialect, Dialect, string]> = [
      ["chat", "messages", chatStream],
      ["chat", "responses", chatStream],
      ["responses", "messages", responsesStream],
      ["responses", "chat", responsesStream],
    ]
    for (const [from, to, stream] of cases) {
      const whole = bytes(stream)
      const expected = run(from, to, [whole])
      expect(expected.length).toBeGreaterThan(0)
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 0, max: whole.length }), { maxLength: 12 }), (offsets) => {
          expect(run(from, to, cutAt(whole, offsets))).toBe(expected)
        }),
        { numRuns: 150 },
      )
      // One byte at a time, too.
      expect(
        run(
          from,
          to,
          cutAt(
            whole,
            Array.from({ length: whole.length }, (_, k) => k),
          ),
        ),
      ).toBe(expected)
    }
  })

  it("reads lines ending in CRLF, and a last event with no newline after it", () => {
    const out = run("chat", "chat", [
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]',
    ])
    const frames = framesOf(out)
    expect(frames.map((frame) => frame.data)).toMatchObject([
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ finish_reason: "stop" }] },
      "[DONE]",
    ])
  })

  it("reads data lines that arrive without the blank lines between events", () => {
    const out = run("chat", "messages", [
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\ndata: {"choices":[{"index":0,"delta":{"content":"b"}}]}\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\ndata: [DONE]\n',
    ])
    expect(out).toContain('"text":"a"')
    expect(out).toContain('"text":"b"')
    expect(out).toContain("message_stop")
  })

  it("sends nothing until there is something to send, and nothing after the end", () => {
    const watched: Array<string> = []
    const transcode = transcoder("responses", "messages", options({ watch: (event) => watched.push(event._tag) }))
    expect(transcode.push(bytes('event: response.created\ndata: {"type":"response.created"}\n\n'))).toEqual([])
    expect(transcode.push(bytes(": keepalive\n\n"))).toEqual([])
    const [first] = transcode.push(bytes('data: {"type":"response.output_text.delta","delta":"x"}\n\n'))
    expect(text.decode(first)).toContain("message_start")
    expect(watched).toEqual(["Text"])
    const end = transcode.end()
    expect(text.decode(end[0])).toContain('"type":"error"')
    expect(transcode.end()).toEqual([])
    expect(transcode.push(bytes("data: {}\n\n"))).toEqual([])
  })

  it("turns a stream that broke off into an error in the client's format", () => {
    const out = run("responses", "chat", ['data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'])
    const frames = framesOf(out)
    expect(frames.slice(-2).map((frame) => frame.data)).toEqual([
      {
        error: {
          message: "the upstream stream ended before the response completed",
          type: "api_error",
          code: 502,
        },
      },
      "[DONE]",
    ])
  })

  it("reads an upstream that answered with one JSON document whole, at the end", () => {
    const document = JSON.stringify({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Whole" }, finish_reason: "stop" }],
    })
    const half = Math.floor(document.length / 2)
    const transcode = transcoder("chat", "messages", options({ document: true }))
    expect(transcode.push(bytes(document.slice(0, half)))).toEqual([])
    expect(transcode.push(bytes(document.slice(half)))).toEqual([])
    const out = transcode
      .end()
      .map((piece) => text.decode(piece))
      .join("")
    expect(out).toContain('"text":"Whole"')
    expect(out).toContain("message_stop")
    expect(run("chat", "messages", ["{not json"], { document: true })).toContain('"type":"error"')
  })

  it("fails an answer the moment it holds more than 64 MiB at once, keeping what came before", () => {
    const mib = new Uint8Array(1024 * 1024).fill(0x61)
    const chunks = Array.from({ length: maxHeld / mib.length + 1 }, () => mib)
    const document = run("chat", "messages", chunks, { document: true })
    expect(document).toContain("the upstream answer was larger than 64 MiB")

    const transcode = transcoder("chat", "messages", options())
    expect(said(transcode.push(bytes('data: {"choices":[{"delta":{"content":"Before"}}]}\n\ndata: ')))).toContain(
      "Before",
    )
    let failed = ""
    for (const chunk of chunks) failed += said(transcode.push(chunk))
    expect(failed).toContain("the upstream answer was larger than 64 MiB")
    expect(said(transcode.push(bytes('\n\ndata: {"choices":[{"delta":{"content":"After"}}]}\n\n')))).toBe("")
    expect(transcode.end()).toEqual([])
  })

  it("knows a JSON answer by its content type", () => {
    expect(isDocument(new Headers({ "content-type": "application/json; charset=utf-8" }))).toBe(true)
    expect(isDocument(new Headers({ "content-type": "text/event-stream" }))).toBe(false)
    expect(isDocument(new Headers())).toBe(false)
  })
})

describe("readAnswer", () => {
  it("reads a whole event stream by the same rules, then finishes it, showing each event to the watcher", () => {
    const watched: Array<common.Event> = []
    const events = readAnswer("responses", bytes(responsesStream.replaceAll("\n\n", "\r\n\r\n")), {
      request: common.emptyRequest("m"),
      document: false,
      token: () => "x",
      watch: (event) => watched.push(event),
    })
    expect(events.map((event) => event._tag)).toEqual(["Reasoning", "State", "Text", "Text", "Call", "Done"])
    expect(watched).toEqual([...events])
  })

  it("reads a whole JSON response as one document", () => {
    const events = readAnswer(
      "responses",
      bytes(JSON.stringify({ output: [{ type: "message", content: [{ text: "Hi" }] }], usage: {} })),
      { request: common.emptyRequest("m"), document: true, token: () => "x" },
    )
    expect(events.map((event) => event._tag)).toEqual(["Text", "Done"])
  })
})
