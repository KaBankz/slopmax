import { describe, expect } from "bun:test"
import { Usage } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { common, Compaction, responses } from "../../src/index.ts"
import { answer, context, framesOf, ok, written } from "../common/fixtures.ts"

const { Event } = common

const codexBody = {
  model: "gpt-6-sol",
  instructions: "You are Codex.",
  input: [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Sandbox: workspace-write" }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: "gAAA" },
    { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["ls"]}' },
    { type: "function_call_output", call_id: "c1", output: "a.rs" },
    { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** Begin Patch" },
    { type: "custom_tool_call_output", call_id: "c2", output: "Done" },
    { type: "web_search_call", id: "ws_1" },
  ],
  tools: [
    { type: "function", name: "shell", description: "Run", parameters: { type: "object" } },
    { type: "custom", name: "apply_patch", description: "Patch", format: { type: "grammar" } },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "high", summary: "auto" },
  store: false,
  stream: true,
  prompt_cache_key: "conv-1",
}

describe("Responses requests", () => {
  it("reads Codex's items into turns: developer text as system, calls with their kinds, reasoning with its state", () => {
    const request = ok(responses.decodeRequest(codexBody))
    expect(request.system).toEqual(["You are Codex.", "Sandbox: workspace-write"])
    expect(request.effort).toBe("high")
    expect(request.cacheKey).toBe("conv-1")
    expect(request.parallelToolCalls).toBe(false)
    expect(request.stream).toBe(true)
    expect(request.tools.map((tool) => tool.kind)).toEqual(["function", "freeform"])
    expect(request.tools[1]?.schema).toEqual({ type: "object", properties: {} })
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
    expect(request.messages[1]?.parts).toEqual([
      { _tag: "Reasoning", text: "Plan", opaque: "gAAA" },
      { _tag: "Call", id: "c1", name: "shell", input: '{"command":["ls"]}', kind: "function" },
    ])
    expect(request.messages[3]?.parts[0]).toEqual({
      _tag: "Call",
      id: "c2",
      name: "apply_patch",
      input: "*** Begin Patch",
      kind: "freeform",
    })
  })

  it("reads a plain string input as one user turn, and an item with no type as a message", () => {
    const request = ok(
      responses.decodeRequest({
        model: "m",
        input: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "output_text", text: "yo" }] },
        ],
        tool_choice: { type: "function", name: "shell" },
        text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } },
        max_output_tokens: 100,
      }),
    )
    expect(request.messages).toEqual([
      { role: "user", parts: [{ _tag: "Text", text: "hi" }] },
      { role: "assistant", parts: [{ _tag: "Text", text: "yo" }] },
    ])
    expect(request.toolChoice).toEqual({ _tag: "Named", name: "shell" })
    expect(request.format).toEqual({ name: "out", schema: { type: "object" }, strict: true })
    expect(request.maxTokens).toBe(100)
    expect(ok(responses.decodeRequest({ model: "m", input: "hello" })).messages).toEqual([
      { role: "user", parts: [{ _tag: "Text", text: "hello" }] },
    ])
  })

  it("starts a new turn for text that follows a call, and reads images, files and refusals", () => {
    const request = ok(
      responses.decodeRequest({
        model: "m",
        input: [
          { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
          { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,iV" },
              { type: "input_file", file_data: "data:application/pdf;base64,JV", filename: "a.pdf" },
              { type: "input_text", text: "" },
            ],
          },
        ],
      }),
    )
    expect(request.messages.map((message) => message.parts.map((part) => part._tag))).toEqual([
      ["Call"],
      ["Text"],
      ["Image", "File"],
    ])
    expect(request.messages[2]?.parts[1]).toEqual({
      _tag: "File",
      media: { mediaType: "application/pdf", source: { _tag: "Inline", data: "JV" }, name: "a.pdf" },
    })
  })

  it("asks for compaction on a trigger, and opens only the summaries slopmax sealed", () => {
    const request = ok(
      responses.decodeRequest({
        model: "m",
        input: [
          { type: "compaction", encrypted_content: "gAAAAABopenai" },
          { type: "compaction", encrypted_content: Compaction.seal("Fixed a.rs.") },
          { type: "compaction_trigger" },
        ],
      }),
    )
    expect(request.compact).toBe(true)
    expect(request.messages).toEqual([
      { role: "user", parts: [{ _tag: "Text", text: `${Compaction.prefix}\n\nFixed a.rs.` }] },
    ])
  })

  it("writes turns as items, keys in order: results by their call's kind, images after, effort and cache key", () => {
    const decoded = ok(responses.decodeRequest(codexBody))
    const [first, ...rest] = decoded.messages
    const image: common.Part = { _tag: "Image", media: common.mediaFromUrl("data:image/png;base64,iVBOR") }
    const request: common.Request = {
      ...decoded,
      maxTokens: 500,
      messages: [{ role: "user", parts: [...(first?.parts ?? []), image] }, ...rest],
    }
    const body = responses.encodeRequest(request)
    expect(Object.keys(body)).toEqual([
      "model",
      "instructions",
      "input",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "store",
      "stream",
      "include",
      "prompt_cache_key",
      "max_output_tokens",
    ])
    expect(body.instructions).toBe("You are Codex.\n\nSandbox: workspace-write")
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "fix it" },
          { type: "input_image", image_url: "data:image/png;base64,iVBOR" },
        ],
      },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: "gAAA" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["ls"]}' },
      { type: "function_call_output", call_id: "c1", output: "a.rs" },
      { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "c2", output: "Done" },
    ])
    expect(body.tools).toEqual([
      { type: "function", name: "shell", description: "Run", parameters: { type: "object" }, strict: false },
      { type: "function", name: "apply_patch", description: "Patch", parameters: common.freeformSchema, strict: false },
    ])
  })

  it("never replays reasoning another provider wrote, and sends the most effort as xhigh", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      effort: "max",
      messages: [
        {
          role: "assistant",
          parts: [
            { _tag: "Reasoning", text: "summary only", opaque: undefined },
            { _tag: "Text", text: "Hi" },
          ],
        },
      ],
    }
    const body = responses.encodeRequest(request)
    expect(body.input).toEqual([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }])
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" })
    expect("tools" in body).toBe(false)
  })

  it("sends a result's error and the images a tool returned, and files with a default name", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      toolChoice: { _tag: "Named", name: "f" },
      tools: [{ name: "f", description: "", schema: {}, kind: "function" }],
      format: { name: "out", schema: { type: "object" }, strict: false },
      messages: [
        {
          role: "user",
          parts: [
            {
              _tag: "Result",
              callId: "c",
              isError: true,
              content: [
                { _tag: "Text", text: "boom" },
                { _tag: "Image", media: common.mediaFromUrl("https://x.dev/shot.png") },
              ],
            },
            { _tag: "File", media: common.mediaFromUrl("data:application/pdf;base64,JV") },
          ],
        },
      ],
    }
    const body = responses.encodeRequest(request)
    expect(body.input).toEqual([
      { type: "function_call_output", call_id: "c", output: "Error: boom" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,JV" }],
      },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x.dev/shot.png" }] },
    ])
    expect(body.tool_choice).toEqual({ type: "function", name: "f" })
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: false },
    })
  })
})

