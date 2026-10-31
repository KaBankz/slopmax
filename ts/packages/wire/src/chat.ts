// The Chat Completions format: what most OpenAI-style tools speak, and what
// xAI, local servers and most gateways answer.
//
// It is both sides of a translation. Chat has no freeform tools: a freeform
// tool (Codex's `apply_patch`) travels as a function taking `{"input": …}`,
// and its calls are unwrapped again on the way back.
import { Usage } from "@slopmax/domain"
import { DateTime, Result, Schema } from "effect"
import { type Answer, stopOf } from "./collect.ts"
import {
  anyJson,
  type AnswerReader,
  type AnswerWriter,
  callArguments,
  Count,
  effortNamed,
  emptyRequest,
  Event,
  field,
  freeformNames,
  freeformSchema,
  listOf,
  mediaFromUrl,
  mediaUrl,
  type Message,
  type Part,
  type ReplyContext,
  type Request,
  RequestInvalid,
  resultOutput,
  type Stop,
  type Tool,
  type ToolCall,
  type ToolChoice,
  unwrapFreeform,
} from "./common.ts"
import { failureKind } from "./errors.ts"
import { frame } from "./lines.ts"

// --- The request, as a Chat client sends it ------------------------------------

const ContentPart = Schema.Struct({
  type: field(Schema.String),
  text: field(Schema.String),
  image_url: field(Schema.Struct({ url: field(Schema.String) })),
  file: field(Schema.Struct({ file_data: field(Schema.String), filename: field(Schema.String) })),
})
type ContentPart = typeof ContentPart.Type

const Content = Schema.Union([Schema.String, listOf(ContentPart)])
type Content = typeof Content.Type

const ChatMessage = Schema.Struct({
  role: field(Schema.String),
  content: field(Content),
  tool_call_id: field(Schema.String),
  tool_calls: field(
    listOf(
      Schema.Struct({
        id: field(Schema.String),
        function: field(Schema.Struct({ name: field(Schema.String), arguments: field(Schema.String) })),
      }),
    ),
  ),
})

/** A Chat Completions request: only the fields translation carries, each read leniently. */
export const ChatRequest = Schema.Struct({
  model: field(Schema.String),
  stream: field(Schema.Boolean),
  stream_options: field(Schema.Struct({ include_usage: field(Schema.Boolean) })),
  max_completion_tokens: field(Count),
  max_tokens: field(Count),
  temperature: field(Schema.Finite),
  top_p: field(Schema.Finite),
  parallel_tool_calls: field(Schema.Boolean),
  reasoning_effort: field(Schema.String),
  prompt_cache_key: field(Schema.String),
  stop: field(Schema.Union([Schema.String, listOf(Schema.String)])),
  messages: field(listOf(ChatMessage)),
  tools: field(
    listOf(
      Schema.Struct({
        function: Schema.Struct({
          name: field(Schema.String),
          description: field(Schema.String),
          parameters: anyJson,
        }),
      }),
    ),
  ),
  tool_choice: field(
    Schema.Union([Schema.String, Schema.Struct({ function: field(Schema.Struct({ name: field(Schema.String) })) })]),
  ),
  response_format: field(
    Schema.Struct({
      json_schema: field(Schema.Struct({ name: field(Schema.String), schema: anyJson, strict: field(Schema.Boolean) })),
    }),
  ),
})
export type ChatRequest = typeof ChatRequest.Type

const readRequest = Schema.decodeUnknownResult(ChatRequest)

const contentPart = (part: ContentPart): Part | undefined => {
  switch (part.type) {
    case "text":
      return part.text === undefined || part.text.length === 0 ? undefined : { _tag: "Text", text: part.text }
    case "image_url":
      return part.image_url?.url === undefined ? undefined : { _tag: "Image", media: mediaFromUrl(part.image_url.url) }
    case "file":
      return part.file?.file_data === undefined
        ? undefined
        : { _tag: "File", media: mediaFromUrl(part.file.file_data, part.file.filename) }
    default:
      return undefined
  }
}

