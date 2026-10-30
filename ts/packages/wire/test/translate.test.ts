import { describe, expect, expectTypeOf } from "bun:test"
import { it } from "@slopmax/test"
import { Result } from "effect"

import { Answer, type Event, Request } from "../src/ir.ts"
import {
  canTranslate,
  Decoder,
  decode,
  Encoder,
  encode,
  path,
  RequestError,
  type Target,
  whole,
} from "../src/translate.ts"
import { array, str } from "../src/json.ts"
import { at, ok } from "./helpers.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The clock, for the `created` fields. */
const NOW = 1_700_000_000_000

describe("translate (Rust tests)", () => {
  /** Claude Code's request, translated for ChatGPT, answered with a tool call, and told back to Claude Code. */
  it("claude_code_through_responses_and_back", () => {
    const body = bytes(`{"model":"gpt-6-sol","max_tokens":1000,"stream":true,
            "system":"You are Claude Code.",
            "messages":[{"role":"user","content":"list files"}],
            "tools":[{"name":"Bash","description":"Run","input_schema":{"type":"object"}}]}`)
    const request = ok(decode("messages", body))
    const upstream = encode("responses", request)
    expect(at(upstream, "instructions")).toBe("You are Claude Code.")
    expect(at(upstream, "input", 0, "content", 0, "text")).toBe("list files")
    expect(at(upstream, "tools", 0, "name")).toBe("Bash")

    const decoder = Decoder.make("responses", request)
    const events: Array<Event> = []
    for (const data of [
      `{"type":"response.created","response":{"id":"r"}}`,
      `{"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}`,
      `{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}`,
    ]) {
      decoder.data(bytes(data), events)
    }
    const encoder = Encoder.make("messages", "gpt-6-sol", false, NOW)
    let text = ""
    for (const event of events) text += encoder.event(event)
    expect(text).toContain(`"type":"tool_use","id":"call_9","name":"Bash"`)
    expect(text).toContain(`"stop_reason":"tool_use"`)

    const answer = Answer.collect(events)
    expect(Answer.stop(answer)).toBe("ToolUse")
    const message = whole("messages", request, answer, "gpt-6-sol", NOW)
    expect(at(message, "content", 0, "input", "command")).toBe("ls")
  })

  /** Codex's freeform `apply_patch`, through a Chat-only provider and back as a freeform call. */
  it("freeform_tools_survive_chat", () => {
    const body = bytes(`{"model":"grok-4","instructions":"x","input":"patch it",
            "tools":[{"type":"custom","name":"apply_patch","description":"Patch"}],"stream":true}`)
    const request = ok(decode("responses", body))
    const upstream = encode("chat", request)
    expect(at(upstream, "tools", 0, "function", "name")).toBe("apply_patch")

    const decoder = Decoder.make("chat", request)
    const events: Array<Event> = []
    for (const data of [
      `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin Patch\\"}"}}]}}]}`,
      `{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
      "[DONE]",
    ]) {
      decoder.data(bytes(data), events)
    }
    const encoder = Encoder.make("responses", "grok-4", false, NOW)
    let text = ""
    for (const event of events) text += encoder.event(event)
    expect(text).toContain(`"type":"custom_tool_call"`)
    expect(text).toContain(`"input":"*** Begin Patch"`)
    expect(text).toContain("response.completed")
  })

  it("nothing_translates_into_messages", () => {
    expect(canTranslate("messages", "responses")).toBe(true)
    expect(canTranslate("chat", "responses")).toBe(true)
    expect(canTranslate("responses", "chat")).toBe(true)
    expect(canTranslate("chat", "messages")).toBe(false)
    expect(canTranslate("chat", "chat")).toBe(false)
  })

  /**
   * Codex compacting a conversation on a Chat-only model: the model is asked
   * for a summary, which comes back sealed in a compaction item and opens
   * into the next request's history.
   */
  it("compaction_is_emulated_with_a_summary", () => {
    const body = bytes(`{"model":"grok-4","instructions":"x","stream":true,
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"fix a.rs"}]},
                     {"type":"compaction_trigger"}]}`)
    const request = ok(decode("responses", body))
    expect(request.compact).toBe(true)
    const upstream = encode("chat", request)
    const last = array(at(upstream, "messages"))?.at(-1)
    expect(str(at(last, "content"))?.startsWith("Summarize")).toBe(true)

    const encoder = Encoder.forRequest("responses", request, "grok-4", false, NOW)
    let text = ""
    for (const event of [
      { _tag: "Text", text: "Fixed a.rs; " },
      { _tag: "Text", text: "tests pass." },
      { _tag: "Done", stop: "End", usage: Answer.make().usage },
    ] satisfies Array<Event>) {
      text += encoder.event(event)
    }
    const sealed = text.split('"encrypted_content":"')[1]?.split('"')[0] ?? ""
    expect(text).not.toContain("output_text")

    const next = `{"model":"grok-4","input":[{"type":"compaction","encrypted_content":"${sealed}"},
                {"type":"message","role":"user","content":[{"type":"input_text","text":"go on"}]}]}`
    const reread = ok(decode("responses", bytes(next)))
    const first = reread.messages[0]?.parts[0]
    if (first?._tag !== "Text") throw new Error("expected the summary first")
    expect(first.text.endsWith("Fixed a.rs; tests pass.")).toBe(true)
  })
})

describe("translate (contract details)", () => {
  it("upstream paths", () => {
    expect(path("messages")).toBe("/v1/messages")
    expect(path("responses")).toBe("/responses")
    expect(path("chat")).toBe("/chat/completions")
  })

  it("invalid JSON and a missing model are request errors", () => {
    const bad = decode("chat", bytes("{"))
    expect(Result.isFailure(bad) && bad.failure).toBeInstanceOf(RequestError)
    expect(Result.isFailure(bad) ? bad.failure.message : "").toBe(
      "the request is not valid JSON: EOF while parsing an object at line 1 column 1",
    )
    const missing = decode("responses", bytes("{}"))
    expect(Result.isFailure(missing) ? missing.failure._tag : "").toBe("RequestError")
    expect(Result.isFailure(missing) ? missing.failure.message : "").toBe("the request names no model")
  })

  it("encoding a compaction asks for a summary with tools switched off", () => {
    const request = Request.make({
      model: "m",
      compact: true,
      tools: [{ name: "f", description: "", schema: {}, kind: "Function" }],
    })
    const body = encode("responses", request)
    expect(at(body, "tool_choice")).toBe("none")
    expect(at(body, "input", 0, "content", 0, "text")).toStartWith("Summarize this conversation")
    expect(request.messages).toEqual([])
    // Messages is never a translation target, and the types say so.
    expectTypeOf<Target>().toEqualTypeOf<"responses" | "chat">()
  })

  it("a cut or unreadable upstream body ends in an error event", () => {
    const request = Request.make({ model: "m" })
    const responses: Array<Event> = []
    Decoder.make("responses", request).whole(bytes("{oops"), responses)
    expect(responses).toEqual([
      { _tag: "Error", failure: { status: 502, message: "the upstream stream ended before the response completed" } },
    ])
    const chat: Array<Event> = []
    const decoder = Decoder.make("chat", request)
    decoder.data(bytes("\f [DONE] \r\n"), chat)
    expect(chat).toEqual([
      { _tag: "Error", failure: { status: 502, message: "the upstream stream ended before the answer finished" } },
    ])
    decoder.finish(chat)
    expect(chat.length).toBe(1)
  })

  it("a whole Chat completion is one chunk, then the end", () => {
    const events: Array<Event> = []
    Decoder.make("chat", Request.make()).whole(
      bytes(`{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}`),
      events,
    )
    expect(events.map((e) => e._tag)).toEqual(["Text", "Done"])
  })

  it("whole answers use the compaction form for a compacting Codex request", () => {
    const answer = Answer.make({ text: "summary" })
    const compact = whole("responses", Request.make({ compact: true }), answer, "m", NOW)
    expect(at(compact, "output", 0, "type")).toBe("compaction")
    const plain = whole("responses", Request.make(), answer, "m", NOW)
    expect(at(plain, "output", 0, "type")).toBe("message")
  })
})