const read = (events: ReadonlyArray<unknown>): Array<common.Event> => {
  const reader = new responses.ResponsesReader()
  const out: Array<common.Event> = []
  for (const event of events) reader.event(event, out)
  reader.finish(out)
  return out
}

describe("ResponsesReader", () => {
  it("reads text, reasoning parts, reasoning state and calls, then the end with cached input apart", () => {
    const events = read([
      { type: "response.created", response: { id: "r" } },
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Plan A" },
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Plan B" },
      { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "gAAA" } },
      { type: "response.output_text.delta", item_id: "m1", delta: "Hi" },
      {
        type: "response.output_item.done",
        item: { type: "message", id: "m1", content: [{ type: "output_text", text: "Hi" }] },
      },
      {
        type: "response.output_item.done",
        item: { type: "message", id: "m2", content: [{ type: "output_text", text: "Whole" }] },
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 7,
            total_tokens: 107,
          },
        },
      },
    ])
    expect(events).toEqual([
      Event.Reasoning({ text: "Plan A" }),
      Event.Reasoning({ text: "\n\n" }),
      Event.Reasoning({ text: "Plan B" }),
      Event.State({ state: "gAAA" }),
      Event.Text({ text: "Hi" }),
      Event.Text({ text: "Whole" }),
      Event.Call({ call: { id: "c1", name: "Bash", input: "{}", kind: "function" } }),
      Event.Done({
        stop: "end",
        usage: new Usage({ requests: 1, input: 20, output: 7, cacheRead: 80, cacheWrite: 0 }),
      }),
    ])
  })

  it("turns a failure into an error with the status its code means, and a cut stream into a 502", () => {
    const failed = read([
      { type: "response.failed", response: { error: { code: "server_is_overloaded", message: "busy" } } },
    ])
    expect(failed).toEqual([Event.Failed({ failure: { status: 529, message: "busy" } })])
    const statuses = ["usage_limit_reached", "rate_limit_exceeded", "context_length_exceeded", "mystery"].map(
      (code) => read([{ type: "error", error: { code } }])[0],
    )
    expect(statuses).toEqual([
      Event.Failed({ failure: { status: 429, message: "the upstream response failed" } }),
      Event.Failed({ failure: { status: 429, message: "the upstream response failed" } }),
      Event.Failed({ failure: { status: 400, message: "the upstream response failed" } }),
      Event.Failed({ failure: { status: 500, message: "the upstream response failed" } }),
    ])
    const cut = read([{ type: "response.output_text.delta", delta: "Hi" }])
    expect(cut.at(-1)).toEqual(
      Event.Failed({ failure: { status: 502, message: "the upstream stream ended before the response completed" } }),
    )
  })

  it("reads a whole response's items and its length stop, or its error alone", () => {
    const reader = new responses.ResponsesReader()
    const out: Array<common.Event> = []
    reader.document(
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", id: "m", content: [{ type: "output_text", text: "Partial" }] }],
        usage: { input_tokens: 5, output_tokens: 9 },
      },
      out,
    )
    expect(out).toEqual([
      Event.Text({ text: "Partial" }),
      Event.Done({
        stop: "length",
        usage: new Usage({ requests: 1, input: 5, output: 9, cacheRead: 0, cacheWrite: 0 }),
      }),
    ])
    const failed: Array<common.Event> = []
    new responses.ResponsesReader().document({ error: { code: "invalid_prompt", message: "no" }, output: [] }, failed)
    expect(failed).toEqual([Event.Failed({ failure: { status: 400, message: "no" } })])
  })

  it("reads nothing after the answer ended", () => {
    const events = read([
      { type: "response.completed", response: {} },
      { type: "response.output_text.delta", delta: "late" },
    ])
    expect(events.map((event) => event._tag)).toEqual(["Done"])
  })
})