const parts = (content: Content | undefined): Array<Part> => {
  if (content === undefined) return []
  if (typeof content === "string") return content.length === 0 ? [] : [{ _tag: "Text", text: content }]
  return content.flatMap((part) => {
    const read = contentPart(part)
    return read === undefined ? [] : [read]
  })
}

const text = (content: Content | undefined): string =>
  content === undefined
    ? ""
    : typeof content === "string"
      ? content
      : content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n")

const toolChoice = (choice: ChatRequest["tool_choice"]): ToolChoice => {
  if (typeof choice === "string") {
    return choice === "none" ? { _tag: "None" } : choice === "required" ? { _tag: "Required" } : { _tag: "Auto" }
  }
  const name = choice?.function?.name
  return name === undefined ? { _tag: "Auto" } : { _tag: "Named", name }
}

/** Reads a Chat Completions request (already parsed JSON) into the common form. */
export const decodeRequest = (json: unknown): Result.Result<Request, RequestInvalid> => {
  const read = readRequest(json)
  if (read._tag === "Failure") return Result.fail(new RequestInvalid({ message: "the request is not a JSON object" }))
  const body = read.success
  if (body.model === undefined) return Result.fail(new RequestInvalid({ message: "the request names no model" }))

  const system: Array<string> = []
  const messages: Array<{ readonly role: Message["role"]; readonly parts: Array<Part> }> = []
  const push = (role: Message["role"], held: Array<Part>): void => {
    if (held.length > 0) messages.push({ role, parts: held })
  }
  for (const message of body.messages ?? []) {
    switch (message.role ?? "user") {
      case "system":
      case "developer": {
        const said = text(message.content)
        if (said.trim().length > 0) system.push(said)
        break
      }
      case "assistant": {
        const held = parts(message.content)
        for (const call of message.tool_calls ?? []) {
          held.push({
            _tag: "Call",
            id: call.id ?? "",
            name: call.function?.name ?? "",
            input: call.function?.arguments ?? "{}",
            kind: "function",
          })
        }
        push("assistant", held)
        break
      }
      case "tool": {
        const content = parts(message.content).flatMap((part) =>
          part._tag === "Text" || part._tag === "Image" ? [part] : [],
        )
        const result: Part = { _tag: "Result", callId: message.tool_call_id ?? "", content, isError: false }
        // Consecutive results answer one turn.
        const last = messages.at(-1)
        if (last?.role === "user" && last.parts.every((part) => part._tag === "Result")) last.parts.push(result)
        else push("user", [result])
        break
      }
      default:
        push("user", parts(message.content))
    }
  }

  const tools: Array<Tool> = (body.tools ?? []).map(({ function: fn }) => ({
    name: fn.name ?? "",
    description: fn.description ?? "",
    schema: "parameters" in fn ? fn.parameters : { type: "object", properties: {} },
    kind: "function",
  }))
  const schema = body.response_format?.json_schema
  const stop = body.stop

  return Result.succeed({
    ...emptyRequest(body.model),
    system,
    messages,
    tools,
    toolChoice: toolChoice(body.tool_choice),
    parallelToolCalls: body.parallel_tool_calls,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stop: stop === undefined ? [] : typeof stop === "string" ? [stop] : stop,
    effort: body.reasoning_effort === undefined ? undefined : effortNamed(body.reasoning_effort),
    format:
      schema === undefined
        ? undefined
        : {
            name: schema.name ?? "",
            schema: "schema" in schema ? schema.schema : null,
            strict: schema.strict === true,
          },
    stream: body.stream === true,
    cacheKey: body.prompt_cache_key,
    includeUsage: body.stream_options?.include_usage === true,
  })
}

// --- The request, written for a Chat upstream -----------------------------------

const imageJson = (url: string) => ({ type: "image_url", image_url: { url } })

