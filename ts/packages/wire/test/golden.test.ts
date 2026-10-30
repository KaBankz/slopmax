// What the Rust slopmax-wire does with each input, compared byte for byte.
// The lines come from test/fixtures/wire-golden.rs, run against the Rust
// crate; random ids read as `<prefix>ID` and `created`/`created_at` as 0 on
// both sides.
import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Result } from "effect"
import { it } from "@slopmax/test"

import { text } from "@slopmax/common"

import { Outcome } from "../src/base.ts"
import { Dialect } from "../src/dialect.ts"
import { Answer, type Event, Request } from "../src/ir.ts"
import * as json from "../src/json.ts"
import { Decoder, decode, Encoder, encode, type Target, whole } from "../src/translate.ts"

type Line = Record<string, unknown>

const lines: ReadonlyArray<Line> = readFileSync(join(import.meta.dir, "fixtures", "wire-golden.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l) as Line)

const of = (kind: string): ReadonlyArray<Line> => lines.filter((l) => l["kind"] === kind)
const s = (l: Line, key: string): string => l[key] as string

const PREFIXES = ["chatcmpl-", "resp_", "msg_", "rs_", "fc_", "ctc_", "cmp_", "call_"]
const TOKEN = /^[A-Za-z0-9_-]{43}/
const CREATED = /^"(created_at|created)":[0-9]+/

/** The generator's `normalize`: ids and creation times made stable. */
const normalize = (t: string): string => {
  let out = ""
  let i = 0
  outer: while (i < t.length) {
    for (const p of PREFIXES) {
      if (t.startsWith(p, i) && TOKEN.test(t.slice(i + p.length, i + p.length + 43))) {
        out += `${p}ID`
        i += p.length + 43
        continue outer
      }
    }
    if (t[i] === '"') {
      const m = CREATED.exec(t.slice(i, i + 40))
      if (m !== null) {
        out += `"${m[1]}":0`
        i += m[0].length
        continue
      }
    }
    out += t[i]
    i++
  }
  return out
}

/** Rust's `{:?}` of an `Event`. */
const debugEvent = (e: Event): string => {
  switch (e._tag) {
    case "Text":
    case "Reasoning":
      return `${e._tag}(${text.debug(e.text)})`
    case "State":
      return `State(${text.debug(e.state)})`
    case "Call": {
      const c = e.call
      return `Call(Call { id: ${text.debug(c.id)}, name: ${text.debug(c.name)}, input: ${text.debug(c.input)}, kind: ${c.kind} })`
    }
    case "Done": {
      const u = e.usage
      return `Done { stop: ${e.stop}, usage: Usage { requests: ${u.requests}, input_tokens: ${u.inputTokens}, output_tokens: ${u.outputTokens}, cache_read_tokens: ${u.cacheReadTokens}, cache_write_tokens: ${u.cacheWriteTokens} } }`
    }
    case "Error":
      return `Error(Failure { status: ${e.failure.status}, message: ${text.debug(e.failure.message)} })`
  }
}

/** Rust's `{:?}` of a `Vec<Event>`. */
const debugEvents = (events: ReadonlyArray<Event>): string => `[${events.map(debugEvent).join(", ")}]`

const usage = { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 2 }
const call = (kind: "Function" | "Freeform"): Event => ({
  _tag: "Call",
  call: { id: "call_7", name: "f", input: kind === "Freeform" ? 'raw "input"' : "", kind },
})
const fail = (status: number, message: string): Event => ({ _tag: "Error", failure: { status, message } })

const dialect = (l: Line, key: string): Dialect => l[key] as Dialect
const target = (l: Line, key: string): Target => l[key] as Target

/** The clock; `normalize` reads every creation time as 0 anyway. */
const NOW = 0

const request = (client: Dialect, body: string): Request => {
  const r = decode(client, new TextEncoder().encode(body))
  if (Result.isFailure(r)) throw new Error(r.failure.message)
  return r.success
}

describe("golden: serde_json's reading and writing", () => {
  it("documents read and write back as serde_json has them", () => {
    for (const l of of("roundtrip")) {
      const bytes = new Uint8Array(l["bytes"] as Array<number>)
      const read = json.read(bytes)
      if (l["error"] !== undefined) {
        expect(Result.isFailure(read) ? read.failure : "accepted").toBe(s(l, "error"))
      } else {
        expect(Result.isSuccess(read) ? json.stringify(read.success) : read.failure).toBe(s(l, "out"))
      }
    }
  })
})

describe("golden: requests", () => {
  it("decode failures say what serde_json and the decoders say", () => {
    const cases = of("decode")
    expect(cases.length).toBeGreaterThan(50)
    for (const l of cases) {
      const bytes = new TextEncoder().encode(s(l, "body"))
      if (s(l, "error").includes("recursion limit exceeded")) {
        // A known deviation (PORT.md): the port reads JSON nested deeper
        // than serde_json's 127 levels. Its scanner still says so.
        expect(`the request is not valid JSON: ${json.scan(bytes)}`).toBe(s(l, "error"))
        continue
      }
      const r = decode(dialect(l, "client"), bytes)
      expect(Result.isFailure(r) ? r.failure.message : "decoded").toBe(s(l, "error"))
    }
  })

  it("requests encode for each upstream byte for byte", () => {
    const cases = of("encode")
    expect(cases.length).toBeGreaterThan(20)
    for (const l of cases) {
      const r = request(dialect(l, "client"), s(l, "body"))
      expect(json.stringify(encode(target(l, "upstream"), r))).toBe(s(l, "out"))
    }
  })
})

describe("golden: answers", () => {
  it("streams decode into the Rust's events and encode into its frames", () => {
    const cases = of("stream")
    expect(cases.length).toBeGreaterThan(20)
    for (const l of cases) {
      const client = dialect(l, "client")
      const r = request(client, s(l, "request"))
      const decoder = Decoder.make(dialect(l, "upstream"), r)
      const events: Array<Event> = []
      for (const d of l["data"] as Array<string>) decoder.data(new TextEncoder().encode(d), events)
      if (l["finish"] === true) decoder.finish(events)
      expect(normalize(debugEvents(events))).toBe(s(l, "events"))
      const encoder = Encoder.forRequest(client, r, "m", l["include_usage"] === true, NOW)
      let out = ""
      for (const e of events) out += encoder.event(e)
      expect(normalize(out)).toBe(s(l, "out"))
      expect(normalize(json.stringify(whole(client, r, Answer.collect(events), "m", NOW)))).toBe(s(l, "whole"))
    }
  })

  it("whole answers decode and encode as the Rust's", () => {
    const cases = of("whole")
    expect(cases.length).toBeGreaterThan(10)
    for (const l of cases) {
      const client = dialect(l, "client")
      const r = request(client, s(l, "request"))
      const events: Array<Event> = []
      Decoder.make(dialect(l, "upstream"), r).whole(new TextEncoder().encode(s(l, "body")), events)
      expect(normalize(debugEvents(events))).toBe(s(l, "events"))
      expect(normalize(json.stringify(whole(client, r, Answer.collect(events), "m", NOW)))).toBe(s(l, "whole"))
    }
  })

  it("encoders write every kind of event as the Rust's", () => {
    const scripts: Record<string, ReadonlyArray<Event>> = {
      "reasoning-text-calls": [
        { _tag: "Reasoning", text: "Think" },
        { _tag: "State", state: "s" },
        { _tag: "Text", text: "A" },
        { _tag: "Reasoning", text: "More" },
        { _tag: "Text", text: "B" },
        call("Function"),
        call("Freeform"),
        { _tag: "Text", text: "C" },
        { _tag: "Done", stop: "End", usage },
      ],
      sequence: [
        { _tag: "Text", text: "x" },
        { _tag: "Done", stop: "Sequence", usage },
      ],
      filtered: [{ _tag: "Done", stop: "Filtered", usage }],
      length: [
        { _tag: "Reasoning", text: "r" },
        { _tag: "Done", stop: "Length", usage },
      ],
      errors: [{ _tag: "Text", text: "t" }, fail(413, "big")],
      "error-401": [fail(401, "who")],
      "error-400": [fail(400, "bad")],
      "error-503": [fail(503, "busy")],
      "error-404": [fail(404, "gone")],
      "error-403": [fail(403, "no")],
      "error-500": [fail(500, "oops")],
    }
    const cases = of("script")
    expect(cases.length).toBe(Object.keys(scripts).length * 8)
    for (const l of cases) {
      const events = scripts[s(l, "name")] ?? []
      const client = dialect(l, "client")
      const r = Request.make({ compact: l["compact"] === true })
      const encoder = Encoder.forRequest(client, r, "m", l["include_usage"] === true, NOW)
      let out = ""
      for (const e of events) out += encoder.event(e)
      expect(normalize(out)).toBe(s(l, "out"))
      expect(normalize(json.stringify(whole(client, r, Answer.collect(events), "m", NOW)))).toBe(s(l, "whole"))
    }
  })
})

describe("golden: what streams say about accounts", () => {
  it("usage, exhaustion, and openings as the Rust reads them", () => {
    const cases = of("observe")
    expect(cases.length).toBe(63)
    for (const l of cases) {
      const d = dialect(l, "dialect")
      const event = json.parse(s(l, "event")) ?? null
      const outcome = Outcome.make()
      Dialect.observe(d, event, outcome)
      const u = outcome.usage
      expect([u.requests, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens]).toEqual(
        l["usage"] as Array<number>,
      )
      expect(outcome.exhausted).toBe(l["exhausted"] as boolean)
      const opening = Dialect.opening(d, event)
      const debug = opening._tag === "Refused" ? `Refused { exhausted: ${opening.exhausted} }` : opening._tag
      expect(debug).toBe(s(l, "opening"))
    }
  })

  it("limit errors and error bodies as the Rust writes them", () => {
    for (const l of of("limit")) {
      const [body, headers] = Dialect.limitReached(
        dialect(l, "dialect"),
        "all spent",
        l["until"] as number,
        l["now"] as number,
      )
      expect(json.stringify(body)).toBe(s(l, "body"))
      expect(headers).toEqual(l["headers"] as Array<[string, string]>)
    }
    for (const l of of("error")) {
      expect(json.stringify(Dialect.error(dialect(l, "dialect"), "api_error", 'x "y"'))).toBe(s(l, "body"))
    }
  })
})
