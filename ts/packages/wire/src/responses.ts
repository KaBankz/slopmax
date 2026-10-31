// OpenAI's Responses format, as Codex speaks it and as ChatGPT and the
// OpenAI API answer it.
//
// It is both sides of a translation: a Codex request is read from it, and a
// request from Claude Code or a Chat client is written in it for a Responses
// upstream. Its answer stream is read into events, and events are told back to
// Codex as the item stream it rebuilds its history from.
import { Usage } from "@slopmax/domain"
import { DateTime, Result, Schema } from "effect"
import { type Answer, stopOf } from "./collect.ts"
import {
  anyJson,
  type AnswerFormat,
  type AnswerReader,
  type AnswerWriter,
  Count,
  type Effort,
  effortNamed,
  emptyRequest,
  Event,
  type Failure,
  field,
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
  type ResultPart,
  type Role,
  type Stop,
  type Tool,
  type ToolCall,
  type ToolChoice,
  type ToolKind,
} from "./common.ts"
import * as Compaction from "./compaction.ts"
import { frame } from "./lines.ts"

// --- The request, as Codex sends it ---------------------------------------------

/** A content part of a message item, or of a tool's output. */
const ContentPart = Schema.Struct({
  type: field(Schema.String),
  text: field(Schema.String),
  refusal: field(Schema.String),
  image_url: field(Schema.String),
  file_data: field(Schema.String),
  filename: field(Schema.String),
})
type ContentPart = typeof ContentPart.Type

const Content = Schema.Union([Schema.String, listOf(ContentPart)])

/** One input item. Items of other types (hosted tool calls) read too, and are dropped later. */
const Item = Schema.Struct({
  type: field(Schema.String),
  role: field(Schema.String),
  content: field(Content),
  call_id: field(Schema.String),
  name: field(Schema.String),
  arguments: field(Schema.String),
  input: field(Schema.String),
  output: field(Content),
  encrypted_content: field(Schema.String),
  summary: field(listOf(Schema.Struct({ text: field(Schema.String) }))),
})
type Item = typeof Item.Type

/** A Responses request: only the fields translation carries, each read leniently. */
export const ResponsesRequest = Schema.Struct({
  model: field(Schema.String),
  stream: field(Schema.Boolean),
  max_output_tokens: field(Count),
  temperature: field(Schema.Finite),
  top_p: field(Schema.Finite),
  parallel_tool_calls: field(Schema.Boolean),
  reasoning: field(Schema.Struct({ effort: field(Schema.String) })),
  prompt_cache_key: field(Schema.String),
  instructions: field(Schema.String),
  input: field(Schema.Union([Schema.String, listOf(Item)])),
  tools: field(
    listOf(
      Schema.Struct({
        type: field(Schema.String),
        name: field(Schema.String),
        description: field(Schema.String),
        parameters: anyJson,
      }),
    ),
  ),
  tool_choice: field(Schema.Union([Schema.String, Schema.Struct({ name: field(Schema.String) })])),
  text: field(
    Schema.Struct({
      format: field(
        Schema.Struct({
          type: field(Schema.String),
          name: field(Schema.String),
          schema: anyJson,
          strict: field(Schema.Boolean),
        }),
      ),
    }),
  ),
})
export type ResponsesRequest = typeof ResponsesRequest.Type

const readRequest = Schema.decodeUnknownResult(ResponsesRequest)

const emptyObjectSchema = { type: "object", properties: {} }

const contentPart = (part: ContentPart): Part | undefined => {
  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return part.text === undefined || part.text.length === 0 ? undefined : { _tag: "Text", text: part.text }
    case "refusal":
      return part.refusal === undefined ? undefined : { _tag: "Text", text: part.refusal }
    case "input_image":
      return part.image_url === undefined ? undefined : { _tag: "Image", media: mediaFromUrl(part.image_url) }
    case "input_file":
      return part.file_data === undefined
        ? undefined
        : { _tag: "File", media: mediaFromUrl(part.file_data, part.filename) }
    default:
      return undefined
  }
}

