import { describe, expect } from "bun:test"
import { Usage } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { chat, common } from "../../src/index.ts"
import { answer, context, framesOf, ok, written } from "../common/fixtures.ts"

const { Event } = common

const toolLoop = {
  model: "grok-4",
  messages: [
    { role: "system", content: "Be brief." },
    {
      role: "user",
      content: [
        { type: "text", text: "weather?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Oslo"}' } },
        { id: "call_2", type: "function", function: { name: "weather", arguments: '{"city":"Rome"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "rain" },
    { role: "tool", tool_call_id: "call_2", content: "sun" },
  ],
  tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
  tool_choice: "required",
  reasoning_effort: "low",
  stop: "END",
  stream: true,
  stream_options: { include_usage: true },
}

describe("Chat requests", () => {
  it("reads a tool loop: one system text, consecutive tool messages as one turn of results", () => {
    const request = ok(chat.decodeRequest(toolLoop))
    expect(request.system).toEqual(["Be brief."])
    expect(request.toolChoice).toEqual({ _tag: "Required" })
    expect(request.effort).toBe("low")
    expect(request.stop).toEqual(["END"])
    expect(request.includeUsage).toBe(true)
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(request.messages[2]?.parts.map((part) => part._tag)).toEqual(["Result", "Result"])
    expect(request.tools).toEqual([{ name: "weather", description: "", schema: { type: "object" }, kind: "function" }])
  })

  it("writes it back keys in order, results as tool messages, with usage asked for and no effort", () => {
    const body = chat.encodeRequest(ok(chat.decodeRequest(toolLoop)))
    expect(Object.keys(body)).toEqual(["model", "messages", "stream", "stream_options", "tools", "tool_choice", "stop"])
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "weather?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Oslo"}' } },
          { id: "call_2", type: "function", function: { name: "weather", arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "rain" },
      { role: "tool", tool_call_id: "call_2", content: "sun" },
    ])
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.tool_choice).toBe("required")
    expect("reasoning_effort" in body).toBe(false)
  })

  it("reads token limits, sampling, formats, files and named choices", () => {
    const request = ok(
      chat.decodeRequest({
        model: "m",
        max_tokens: 10,
        max_completion_tokens: 20,
        temperature: 0.2,
        top_p: 0.9,
        parallel_tool_calls: true,
        prompt_cache_key: "conv",
        stop: ["a", "b"],
        tool_choice: { type: "function", function: { name: "f" } },
        response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } },
        messages: [
          { role: "developer", content: [{ type: "text", text: "Rules." }] },
          { role: "user", content: "" },
          { role: "user", content: [{ type: "file", file: { file_data: "data:application/pdf;base64,JV" } }] },
          { role: "assistant", content: "ok", tool_calls: [{ id: "c", function: { name: "f" } }] },
        ],
      }),
    )
    expect(request).toMatchObject({
      maxTokens: 20,
      temperature: 0.2,
      topP: 0.9,
      parallelToolCalls: true,
      cacheKey: "conv",
      stop: ["a", "b"],
      toolChoice: { _tag: "Named", name: "f" },
      format: { name: "out", schema: { type: "object" }, strict: false },
      system: ["Rules."],
    })
    expect(request.messages).toEqual([
      {
        role: "user",
        parts: [
          {
            _tag: "File",
            media: { mediaType: "application/pdf", source: { _tag: "Inline", data: "JV" }, name: undefined },
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          { _tag: "Text", text: "ok" },
          { _tag: "Call", id: "c", name: "f", input: "{}", kind: "function" },
        ],
      },
    ])
  })

  it("sends freeform calls as functions taking {input}", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      tools: [{ name: "apply_patch", description: "Patch files", schema: null, kind: "freeform" }],
      messages: [
        {
          role: "assistant",
          parts: [{ _tag: "Call", id: "c", name: "apply_patch", input: "*** Begin Patch", kind: "freeform" }],
        },
      ],
    }
    const body = chat.encodeRequest(request)
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "apply_patch", description: "Patch files", parameters: common.freeformSchema },
      },
    ])
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } },
        ],
      },
    ])
  })

  it("sends a lone text as a plain string, result images before the user's own parts, and errors marked", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      maxTokens: 9,
      temperature: 1,
      topP: 0.5,
      parallelToolCalls: false,
      tools: [{ name: "f", description: "", schema: {}, kind: "function" }],
      toolChoice: { _tag: "Named", name: "f" },
      format: { name: "o", schema: {}, strict: true },
      messages: [
        { role: "user", parts: [{ _tag: "Text", text: "hi" }] },
        {
          role: "user",
          parts: [
            {
              _tag: "Result",
              callId: "c",
              isError: true,
              content: [
                { _tag: "Text", text: "boom" },
                { _tag: "Image", media: common.mediaFromUrl("https://x.dev/a.png") },
              ],
            },
            { _tag: "Text", text: "look" },
          ],
        },
      ],
    }
    const body = chat.encodeRequest(request)
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "c", content: "Error: boom" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://x.dev/a.png" } },
          { type: "text", text: "look" },
        ],
      },
    ])
    expect(Object.keys(body).slice(4)).toEqual([
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "max_tokens",
      "temperature",
      "top_p",
      "response_format",
    ])
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "f" } })
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "o", schema: {}, strict: true } })
  })
})

