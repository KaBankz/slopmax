// Anthropic's Messages format, as Claude Code speaks it.
//
// Messages is only ever the client's side of a translation: slopmax reads a
// Claude Code request to send it to a model that speaks another format, and
// tells the answer back as the event stream (or the whole message) Claude
// Code reads. Nothing is ever translated into Messages, so there is no
// upstream half here.
import type { Usage } from "@slopmax/domain"
import { Result, Schema } from "effect"
import { type Answer, stopOf } from "./collect.ts"
import {
  anyJson,
  type AnswerWriter,
  callArguments,
  Count,
  type Effort,
  effortForBudget,
  effortNamed,
  emptyRequest,
  type Event,
  field,
  listOf,
  type Media,
  type Message,
  type Part,
  type ReplyContext,
  type Request,
  RequestInvalid,
  type ResultPart,
  type Stop,
  type Tool,
  type ToolChoice,
} from "./common.ts"
import { errorBody, failureKind } from "./errors.ts"
import { frame, parseText } from "./lines.ts"

// --- The request, as Claude Code sends it -------------------------------------

const Source = Schema.Struct({
  type: field(Schema.String),
  media_type: field(Schema.String),
  data: field(Schema.String),
  url: field(Schema.String),
})

/** A content block inside a tool result: text, images, documents. */
const InnerBlock = Schema.Struct({
  type: field(Schema.String),
  text: field(Schema.String),
  source: field(Source),
  title: field(Schema.String),
})

/** A content block of a turn. Blocks of other types (thinking, server tools) read too, and are dropped later. */
const Block = Schema.Struct({
  ...InnerBlock.fields,
  id: field(Schema.String),
  name: field(Schema.String),
  input: anyJson,
  tool_use_id: field(Schema.String),
  content: field(Schema.Union([Schema.String, listOf(InnerBlock)])),
  is_error: field(Schema.Boolean),
})
type Block = typeof Block.Type
type InnerBlock = typeof InnerBlock.Type

const Content = Schema.Union([Schema.String, listOf(Block)])

/** A Messages request: only the fields translation carries, each read leniently. */
export const MessagesRequest = Schema.Struct({
  model: field(Schema.String),
  stream: field(Schema.Boolean),
  max_tokens: field(Count),
  temperature: field(Schema.Finite),
  top_p: field(Schema.Finite),
  system: field(Schema.Union([Schema.String, listOf(Schema.Struct({ text: field(Schema.String) }))])),
  messages: field(listOf(Schema.Struct({ role: field(Schema.String), content: field(Content) }))),
  tools: field(
    listOf(Schema.Struct({ name: field(Schema.String), description: field(Schema.String), input_schema: anyJson })),
  ),
  tool_choice: field(
    Schema.Struct({
      type: field(Schema.String),
      name: field(Schema.String),
      disable_parallel_tool_use: field(Schema.Boolean),
    }),
  ),
  stop_sequences: field(listOf(Schema.String)),
  output_config: field(Schema.Struct({ effort: field(Schema.String) })),
  thinking: field(Schema.Struct({ type: field(Schema.String), budget_tokens: field(Count) })),
})
export type MessagesRequest = typeof MessagesRequest.Type

const readRequest = Schema.decodeUnknownResult(MessagesRequest)

/** Claude Code's billing line, which only Anthropic reads. */
const billing = "x-anthropic-billing-header:"

const media = (source: typeof Source.Type | undefined, name?: string): Media | undefined => {
  if (source === undefined) return undefined
  const mediaType = source.media_type ?? ""
  if (source.type === "base64") return { mediaType, source: { _tag: "Inline", data: source.data ?? "" }, name }
  if (source.type === "url") return { mediaType, source: { _tag: "Link", url: source.url ?? "" }, name }
  return undefined
}