const contentParts = (content: Item["content"]): ReadonlyArray<Part> => {
  if (content === undefined) return []
  if (typeof content === "string") return [{ _tag: "Text", text: content }]
  return content.flatMap((part) => {
    const read = contentPart(part)
    return read === undefined ? [] : [read]
  })
}

/** Text inside content: a string, or the text of each part, one per line. */
const contentText = (content: Item["content"]): string =>
  content === undefined
    ? ""
    : typeof content === "string"
      ? content
      : content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n")

/** Whether `part` continues the turn before rather than starting one: text does not join a turn that holds calls or results. */
const joins = (part: Part, message: Message): boolean =>
  part._tag === "Call" ||
  part._tag === "Result" ||
  part._tag === "Reasoning" ||
  !message.parts.some((held) => held._tag === "Call" || held._tag === "Result")

/** Builds the conversation item by item, joining calls to the assistant's turn and results to the user's. */
class Conversation {
  readonly system: Array<string> = []
  readonly messages: Array<{ readonly role: Role; readonly parts: Array<Part> }> = []
  compact = false

  push(role: Role, part: Part): void {
    const last = this.messages.at(-1)
    if (last !== undefined && last.role === role && joins(part, last)) last.parts.push(part)
    else this.messages.push({ role, parts: [part] })
  }

  item(item: Item): void {
    switch (item.type ?? "message") {
      case "message": {
        const role = item.role ?? "user"
        if (role === "system" || role === "developer") {
          const text = contentText(item.content)
          if (text.trim().length > 0) this.system.push(text)
          return
        }
        for (const part of contentParts(item.content)) this.push(role === "assistant" ? "assistant" : "user", part)
        return
      }
      case "function_call":
      case "custom_tool_call": {
        const freeform = item.type === "custom_tool_call"
        this.push("assistant", {
          _tag: "Call",
          id: item.call_id ?? "",
          name: item.name ?? "",
          input: (freeform ? item.input : item.arguments) ?? "",
          kind: freeform ? "freeform" : "function",
        })
        return
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const content = contentParts(item.output).flatMap((part): ReadonlyArray<ResultPart> =>
          part._tag === "Text" || part._tag === "Image" ? [part] : [],
        )
        this.push("user", { _tag: "Result", callId: item.call_id ?? "", content, isError: false })
        return
      }
      // Codex asks for remote compaction by ending its input so.
      case "compaction_trigger":
        this.compact = true
        return
      // A summary slopmax sealed comes back as the conversation so far; OpenAI's own only OpenAI can open.
      case "compaction": {
        const summary = item.encrypted_content === undefined ? undefined : Compaction.open(item.encrypted_content)
        if (summary !== undefined) this.push("user", { _tag: "Text", text: Compaction.reopened(summary) })
        return
      }
      case "reasoning": {
        const summary = (item.summary ?? []).flatMap((part) => (part.text === undefined ? [] : [part.text]))
        this.push("assistant", { _tag: "Reasoning", text: summary.join("\n\n"), opaque: item.encrypted_content })
        return
      }
      // Hosted tool calls and other items only OpenAI can replay.
      default:
        return
    }
  }
}

const toolKind = (type: string | undefined): ToolKind | undefined =>
  type === "function" ? "function" : type === "custom" ? "freeform" : undefined

const toolChoice = (choice: ResponsesRequest["tool_choice"]): ToolChoice => {
  if (typeof choice === "string") {
    return choice === "none" ? { _tag: "None" } : choice === "required" ? { _tag: "Required" } : { _tag: "Auto" }
  }
  return choice?.name === undefined ? { _tag: "Auto" } : { _tag: "Named", name: choice.name }
}

const answerFormat = (format: NonNullable<ResponsesRequest["text"]>["format"]): AnswerFormat | undefined =>
  format?.type === "json_schema"
    ? { name: format.name ?? "", schema: "schema" in format ? format.schema : null, strict: format.strict === true }
    : undefined