const chunk = (delta: unknown, finish: string | null = null) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const readAll = (reader: chat.ChatReader, chunks: ReadonlyArray<unknown>): Array<common.Event> => {
  const out: Array<common.Event> = []
  for (const one of chunks) reader.event(one, out)
  reader.finish(out)
  return out
}

describe("ChatReader", () => {
  it("gathers interleaved tool calls by index and unwraps the freeform ones", () => {
    const reader = new chat.ChatReader(new Set(["apply_patch"]), () => "x")
    const out = readAll(reader, [
      chunk({ role: "assistant", content: "On it." }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: '{"cmd"' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "apply_patch", arguments: '{"input":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"*** Begin"}' } }] }),
      chunk({}, "tool_calls"),
      {
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      },
    ])
    expect(out).toEqual([
      Event.Text({ text: "On it." }),
      Event.Call({ call: { id: "call_a", name: "shell", input: '{"cmd":"ls"}', kind: "function" } }),
      Event.Call({ call: { id: "call_b", name: "apply_patch", input: "*** Begin", kind: "freeform" } }),
      Event.Done({
        stop: "toolUse",
        usage: new Usage({ requests: 1, input: 10, output: 20, cacheRead: 40, cacheWrite: 0 }),
      }),
    ])
  })

  it("reads reasoning in either field, gives calls without an id one, and reads a whole completion", () => {
    const reader = new chat.ChatReader(new Set(), () => "tok")
    const out: Array<common.Event> = []
    reader.document(
      {
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "42",
              reasoning_content: "Think",
              reasoning: "More",
              tool_calls: [{ function: { name: "f", arguments: "{}" } }],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
      out,
    )
    expect(out).toEqual([
      Event.Reasoning({ text: "Think" }),
      Event.Reasoning({ text: "More" }),
      Event.Text({ text: "42" }),
      Event.Call({ call: { id: "call_tok", name: "f", input: "{}", kind: "function" } }),
      Event.Done({
        stop: "length",
        usage: new Usage({ requests: 1, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }),
      }),
    ])
  })

  it("maps finish reasons to stops, and counts one request when no usage came", () => {
    const stops = ["stop", "length", "tool_calls", "function_call", "content_filter", "other"].map((finish) => {
      const [done] = readAll(new chat.ChatReader(new Set(), () => "x"), [chunk({}, finish)])
      return done?._tag === "Done" ? [done.stop, done.usage.requests] : undefined
    })
    expect(stops).toEqual([
      ["end", 1],
      ["length", 1],
      ["toolUse", 1],
      ["toolUse", 1],
      ["filtered", 1],
      ["end", 1],
    ])
  })

  it("turns an error chunk into a failure with its status, and a stream with no finish into a 502", () => {
    const failed = readAll(new chat.ChatReader(new Set(), () => "x"), [
      { error: { message: "overloaded", code: 503 } },
      chunk({ content: "late" }),
    ])
    expect(failed).toEqual([Event.Failed({ failure: { status: 503, message: "overloaded" } })])
    const odd = readAll(new chat.ChatReader(new Set(), () => "x"), [{ error: "bad", choices: [] }])
    expect(odd).toEqual([Event.Failed({ failure: { status: 500, message: "the upstream answer failed" } })])
    const cut = readAll(new chat.ChatReader(new Set(), () => "x"), [chunk({ content: "Hi" })])
    expect(cut.at(-1)).toEqual(
      Event.Failed({ failure: { status: 502, message: "the upstream stream ended before the answer finished" } }),
    )
  })
})

