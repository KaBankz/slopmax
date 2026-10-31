import { describe, expect } from "bun:test"
import type { Dialect } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Result } from "effect"
import {
  canTranslate,
  collect,
  common,
  Compaction,
  decodeRequest,
  encodeRequest,
  formats,
  paths,
  readAnswer,
  stopOf,
  wholeReply,
} from "../../src/index.ts"
import { answer, bytes, context, framesOf, ok, written } from "../common/fixtures.ts"

const { Event } = common

describe("canTranslate", () => {
  it("translates into Responses or Chat from any other format, and never into Messages", () => {
    expect(canTranslate("messages", "responses")).toBe(true)
    expect(canTranslate("chat", "responses")).toBe(true)
    expect(canTranslate("responses", "chat")).toBe(true)
    expect(canTranslate("messages", "chat")).toBe(true)
    expect(canTranslate("chat", "messages")).toBe(false)
    expect(canTranslate("responses", "messages")).toBe(false)
    expect(canTranslate("chat", "chat")).toBe(false)
  })

  it("sends each format's requests to its own path", () => {
    expect(paths).toEqual({ messages: "/v1/messages", responses: "/responses", chat: "/chat/completions" })
  })
})

describe("decodeRequest", () => {
  it("refuses a body that is not JSON, saying so", () => {
    const refused = decodeRequest("messages", bytes("{not json"))
    expect(Result.isFailure(refused)).toBe(true)
    if (Result.isFailure(refused)) {
      expect(refused.failure._tag).toBe("RequestInvalid")
      expect(refused.failure.message).toStartWith("the request is not valid JSON: ")
    }
  })

  it("reads each format's body by that format's rules", () => {
    const dialects: ReadonlyArray<Dialect> = ["messages", "responses", "chat"]
    for (const dialect of dialects) {
      expect(ok(decodeRequest(dialect, bytes('{"model":"m"}'))).model).toBe("m")
      const missing = decodeRequest(dialect, bytes("{}"))
      expect(Result.isFailure(missing) && missing.failure.message).toBe("the request names no model")
    }
  })
})

describe("translation", () => {
  it("takes Claude Code through a Responses upstream and back, a tool call and all", () => {
    const body = bytes(
      JSON.stringify({
        model: "gpt-6-sol",
        max_tokens: 1000,
        stream: true,
        system: "You are Claude Code.",
        messages: [{ role: "user", content: "list files" }],
        tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }],
      }),
    )
    const request = ok(decodeRequest("messages", body))
    const upstream = encodeRequest("responses", request)
    expect(upstream).toMatchObject({
      instructions: "You are Claude Code.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }],
      tools: [{ name: "Bash" }],
      max_output_tokens: 1000,
    })

    const reader = formats.responses.reader(request, () => "x")
    const events: Array<common.Event> = []
    for (const data of [
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_9", name: "Bash", arguments: '{"command":"ls"}' },
      },
      { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
    ]) {
      reader.event(data, events)
    }
    const told = written(formats.messages.writer(request, context()), events)
    expect(told).toContain('"type":"tool_use","id":"call_9","name":"Bash"')
    expect(told).toContain('"stop_reason":"tool_use"')

    const gathered = collect(events)
    expect(stopOf(gathered)).toBe("toolUse")
    const reply = wholeReply("messages", request, gathered, context())
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ content: [{ type: "tool_use", input: { command: "ls" } }] })
  })

  it("keeps Codex's freeform apply_patch freeform through a Chat-only upstream", () => {
    const request = ok(
      decodeRequest(
        "responses",
        bytes(
          JSON.stringify({
            model: "grok-4",
            instructions: "x",
            input: "patch it",
            tools: [{ type: "custom", name: "apply_patch", description: "Patch" }],
            stream: true,
          }),
        ),
      ),
    )
    const upstream = encodeRequest("chat", request)
    expect(upstream.tools).toEqual([
      { type: "function", function: { name: "apply_patch", description: "Patch", parameters: common.freeformSchema } },
    ])
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin Patch\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
    const events = readAnswer("chat", bytes(stream), { request, document: false, token: () => "x" })
    const told = written(formats.responses.writer(request, context("grok-4")), events)
    expect(told).toContain('"type":"custom_tool_call"')
    expect(told).toContain('"input":"*** Begin Patch"')
    expect(told).toContain("response.completed")
  })

  it("emulates Codex's compaction with a summary that is sealed, then opened on the next request", () => {
    const request = ok(
      decodeRequest(
        "responses",
        bytes(
          JSON.stringify({
            model: "grok-4",
            instructions: "x",
            stream: true,
            tools: [{ type: "function", name: "shell" }],
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "fix a.rs" }] },
              { type: "compaction_trigger" },
            ],
          }),
        ),
      ),
    )
    expect(request.compact).toBe(true)
    const upstream = encodeRequest("chat", request)
    expect(Array.isArray(upstream.messages) ? upstream.messages.at(-1) : undefined).toEqual({
      role: "user",
      content: Compaction.prompt,
    })
    expect(upstream.tool_choice).toBe("none")

    const told = written(formats.responses.writer(request, context("grok-4")), [
      Event.Text({ text: "Fixed a.rs; " }),
      Event.Text({ text: "tests pass." }),
      Event.Done({ stop: "end", usage: answer({}).usage }),
    ])
    expect(told).not.toContain("output_text")
    const sealed = framesOf(told)
      .map((frame) => JSON.stringify(frame.data))
      .join("")
      .match(/"encrypted_content":"([^"]+)"/)?.[1]
    expect(sealed).toBeDefined()

    const next = ok(
      decodeRequest(
        "responses",
        bytes(
          JSON.stringify({
            model: "grok-4",
            input: [
              { type: "compaction", encrypted_content: sealed },
              { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
            ],
          }),
        ),
      ),
    )
    const [summary] = next.messages[0]?.parts ?? []
    expect(summary?._tag === "Text" && summary.text).toBe(`${Compaction.prefix}\n\nFixed a.rs; tests pass.`)
    expect(wholeReply("responses", request, answer({ text: "S." }), context()).body).toMatchObject({
      output: [{ type: "compaction", encrypted_content: Compaction.seal("S.") }],
    })
  })

  it("answers a whole request that only failed with the failure's status, in the client's format", () => {
    const failed = answer({ failure: { status: 429, message: "spent" } })
    const request = common.emptyRequest("m")
    expect(wholeReply("messages", request, failed, context())).toEqual({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "spent" } },
    })
    expect(wholeReply("chat", request, failed, context())).toEqual({
      status: 429,
      body: { error: { type: "rate_limit_error", message: "spent" } },
    })
    // Something said before the failure is still an answer.
    expect(wholeReply("chat", request, { ...failed, text: "partial" }, context()).status).toBe(200)
  })
})