/** Reads a Codex request (already parsed JSON) into the common form. */
export const decodeRequest = (json: unknown): Result.Result<Request, RequestInvalid> => {
  const read = readRequest(json)
  if (read._tag === "Failure") return Result.fail(new RequestInvalid({ message: "the request is not a JSON object" }))
  const body = read.success
  if (body.model === undefined) return Result.fail(new RequestInvalid({ message: "the request names no model" }))

  const conversation = new Conversation()
  if (body.instructions !== undefined && body.instructions.trim().length > 0) {
    conversation.system.push(body.instructions)
  }
  if (typeof body.input === "string") conversation.push("user", { _tag: "Text", text: body.input })
  else for (const item of body.input ?? []) conversation.item(item)

  // Hosted tools (web search, image generation) run at OpenAI and stay behind.
  const tools: Array<Tool> = []
  for (const tool of body.tools ?? []) {
    const kind = toolKind(tool.type)
    if (kind === undefined) continue
    const schema = "parameters" in tool ? tool.parameters : emptyObjectSchema
    tools.push({ name: tool.name ?? "", description: tool.description ?? "", schema, kind })
  }

  const effort: Effort | undefined =
    body.reasoning?.effort === undefined ? undefined : effortNamed(body.reasoning.effort)
  return Result.succeed({
    ...emptyRequest(body.model),
    system: conversation.system,
    messages: conversation.messages,
    tools,
    toolChoice: toolChoice(body.tool_choice),
    parallelToolCalls: body.parallel_tool_calls,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    effort,
    format: answerFormat(body.text?.format),
    stream: body.stream === true,
    cacheKey: body.prompt_cache_key,
    compact: conversation.compact,
  })
}

// --- The request, written for a Responses upstream ------------------------------

const efforts: { readonly [E in Effort]: string } = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
}

const toolJson = (tool: Tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.kind === "function" ? tool.schema : freeformSchema,
  strict: false,
})

const toolChoiceJson = (choice: ToolChoice): unknown => {
  switch (choice._tag) {
    case "Auto":
      return "auto"
    case "None":
      return "none"
    case "Required":
      return "required"
    case "Named":
      return { type: "function", name: choice.name }
  }
}

/** The conversation as input items. */
const inputItems = (request: Request): Array<unknown> => {
  // A result answers a call of the same kind.
  const kinds = new Map<string, ToolKind>()
  for (const message of request.messages) {
    for (const part of message.parts) if (part._tag === "Call") kinds.set(part.id, part.kind)
  }
  const items: Array<unknown> = []
  for (const message of request.messages) {
    let content: Array<unknown> = []
    const images: Array<unknown> = []
    const flush = (): void => {
      if (content.length === 0) return
      items.push({ type: "message", role: message.role, content })
      content = []
    }
    for (const part of message.parts) {
      switch (part._tag) {
        case "Text":
          content.push({ type: message.role === "user" ? "input_text" : "output_text", text: part.text })
          break
        case "Image":
          content.push({ type: "input_image", image_url: mediaUrl(part.media) })
          break
        case "File":
          content.push({
            type: "input_file",
            filename: part.media.name ?? "document.pdf",
            file_data: mediaUrl(part.media),
          })
          break
        case "Call":
          flush()
          items.push(
            part.kind === "function"
              ? { type: "function_call", call_id: part.id, name: part.name, arguments: part.input }
              : { type: "custom_tool_call", call_id: part.id, name: part.name, input: part.input },
          )
          break
        case "Result": {
          flush()
          const type = kinds.get(part.callId) === "freeform" ? "custom_tool_call_output" : "function_call_output"
          items.push({ type, call_id: part.callId, output: resultOutput(part) })
          for (const piece of part.content) {
            if (piece._tag === "Image") images.push({ type: "input_image", image_url: mediaUrl(piece.media) })
          }
          break
        }
        // Only state this provider issued can be replayed; reasoning without it stays behind.
        case "Reasoning":
          if (part.opaque !== undefined) {
            flush()
            const summary = part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : []
            items.push({ type: "reasoning", summary, encrypted_content: part.opaque })
          }
          break
      }
    }
    flush()
    // Images a tool returned follow its output as a user message.
    if (images.length > 0) items.push({ type: "message", role: "user", content: images })
  }
  return items
}