/** The conversation as Chat messages: one system message first, then each turn. */
const messagesJson = (request: Request): Array<unknown> => {
  const out: Array<unknown> = []
  if (request.system.length > 0) out.push({ role: "system", content: request.system.join("\n\n") })
  for (const message of request.messages) {
    if (message.role === "assistant") {
      const texts: Array<string> = []
      const calls: Array<unknown> = []
      for (const part of message.parts) {
        if (part._tag === "Text") texts.push(part.text)
        else if (part._tag === "Call") {
          calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: callArguments(part) } })
        }
      }
      const said = texts.join("\n\n")
      if (said.length === 0 && calls.length === 0) continue
      const assistant: Record<string, unknown> = { role: "assistant", content: said.length === 0 ? null : said }
      if (calls.length > 0) assistant.tool_calls = calls
      out.push(assistant)
      continue
    }
    const content: Array<{ readonly type: string; readonly text?: string; readonly file?: unknown }> = []
    // Images a tool returned go to the model with the user turn after the results.
    const images: Array<{ readonly type: string }> = []
    for (const part of message.parts) {
      switch (part._tag) {
        case "Result":
          out.push({ role: "tool", tool_call_id: part.callId, content: resultOutput(part) })
          for (const piece of part.content) if (piece._tag === "Image") images.push(imageJson(mediaUrl(piece.media)))
          break
        case "Text":
          content.push({ type: "text", text: part.text })
          break
        case "Image":
          content.push(imageJson(mediaUrl(part.media)))
          break
        case "File":
          content.push({
            type: "file",
            file: { filename: part.media.name ?? "document.pdf", file_data: mediaUrl(part.media) },
          })
          break
        case "Call":
        case "Reasoning":
          break
      }
    }
    const user = [...images, ...content]
    const [only] = user
    // A lone text part reads best as a plain string.
    if (user.length === 1 && only !== undefined && "text" in only) out.push({ role: "user", content: only.text })
    else if (user.length > 0) out.push({ role: "user", content: user })
  }
  return out
}

const toolChoiceJson = (choice: ToolChoice): unknown => {
  switch (choice._tag) {
    case "Auto":
      return "auto"
    case "None":
      return "none"
    case "Required":
      return "required"
    case "Named":
      return { type: "function", function: { name: choice.name } }
  }
}

/**
 * The request as a Chat body, keys in a fixed order, streamed with usage.
 * Effort and the cache key are not sent: not every Chat API takes them, and
 * one that does not may refuse the request.
 */
export const encodeRequest = (request: Request): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: messagesJson(request),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.kind === "function" ? tool.schema : freeformSchema,
      },
    }))
    body.tool_choice = toolChoiceJson(request.toolChoice)
    if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stop.length > 0) body.stop = request.stop
  if (request.format !== undefined) {
    const { name, schema, strict } = request.format
    body.response_format = { type: "json_schema", json_schema: { name, schema, strict } }
  }
  return body
}

// --- The answer, read from a Chat upstream --------------------------------------

const Delta = Schema.Struct({
  reasoning_content: field(Schema.String),
  reasoning: field(Schema.String),
  content: field(Schema.String),
  tool_calls: field(
    listOf(
      Schema.Struct({
        index: field(Count),
        id: field(Schema.String),
        function: field(Schema.Struct({ name: field(Schema.String), arguments: field(Schema.String) })),
      }),
    ),
  ),
})
type Delta = typeof Delta.Type

/** One chunk of a Chat stream, or a whole completion, as far as slopmax reads it. */
export const ChatChunk = Schema.Struct({
  /** Any error that is not null ends the answer, whatever its shape. */
  error: anyJson,
  usage: field(
    Schema.Struct({
      prompt_tokens: field(Count),
      prompt_tokens_details: field(Schema.Struct({ cached_tokens: field(Count) })),
      completion_tokens: field(Count),
    }),
  ),
  choices: field(
    listOf(Schema.Struct({ delta: field(Delta), message: field(Delta), finish_reason: field(Schema.String) })),
  ),
})
type ChatChunk = typeof ChatChunk.Type