const payloads = (out: string): Array<Record<string, unknown>> =>
  framesOf(out).flatMap((frame) =>
    typeof frame.data === "object" && frame.data !== null && !Array.isArray(frame.data)
      ? [Object.fromEntries(Object.entries(frame.data))]
      : [],
  )

const usage = new Usage({ requests: 1, input: 10, output: 5, cacheRead: 30, cacheWrite: 0 })

describe("ResponsesWriter", () => {
  it("streams items Codex can rebuild its history from, each frame named and numbered from zero", () => {
    const out = written(new responses.ResponsesWriter(context("grok-4")), [
      Event.Reasoning({ text: "Thinking" }),
      Event.Text({ text: "Patching." }),
      Event.Call({ call: { id: "call_7", name: "apply_patch", input: "*** Begin Patch", kind: "freeform" } }),
      Event.Done({ stop: "toolUse", usage }),
    ])
    const frames = framesOf(out)
    const events = payloads(out)
    expect(frames.every((frame, index) => frame.event === events[index]?.type)).toBe(true)
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index))
    expect(events.slice(0, 2).map((event) => event.type)).toEqual(["response.created", "response.in_progress"])
    expect(events[0]?.response).toEqual({
      id: "resp_t1",
      object: "response",
      created_at: 1793404800,
      status: "in_progress",
      model: "grok-4",
      output: [],
    })
    const done = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item)
    expect(done).toEqual([
      { id: "rs_t2", type: "reasoning", summary: [{ type: "summary_text", text: "Thinking" }] },
      {
        id: "msg_t3",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Patching.", annotations: [] }],
      },
      {
        id: "ctc_t4",
        type: "custom_tool_call",
        status: "completed",
        call_id: "call_7",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
    ])
    expect(events.map((event) => event.type)).toContain("response.custom_tool_call_input.delta")
    const completed = events.at(-1)
    expect(completed?.type).toBe("response.completed")
    expect(completed?.response).toMatchObject({
      status: "completed",
      output: done,
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 45,
      },
    })
    // The payload's own keys come first, then the frame's type and number.
    expect(Object.keys(events[2] ?? {})).toEqual(["output_index", "item", "type", "sequence_number"])
  })

  it("streams function calls with their arguments, and says incomplete when the answer hit its length", () => {
    const out = written(new responses.ResponsesWriter(context()), [
      Event.Call({ call: { id: "c", name: "shell", input: '{"cmd":"ls"}', kind: "function" } }),
      Event.Done({ stop: "length", usage }),
    ])
    const events = payloads(out)
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.incomplete",
    ])
    expect(events[2]?.item).toMatchObject({ type: "function_call", status: "in_progress", arguments: '{"cmd":"ls"}' })
    expect(events[4]?.arguments).toBe('{"cmd":"ls"}')
    expect(events.at(-1)?.response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
  })

  it("fails the response with the code its status means", () => {
    const writer = new responses.ResponsesWriter(context("m"))
    const out = writer.write(Event.Failed({ failure: { status: 429, message: "slow down" } }))
    const last = payloads(out).at(-1)
    expect(last?.type).toBe("response.failed")
    expect(last?.response).toMatchObject({
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "slow down" },
    })
    expect(writer.write(Event.Text({ text: "late" }))).toBe("")
    const codes = [503, 400, 500].map(
      (status) =>
        payloads(
          new responses.ResponsesWriter(context()).write(Event.Failed({ failure: { status, message: "x" } })),
        ).at(-1)?.response,
    )
    expect(codes.map((response) => JSON.stringify(response))).toEqual([
      expect.stringContaining('"code":"server_is_overloaded"'),
      expect.stringContaining('"code":"invalid_request_error"'),
      expect.stringContaining('"code":"server_error"'),
    ])
  })

  it("compacting, gathers the text into one sealed compaction item and drops the rest", () => {
    const out = written(new responses.ResponsesWriter(context(), true), [
      Event.Reasoning({ text: "hmm" }),
      Event.Text({ text: "Fixed a.rs; " }),
      Event.Call({ call: { id: "c", name: "f", input: "{}", kind: "function" } }),
      Event.Text({ text: "tests pass." }),
      Event.Done({ stop: "end", usage }),
    ])
    const events = payloads(out)
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ])
    const item = events[3]?.item
    expect(item).toEqual({
      id: "cmp_t2",
      type: "compaction",
      encrypted_content: Compaction.seal("Fixed a.rs; tests pass."),
    })
    expect(out).not.toContain("output_text")
    const failed = written(new responses.ResponsesWriter(context(), true), [
      Event.Failed({ failure: { status: 500, message: "x" } }),
    ])
    expect(payloads(failed).at(-1)?.type).toBe("response.failed")
  })
})

describe("whole Responses answers", () => {
  it("hold the reasoning, text and calls as finished items, completed with usage", () => {
    const response = responses.whole(
      answer({
        text: "Hello",
        reasoning: "Greet",
        calls: [{ id: "c", name: "f", input: "{}", kind: "function" }],
        usage,
      }),
      context("m"),
    )
    expect(response).toMatchObject({ object: "response", status: "completed", model: "m" })
    expect(response.output).toEqual([
      { id: "rs_t2", type: "reasoning", summary: [{ type: "summary_text", text: "Greet" }] },
      {
        id: "msg_t3",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
      { id: "fc_t4", type: "function_call", status: "completed", call_id: "c", name: "f", arguments: "{}" },
    ])
    expect(response.usage.total_tokens).toBe(45)
  })

  it("are incomplete when the answer hit its length", () => {
    expect(responses.whole(answer({ text: "x", stop: "length" }), context())).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
  })

  it("for compaction, are a completed response holding one sealed compaction item", () => {
    const response = responses.compacted(answer({ text: "Summary." }), context())
    expect(response.status).toBe("completed")
    expect(response.output).toEqual([
      { id: "cmp_t2", type: "compaction", encrypted_content: Compaction.seal("Summary.") },
    ])
  })
})