/**
 * The request as a Responses body, keys in a fixed order. It always streams,
 * since some upstreams only stream and a client that wants one answer gets
 * the stream collected. Temperature, top-p and stop sequences are not sent:
 * the reasoning models behind Responses refuse them.
 */
export const encodeRequest = (request: Request): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system.join("\n\n"),
    input: inputItems(request),
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map(toolJson)
    body.tool_choice = toolChoiceJson(request.toolChoice)
    body.parallel_tool_calls = request.parallelToolCalls ?? true
  }
  if (request.effort !== undefined) body.reasoning = { effort: efforts[request.effort], summary: "auto" }
  body.store = false
  body.stream = true
  body.include = ["reasoning.encrypted_content"]
  if (request.cacheKey !== undefined) body.prompt_cache_key = request.cacheKey
  if (request.format !== undefined) {
    const { name, schema, strict } = request.format
    body.text = { format: { type: "json_schema", name, schema, strict } }
  }
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
  return body
}

// --- The answer, read from a Responses upstream ---------------------------------

const ErrorInfo = Schema.Struct({
  code: field(Schema.String),
  type: field(Schema.String),
  message: field(Schema.String),
})

const OutputItem = Schema.Struct({
  type: field(Schema.String),
  id: field(Schema.String),
  call_id: field(Schema.String),
  name: field(Schema.String),
  arguments: field(Schema.String),
  input: field(Schema.String),
  encrypted_content: field(Schema.String),
  content: field(listOf(Schema.Struct({ text: field(Schema.String) }))),
})
type OutputItem = typeof OutputItem.Type

const UsageJson = Schema.Struct({
  input_tokens: field(Count),
  input_tokens_details: field(Schema.Struct({ cached_tokens: field(Count) })),
  output_tokens: field(Count),
})

/** A response object: whole, or inside a stream's last event. */
const ResponseJson = Schema.Struct({
  ...ErrorInfo.fields,
  error: field(ErrorInfo),
  output: field(listOf(OutputItem)),
  usage: field(UsageJson),
  incomplete_details: field(Schema.Struct({ reason: field(Schema.String) })),
})
type ResponseJson = typeof ResponseJson.Type

/** One event of a Responses stream, as far as slopmax reads it. */
export const ResponsesEvent = Schema.Struct({
  ...ErrorInfo.fields,
  delta: field(Schema.String),
  item_id: field(Schema.String),
  item: field(OutputItem),
  response: field(ResponseJson),
  error: field(ErrorInfo),
})
type ResponsesEvent = typeof ResponsesEvent.Type

const readEvent = Schema.decodeUnknownOption(ResponsesEvent)
const readResponse = Schema.decodeUnknownOption(ResponseJson)

/** Usage with the cached tokens counted apart from the rest of the input, as one request. */
export const usageOf = (usage: typeof UsageJson.Type | undefined): Usage => {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  return new Usage({
    requests: 1,
    input: Math.max(0, (usage?.input_tokens ?? 0) - cached),
    output: usage?.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  })
}

const done = (response: ResponseJson | undefined): Event => {
  const reason = response?.incomplete_details?.reason
  const stop: Stop = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "filtered" : "end"
  return Event.Done({ stop, usage: usageOf(response?.usage) })
}

/** A failure's status, from its code: a spent or busy account, a bad request, or the upstream's own fault. */
const failureStatus = (code: string | undefined): number => {
  switch (code) {
    case "rate_limit_exceeded":
    case "usage_limit_reached":
    case "usage_limit_exceeded":
      return 429
    case "server_is_overloaded":
    case "slow_down":
      return 529
    case "context_length_exceeded":
    case "invalid_request_error":
    case "invalid_prompt":
      return 400
    default:
      return 500
  }
}

/** The failure a `response.failed`, an `error` event or a whole failed response carries: its error is under `response`, its own `error`, or the event itself. */
const failureOf = (event: ResponsesEvent | ResponseJson): Failure => {
  const error = ("response" in event ? event.response?.error : undefined) ?? event.error ?? event
  const message = error.message
  return {
    status: failureStatus(error.code ?? error.type),
    message: message === undefined || message.length === 0 ? "the upstream response failed" : message,
  }
}