const readChunk = Schema.decodeUnknownOption(ChatChunk)
const readError = Schema.decodeUnknownOption(Schema.Struct({ code: field(Schema.Int), message: field(Schema.String) }))

/** Usage with the cached tokens counted apart from the rest of the prompt, as one request. */
export const usageOf = (usage: ChatChunk["usage"]): Usage => {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  return new Usage({
    requests: 1,
    input: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    output: usage?.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  })
}

const stops: Readonly<Record<string, Stop>> = {
  length: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
  content_filter: "filtered",
}

interface PendingCall {
  id: string
  name: string
  arguments: string
}

/**
 * Reads a Chat answer stream. Text and reasoning pass on as they arrive.
 * Tool calls stream as argument fragments, several at once, keyed by index;
 * they are passed on whole when the answer ends, with the finish reason and
 * the usage, which comes in a chunk of its own after the last choice.
 */
export class ChatReader implements AnswerReader {
  private readonly calls = new Map<number, PendingCall>()
  private finishReason: string | undefined
  private usage: Usage | undefined
  private ended = false

  /** `freeform` names the tools the client declared freeform, whose calls carry `{"input": …}` here. */
  constructor(
    private readonly freeform: ReadonlySet<string>,
    private readonly token: () => string,
  ) {}

  /** A reader for the answer to `request`. */
  static forRequest(request: Request, token: () => string): ChatReader {
    return new ChatReader(freeformNames(request), token)
  }

  get done(): boolean {
    return this.ended
  }

  readonly event = (data: unknown, out: Array<Event>): void => {
    if (this.ended) return
    const read = readChunk(data)
    if (read._tag === "Some") this.chunk(read.value, out)
  }

  /** A whole completion reads as one chunk that ends the answer. */
  readonly document = (body: unknown, out: Array<Event>): void => {
    this.event(body, out)
    this.finish(out)
  }

  readonly finish = (out: Array<Event>): void => {
    if (this.ended) return
    this.ended = true
    const indexes = [...this.calls.keys()].toSorted((a, b) => a - b)
    for (const index of indexes) {
      const partial = this.calls.get(index)
      if (partial !== undefined) out.push(Event.Call({ call: this.call(partial) }))
    }
    if (this.finishReason === undefined) {
      out.push(
        Event.Failed({ failure: { status: 502, message: "the upstream stream ended before the answer finished" } }),
      )
      return
    }
    const stop = stops[this.finishReason] ?? "end"
    out.push(
      Event.Done({
        stop,
        usage: this.usage ?? new Usage({ requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      }),
    )
  }

  private chunk(chunk: ChatChunk, out: Array<Event>): void {
    if (chunk.error !== undefined && chunk.error !== null) {
      this.ended = true
      const error = readError(chunk.error)
      const code = error._tag === "Some" ? error.value.code : undefined
      const status = code !== undefined && code >= 400 && code < 600 ? code : 500
      const message = (error._tag === "Some" ? error.value.message : undefined) ?? "the upstream answer failed"
      out.push(Event.Failed({ failure: { status, message } }))
      return
    }
    if (chunk.usage !== undefined) this.usage = usageOf(chunk.usage)
    const choice = chunk.choices?.[0]
    if (choice === undefined) return
    const delta = choice.delta ?? choice.message
    if (delta !== undefined) this.delta(delta, out)
    if (choice.finish_reason !== undefined) this.finishReason = choice.finish_reason
  }

  private delta(delta: Delta, out: Array<Event>): void {
    for (const reasoning of [delta.reasoning_content, delta.reasoning]) {
      if (reasoning !== undefined && reasoning.length > 0) out.push(Event.Reasoning({ text: reasoning }))
    }
    if (delta.content !== undefined && delta.content.length > 0) out.push(Event.Text({ text: delta.content }))
    const calls = delta.tool_calls ?? []
    for (const [position, call] of calls.entries()) {
      const index = call.index ?? position
      let partial = this.calls.get(index)
      if (partial === undefined) {
        partial = { id: "", name: "", arguments: "" }
        this.calls.set(index, partial)
      }
      if (call.id !== undefined) partial.id = call.id
      if (call.function?.name !== undefined) partial.name += call.function.name
      if (call.function?.arguments !== undefined) partial.arguments += call.function.arguments
    }
  }

  private call(partial: PendingCall): ToolCall {
    const id = partial.id.length > 0 ? partial.id : `call_${this.token()}`
    return this.freeform.has(partial.name)
      ? { id, name: partial.name, input: unwrapFreeform(partial.arguments), kind: "freeform" }
      : { id, name: partial.name, input: partial.arguments, kind: "function" }
  }
}

// --- The answer, told to a Chat client ------------------------------------------

const finishReasons: { readonly [S in Stop]: string } = {
  end: "stop",
  sequence: "stop",
  toolUse: "tool_calls",
  length: "length",
  filtered: "content_filter",
}

const usageJson = (usage: Usage) => {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  }
}

const toolCallJson = (call: ToolCall) => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: callArguments(call) },
})