describe("ChatWriter", () => {
  const usage = new Usage({ requests: 1, input: 2, output: 3, cacheRead: 8, cacheWrite: 0 })

  it("streams a role chunk, text, calls, the finish, the usage chunk and [DONE]", () => {
    const out = written(new chat.ChatWriter(context(), true), [
      Event.Text({ text: "Hi" }),
      Event.Reasoning({ text: "hm" }),
      Event.Call({ call: { id: "call_1", name: "f", input: "{}", kind: "function" } }),
      Event.Done({ stop: "end", usage }),
    ])
    const frames = framesOf(out)
    expect(frames.every((frame) => frame.event === undefined)).toBe(true)
    expect(frames.at(-1)?.data).toBe("[DONE]")
    expect(frames[0]?.data).toEqual({
      id: "chatcmpl-t1",
      object: "chat.completion.chunk",
      created: 1793404800,
      model: "gpt-6-sol",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })
    expect(frames.slice(1, 5).map((frame) => frame.data)).toMatchObject([
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { reasoning_content: "hm" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" }, index: 0 }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])
    expect(frames[5]?.data).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 8 } },
    })
  })

  it("writes a usage chunk only when the client asked for one", () => {
    const out = written(new chat.ChatWriter(context(), false), [Event.Done({ stop: "end", usage })])
    expect(out).not.toContain("usage")
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  it("turns a failure into an error chunk with its kind and status, then [DONE]", () => {
    const writer = new chat.ChatWriter(context(), false)
    const frames = framesOf(written(writer, [Event.Failed({ failure: { status: 429, message: "slow" } })]))
    expect(frames.slice(1).map((frame) => frame.data)).toEqual([
      { error: { message: "slow", type: "rate_limit_error", code: 429 } },
      "[DONE]",
    ])
    expect(writer.write(Event.Text({ text: "late" }))).toBe("")
  })
})

describe("whole Chat answers", () => {
  it("carry the content, reasoning, calls, the finish reason and usage", () => {
    const completion = chat.whole(
      answer({
        text: "Hello",
        reasoning: "Greet",
        calls: [{ id: "c", name: "apply_patch", input: "x", kind: "freeform" }],
        usage: new Usage({ requests: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
      }),
      context("m"),
    )
    expect(completion).toEqual({
      id: "chatcmpl-t1",
      object: "chat.completion",
      created: 1793404800,
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello",
            reasoning_content: "Greet",
            tool_calls: [{ id: "c", type: "function", function: { name: "apply_patch", arguments: '{"input":"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } },
    })
  })

  it("say stop for an ended answer, with null content when there was no text", () => {
    const completion = chat.whole(answer({ stop: "sequence" }), context())
    expect(completion.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null },
      finish_reason: "stop",
    })
    expect(chat.whole(answer({ text: "x", stop: "filtered" }), context()).choices[0]?.finish_reason).toBe(
      "content_filter",
    )
  })
})