const messageText = (item: OutputItem): string =>
  (item.content ?? []).flatMap((part) => (part.text === undefined ? [] : [part.text])).join("")

/**
 * Reads a Responses answer stream: text and reasoning deltas as they come,
 * calls and reasoning state as their items finish, then the end or the
 * failure. A stream that ends without either was cut short.
 */
export class ResponsesReader implements AnswerReader {
  /** Message items whose text already streamed as deltas, so their finished item is not told twice. */
  private readonly streamed = new Set<string>()
  /** Reasoning summary parts seen, to separate them. */
  private summaries = 0
  private ended = false

  get done(): boolean {
    return this.ended
  }

  readonly event = (data: unknown, out: Array<Event>): void => {
    if (this.ended) return
    const read = readEvent(data)
    if (read._tag === "None") return
    const event = read.value
    switch (event.type) {
      case "response.output_text.delta":
        this.streamed.add(event.item_id ?? "")
        out.push(Event.Text({ text: event.delta ?? "" }))
        return
      case "response.reasoning_summary_part.added":
        if (this.summaries > 0) out.push(Event.Reasoning({ text: "\n\n" }))
        this.summaries += 1
        return
      case "response.reasoning_summary_text.delta":
        out.push(Event.Reasoning({ text: event.delta ?? "" }))
        return
      case "response.output_item.done":
        if (event.item !== undefined) this.item(event.item, out)
        return
      case "response.completed":
      case "response.incomplete":
      case "response.done":
        this.ended = true
        out.push(done(event.response))
        return
      case "response.failed":
      case "error":
        this.ended = true
        out.push(Event.Failed({ failure: failureOf(event) }))
        return
      default:
        return
    }
  }

  /** A whole response: its failure alone, or its output items and then its end. */
  readonly document = (body: unknown, out: Array<Event>): void => {
    if (this.ended) return
    this.ended = true
    const read = readResponse(body)
    if (read._tag === "None") {
      out.push(Event.Failed({ failure: { status: 502, message: "the upstream answer was not a response" } }))
      return
    }
    const response = read.value
    if (response.error !== undefined) {
      out.push(Event.Failed({ failure: failureOf(response) }))
      return
    }
    for (const item of response.output ?? []) this.item(item, out)
    out.push(done(response))
  }

  readonly finish = (out: Array<Event>): void => {
    if (this.ended) return
    this.ended = true
    out.push(
      Event.Failed({ failure: { status: 502, message: "the upstream stream ended before the response completed" } }),
    )
  }

  private item(item: OutputItem, out: Array<Event>): void {
    switch (item.type) {
      case "function_call":
      case "custom_tool_call": {
        const freeform = item.type === "custom_tool_call"
        const call: ToolCall = {
          id: item.call_id ?? "",
          name: item.name ?? "",
          input: (freeform ? item.input : item.arguments) ?? "",
          kind: freeform ? "freeform" : "function",
        }
        out.push(Event.Call({ call }))
        return
      }
      case "reasoning":
        if (item.encrypted_content !== undefined) out.push(Event.State({ state: item.encrypted_content }))
        return
      // Text that did not stream arrives whole.
      case "message": {
        if (this.streamed.has(item.id ?? "")) return
        const text = messageText(item)
        if (text.length > 0) out.push(Event.Text({ text }))
        return
      }
      default:
        return
    }
  }
}

// --- The answer, told to Codex ---------------------------------------------------

const usageJson = (usage: Usage) => {
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output,
  }
}

const errorCode = (status: number): string =>
  status === 429
    ? "rate_limit_exceeded"
    : status === 503 || status === 529
      ? "server_is_overloaded"
      : status === 400
        ? "invalid_request_error"
        : "server_error"

/** The item being streamed. */
type Open = { readonly kind: "message" | "reasoning"; readonly id: string; text: string } | undefined