const doneLine = "data: [DONE]\n\n"

/**
 * Writes one answer as a Chat chunk stream: a first chunk naming the
 * assistant, then text, reasoning and calls as they come, then the finish
 * reason, the usage when the client asked for it, and `[DONE]`. Frames are
 * not named. After the answer ends or fails, nothing more is written.
 */
export class ChatWriter implements AnswerWriter {
  private readonly id: string
  private readonly created: number
  private started = false
  private over = false
  private calls = 0

  constructor(
    private readonly context: ReplyContext,
    private readonly includeUsage: boolean,
  ) {
    this.id = `chatcmpl-${context.token()}`
    this.created = DateTime.toEpochSeconds(context.now)
  }

  readonly write = (event: Event): string => {
    if (this.over) return ""
    let out = ""
    if (!this.started) {
      this.started = true
      out += this.chunk({ role: "assistant", content: "" }, null)
    }
    switch (event._tag) {
      case "Text":
        return out + this.chunk({ content: event.text }, null)
      // Not in the Chat spec, but widely shown by Chat clients.
      case "Reasoning":
        return out + this.chunk({ reasoning_content: event.text }, null)
      case "State":
        return out
      case "Call": {
        const index = this.calls
        this.calls += 1
        return out + this.chunk({ tool_calls: [{ ...toolCallJson(event.call), index }] }, null)
      }
      case "Done": {
        this.over = true
        const stop = this.calls > 0 && event.stop === "end" ? "toolUse" : event.stop
        out += this.chunk({}, finishReasons[stop])
        if (this.includeUsage) {
          out += frame(undefined, { ...this.head(), choices: [], usage: usageJson(event.usage) })
        }
        return out + doneLine
      }
      case "Failed": {
        this.over = true
        const { status, message } = event.failure
        return out + frame(undefined, { error: { message, type: failureKind(status), code: status } }) + doneLine
      }
    }
  }

  private head() {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.context.model }
  }

  private chunk(delta: Record<string, unknown>, finish: string | null): string {
    return frame(undefined, { ...this.head(), choices: [{ index: 0, delta, finish_reason: finish }] })
  }
}

/** A whole answer as one completion. */
export const whole = (answer: Answer, context: ReplyContext) => {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: answer.text.length === 0 ? null : answer.text,
  }
  if (answer.reasoning.length > 0) message.reasoning_content = answer.reasoning
  if (answer.calls.length > 0) message.tool_calls = answer.calls.map(toolCallJson)
  return {
    id: `chatcmpl-${context.token()}`,
    object: "chat.completion",
    created: DateTime.toEpochSeconds(context.now),
    model: context.model,
    choices: [{ index: 0, message, finish_reason: finishReasons[stopOf(answer)] }],
    usage: usageJson(answer.usage),
  }
}