/** A text, image or document block; a plain-text document is just text. */
const contentPart = (block: InnerBlock): Part | undefined => {
  switch (block.type) {
    case "text":
      return block.text === undefined || block.text.length === 0 ? undefined : { _tag: "Text", text: block.text }
    case "image": {
      const image = media(block.source)
      return image === undefined ? undefined : { _tag: "Image", media: image }
    }
    case "document": {
      if (block.source?.type === "text") {
        const text = block.source.data
        return text === undefined ? undefined : { _tag: "Text", text }
      }
      const file = media(block.source, block.title)
      return file === undefined ? undefined : { _tag: "File", media: file }
    }
    default:
      return undefined
  }
}

const resultContent = (content: Block["content"]): ReadonlyArray<ResultPart> => {
  if (content === undefined) return []
  if (typeof content === "string") return [{ _tag: "Text", text: content }]
  const parts: Array<ResultPart> = []
  for (const block of content) {
    const part = contentPart(block)
    // A tool result carries text and images; a document in one is read as text when it is text.
    if (part?._tag === "Text" || part?._tag === "Image") parts.push(part)
  }
  return parts
}

/** One block of a turn. Thinking carries Anthropic's signature, which no one else can read; server tool blocks only mean something at Anthropic. */
const part = (block: Block): Part | undefined => {
  switch (block.type) {
    case "tool_use":
      return {
        _tag: "Call",
        id: block.id ?? "",
        name: block.name ?? "",
        // A call made with no arguments (or with `null` for them) still hands the tool an object.
        input: block.input === undefined || block.input === null ? "{}" : JSON.stringify(block.input),
        kind: "function",
      }
    case "tool_result":
      return {
        _tag: "Result",
        callId: block.tool_use_id ?? "",
        content: resultContent(block.content),
        isError: block.is_error === true,
      }
    default:
      return contentPart(block)
  }
}

/** The effort asked for: named outright, or implied by a thinking budget. */
const effort = (body: MessagesRequest): Effort | undefined => {
  const named = body.output_config?.effort === undefined ? undefined : effortNamed(body.output_config.effort)
  if (named !== undefined) return named
  if (body.thinking?.type === "enabled") {
    return body.thinking.budget_tokens === undefined ? undefined : effortForBudget(body.thinking.budget_tokens)
  }
  return body.thinking?.type === "disabled" ? "low" : undefined
}

const toolChoice = (choice: MessagesRequest["tool_choice"]): ToolChoice => {
  switch (choice?.type) {
    case "any":
      return { _tag: "Required" }
    case "none":
      return { _tag: "None" }
    case "tool":
      return { _tag: "Named", name: choice.name ?? "" }
    default:
      return { _tag: "Auto" }
  }
}

/** Reads a Claude Code request (already parsed JSON) into the common form. */
export const decodeRequest = (json: unknown): Result.Result<Request, RequestInvalid> => {
  const read = readRequest(json)
  if (read._tag === "Failure") return Result.fail(new RequestInvalid({ message: "the request is not a JSON object" }))
  const body = read.success
  if (body.model === undefined) return Result.fail(new RequestInvalid({ message: "the request names no model" }))

  const system: Array<string> = []
  const addSystem = (text: string | undefined): void => {
    if (text !== undefined && text.trim().length > 0 && !text.startsWith(billing)) system.push(text)
  }
  if (typeof body.system === "string") addSystem(body.system)
  else for (const block of body.system ?? []) addSystem(block.text)

  const messages: Array<Message> = []
  for (const message of body.messages ?? []) {
    const content = message.content
    const parts: Array<Part> =
      content === undefined
        ? []
        : typeof content === "string"
          ? [{ _tag: "Text", text: content }]
          : content.flatMap((block) => {
              const one = part(block)
              return one === undefined ? [] : [one]
            })
    if (parts.length > 0) messages.push({ role: message.role === "assistant" ? "assistant" : "user", parts })
  }

  // Client tools carry a schema; Anthropic's server tools (web search, code execution) only work there and stay behind.
  const tools: Array<Tool> = []
  for (const tool of body.tools ?? []) {
    if (tool.name === undefined || !("input_schema" in tool)) continue
    tools.push({ name: tool.name, description: tool.description ?? "", schema: tool.input_schema, kind: "function" })
  }

  return Result.succeed({
    ...emptyRequest(body.model),
    system,
    messages,
    tools,
    toolChoice: toolChoice(body.tool_choice),
    parallelToolCalls: body.tool_choice?.disable_parallel_tool_use === true ? false : undefined,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stop: body.stop_sequences ?? [],
    effort: effort(body),
    stream: body.stream === true,
  })
}