/**
 * Writes one answer as the Responses event stream Codex reads: the response
 * is created, then each piece of the answer is an item that is added,
 * streamed and finished, and the response completes (or is incomplete, or
 * fails) with every finished item. Every frame is named and numbered.
 *
 * Compacting, the answer's text is gathered instead and becomes one sealed
 * `compaction` item when it ends; reasoning and calls are dropped.
 */
export class ResponsesWriter implements AnswerWriter {
  private readonly id: string
  private readonly createdAt: number
  private sequence = 0
  private started = false
  private over = false
  private open: Open
  /** Finished items, for the final response. */
  private readonly output: Array<unknown> = []
  /** Compacting: the summary gathered so far. */
  private summary: string | undefined

  constructor(
    private readonly context: ReplyContext,
    compacting = false,
  ) {
    this.id = `resp_${context.token()}`
    this.createdAt = DateTime.toEpochSeconds(context.now)
    this.summary = compacting ? "" : undefined
  }

  readonly write = (event: Event): string => {
    if (this.over) return ""
    let out = ""
    if (!this.started) {
      this.started = true
      const response = this.response("in_progress")
      out += this.send("response.created", { response })
      out += this.send("response.in_progress", { response })
    }
    if (this.summary !== undefined) {
      switch (event._tag) {
        case "Text":
          this.summary += event.text
          return out
        case "Done": {
          const item = compactionItem(this.summary, this.context)
          out += this.send("response.output_item.added", { output_index: this.output.length, item })
          out += this.finishItem(item)
          break
        }
        case "Failed":
          break
        default:
          return out
      }
    }
    switch (event._tag) {
      case "Text":
        if (this.open?.kind !== "message") out += this.close() + this.openMessage()
        return out + this.delta("response.output_text.delta", "content_index", event.text)
      case "Reasoning":
        if (this.open?.kind !== "reasoning") out += this.close() + this.openReasoning()
        return out + this.delta("response.reasoning_summary_text.delta", "summary_index", event.text)
      case "State":
        return out
      case "Call":
        return out + this.close() + this.call(event.call)
      case "Done": {
        this.over = true
        out += this.close()
        const usage = usageJson(event.usage)
        if (event.stop === "length") {
          const response = {
            ...this.response("incomplete"),
            usage,
            incomplete_details: { reason: "max_output_tokens" },
          }
          return out + this.send("response.incomplete", { response })
        }
        return out + this.send("response.completed", { response: { ...this.response("completed"), usage } })
      }
      case "Failed": {
        this.over = true
        out += this.close()
        const error = { code: errorCode(event.failure.status), message: event.failure.message }
        return out + this.send("response.failed", { response: { ...this.response("failed"), error } })
      }
    }
  }

  /** The response as it stands, with every item finished so far. */
  private response(status: string) {
    return responseJson(this.id, this.createdAt, this.context.model, status, [...this.output])
  }

  /** Finishes the item being streamed, if any. */
  private close(): string {
    const open = this.open
    if (open === undefined) return ""
    this.open = undefined
    const index = this.output.length
    if (open.kind === "message") {
      const part = outputText(open.text)
      return (
        this.send("response.output_text.done", {
          item_id: open.id,
          output_index: index,
          content_index: 0,
          text: open.text,
        }) +
        this.send("response.content_part.done", { item_id: open.id, output_index: index, content_index: 0, part }) +
        this.finishItem(messageItem(open.id, open.text))
      )
    }
    const part = summaryText(open.text)
    return (
      this.send("response.reasoning_summary_text.done", {
        item_id: open.id,
        output_index: index,
        summary_index: 0,
        text: open.text,
      }) +
      this.send("response.reasoning_summary_part.done", {
        item_id: open.id,
        output_index: index,
        summary_index: 0,
        part,
      }) +
      this.finishItem(reasoningItem(open.id, open.text))
    )
  }

  private send(type: string, data: Record<string, unknown>): string {
    const sequence_number = this.sequence
    this.sequence += 1
    return frame(type, { ...data, type, sequence_number })
  }

  private delta(type: string, indexName: "content_index" | "summary_index", text: string): string {
    const open = this.open
    if (open === undefined) return ""
    open.text += text
    return this.send(type, { item_id: open.id, output_index: this.output.length, [indexName]: 0, delta: text })
  }

  private openMessage(): string {
    const id = `msg_${this.context.token()}`
    const index = this.output.length
    this.open = { kind: "message", id, text: "" }
    const item = { id, type: "message", role: "assistant", status: "in_progress", content: [] }
    const part = outputText("")
    return (
      this.send("response.output_item.added", { output_index: index, item }) +
      this.send("response.content_part.added", { item_id: id, output_index: index, content_index: 0, part })
    )
  }

  private openReasoning(): string {
    const id = `rs_${this.context.token()}`
    const index = this.output.length
    this.open = { kind: "reasoning", id, text: "" }
    const part = summaryText("")
    return (
      this.send("response.output_item.added", { output_index: index, item: { id, type: "reasoning", summary: [] } }) +
      this.send("response.reasoning_summary_part.added", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part,
      })
    )
  }

  private call(call: ToolCall): string {
    const index = this.output.length
    const fn = call.kind === "function"
    const item = callItem(call, this.context)
    const id = item.id
    const prefix = fn ? "response.function_call_arguments" : "response.custom_tool_call_input"
    return (
      this.send("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress" } }) +
      this.send(`${prefix}.delta`, { item_id: id, output_index: index, delta: call.input }) +
      this.send(`${prefix}.done`, { item_id: id, output_index: index, [fn ? "arguments" : "input"]: call.input }) +
      this.finishItem(item)
    )
  }

  private finishItem(item: unknown): string {
    const out = this.send("response.output_item.done", { output_index: this.output.length, item })
    this.output.push(item)
    return out
  }
}

/** A response object around its items. */
const responseJson = (
  id: string,
  createdAt: number,
  model: string,
  status: string,
  output: ReadonlyArray<unknown>,
) => ({
  id,
  object: "response",
  created_at: createdAt,
  status,
  model,
  output,
})

const outputText = (text: string) => ({ type: "output_text", text, annotations: [] })

const summaryText = (text: string) => ({ type: "summary_text", text })

const messageItem = (id: string, text: string) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [outputText(text)],
})

const reasoningItem = (id: string, text: string) => ({ id, type: "reasoning", summary: [summaryText(text)] })

/** A finished call item, under a fresh item id. */
const callItem = (call: ToolCall, context: ReplyContext) =>
  call.kind === "function"
    ? {
        id: `fc_${context.token()}`,
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        arguments: call.input,
      }
    : {
        id: `ctc_${context.token()}`,
        type: "custom_tool_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        input: call.input,
      }

/** A summary sealed in a compaction item. */
const compactionItem = (summary: string, context: ReplyContext) => ({
  id: `cmp_${context.token()}`,
  type: "compaction",
  encrypted_content: Compaction.seal(summary),
})

/** A whole answer as one response, with the same items the stream writer finishes: reasoning, text, then calls. */
export const whole = (answer: Answer, context: ReplyContext) => {
  const id = `resp_${context.token()}`
  const output: Array<unknown> = []
  if (answer.reasoning.length > 0) output.push(reasoningItem(`rs_${context.token()}`, answer.reasoning))
  if (answer.text.length > 0) output.push(messageItem(`msg_${context.token()}`, answer.text))
  for (const call of answer.calls) output.push(callItem(call, context))
  const usage = usageJson(answer.usage)
  const createdAt = DateTime.toEpochSeconds(context.now)
  return stopOf(answer) === "length"
    ? {
        ...responseJson(id, createdAt, context.model, "incomplete", output),
        usage,
        incomplete_details: { reason: "max_output_tokens" },
      }
    : { ...responseJson(id, createdAt, context.model, "completed", output), usage }
}

/** A whole compaction answer: a completed response holding one compaction item. */
export const compacted = (answer: Answer, context: ReplyContext) => {
  const id = `resp_${context.token()}`
  const output = [compactionItem(answer.text, context)]
  return {
    ...responseJson(id, DateTime.toEpochSeconds(context.now), context.model, "completed", output),
    usage: usageJson(answer.usage),
  }
}