// --- The answer, told to Claude Code -------------------------------------------

const stopReasons: { readonly [S in Stop]: string } = {
  end: "end_turn",
  toolUse: "tool_use",
  length: "max_tokens",
  sequence: "stop_sequence",
  filtered: "refusal",
}

const usageJson = (usage: Usage) => ({
  input_tokens: usage.input,
  output_tokens: usage.output,
  cache_read_input_tokens: usage.cacheRead,
  cache_creation_input_tokens: usage.cacheWrite,
})

/**
 * Writes one answer as the Messages event stream Claude Code reads. Text
 * streams in a text block; each call is a `tool_use` block of its own;
 * reasoning from another model is never shown, because Claude Code would send
 * it back to Anthropic, which rejects thinking it did not sign. Every frame
 * is named. After the answer ends or fails, nothing more is written.
 */
export class MessagesWriter implements AnswerWriter {
  private readonly id: string
  private started = false
  private over = false
  /** The next content block's index. */
  private index = 0
  /** Whether a text block is open. */
  private inText = false
  /** Whether the answer called tools, which is why it stops if it says it simply ended. */
  private called = false

  constructor(private readonly context: ReplyContext) {
    this.id = `msg_${context.token()}`
  }

  readonly write = (event: Event): string => {
    if (this.over) return ""
    let out = ""
    if (!this.started) {
      this.started = true
      out += frame("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.context.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    switch (event._tag) {
      case "Text":
        if (!this.inText) {
          this.inText = true
          out += frame("content_block_start", {
            type: "content_block_start",
            index: this.index,
            content_block: { type: "text", text: "" },
          })
        }
        out += frame("content_block_delta", {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "text_delta", text: event.text },
        })
        return out
      case "Reasoning":
      case "State":
        return out
      case "Call":
        out += this.closeText()
        out += frame("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: event.call.id, name: event.call.name, input: {} },
        })
        out += frame("content_block_delta", {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "input_json_delta", partial_json: callArguments(event.call) },
        })
        out += this.stopBlock()
        this.called = true
        return out
      case "Done": {
        this.over = true
        out += this.closeText()
        const stop = event.stop === "end" && this.called ? "toolUse" : event.stop
        out += frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReasons[stop], stop_sequence: null },
          usage: usageJson(event.usage),
        })
        return out + frame("message_stop", { type: "message_stop" })
      }
      case "Failed":
        this.over = true
        out += this.closeText()
        return out + frame("error", errorBody("messages", failureKind(event.failure.status), event.failure.message))
    }
  }

  private closeText(): string {
    if (!this.inText) return ""
    this.inText = false
    return this.stopBlock()
  }

  private stopBlock(): string {
    const out = frame("content_block_stop", { type: "content_block_stop", index: this.index })
    this.index += 1
    return out
  }
}

/** A call's arguments as the object Messages carries; arguments that are not an object read as none. */
const parsedInput = (text: string): unknown => {
  const value = parseText(text)
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
}

/** A whole answer as one Messages message: its text, then its calls. */
export const whole = (answer: Answer, context: ReplyContext) => {
  const content: Array<unknown> = []
  if (answer.text.length > 0) content.push({ type: "text", text: answer.text })
  for (const call of answer.calls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: parsedInput(callArguments(call)) })
  }
  return {
    id: `msg_${context.token()}`,
    type: "message",
    role: "assistant",
    model: context.model,
    content,
    stop_reason: stopReasons[stopOf(answer)],
    stop_sequence: null,
    usage: usageJson(answer.usage),
  }
}
