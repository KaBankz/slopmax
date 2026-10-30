// Responses requests: decoded from a client such as Codex, and encoded for
// an upstream that speaks Responses (ChatGPT, the OpenAI API).
import { Result } from "effect"

import { text as texts } from "@slopmax/common"

import {
  type Call,
  Effort,
  type Format,
  Media,
  type Message,
  Part,
  type Reasoning,
  Request,
  type Role,
  type Tool,
  ToolChoice,
  type ToolKind,
  ToolResult,
  textOf,
} from "../ir.ts"
import { array, bool, f64, get, type Json, type JsonObject, str, strOf, u64 } from "../json.ts"
import { open, PREFIX } from "./compaction.ts"

interface Draft {
  readonly system: Array<string>
  readonly messages: Array<{ readonly role: Role; readonly parts: Array<Part> }>
  compact: boolean
}

export const decode = (body: Json): Result.Result<Request, string> => {
  const model = str(get(body, "model"))
  if (model === undefined) return Result.fail("the request names no model")
  const effort = str(get(get(body, "reasoning"), "effort"))
  const draft: Draft = { system: [], messages: [], compact: false }
  const instructions = str(get(body, "instructions"))
  if (instructions !== undefined && texts.trim(instructions) !== "") draft.system.push(instructions)
  const input = get(body, "input")
  if (typeof input === "string") {
    draft.messages.push({ role: "User", parts: [Part.Text(input)] })
  } else if (Array.isArray(input)) {
    for (const item of input) itemInto(item, draft)
  }
  const tools: Array<Tool> = []
  for (const tool of array(get(body, "tools")) ?? []) {
    let kind: ToolKind
    switch (str(get(tool, "type"))) {
      case "function":
        kind = "Function"
        break
      case "custom":
        kind = "Freeform"
        break
      // Hosted tools (web search, image generation) run at OpenAI.
      default:
        continue
    }
    const parameters = get(tool, "parameters")
    tools.push({
      name: strOf(tool, "name"),
      description: strOf(tool, "description"),
      schema: parameters === undefined ? { type: "object", properties: {} } : parameters,
      kind,
    })
  }
  let toolChoice = ToolChoice.Auto
  const choice = get(body, "tool_choice")
  if (typeof choice === "string") {
    toolChoice = choice === "none" ? ToolChoice.None : choice === "required" ? ToolChoice.Required : ToolChoice.Auto
  } else if (choice !== undefined && get(choice, "name") !== undefined) {
    toolChoice = ToolChoice.Named(strOf(choice, "name"))
  }
  let format: Format | undefined
  const textFormat = get(get(body, "text"), "format")
  if (textFormat !== undefined && str(get(textFormat, "type")) === "json_schema") {
    format = {
      name: strOf(textFormat, "name"),
      schema: get(textFormat, "schema") ?? null,
      strict: bool(get(textFormat, "strict")) === true,
    }
  }
  return Result.succeed(
    Request.make({
      model,
      stream: bool(get(body, "stream")) === true,
      maxTokens: u64(get(body, "max_output_tokens")),
      temperature: f64(get(body, "temperature")),
      topP: f64(get(body, "top_p")),
      parallelToolCalls: bool(get(body, "parallel_tool_calls")),
      effort: effort === undefined ? undefined : Effort.parse(effort),
      cacheKey: str(get(body, "prompt_cache_key")),
      system: draft.system,
      messages: draft.messages,
      tools,
      toolChoice,
      format,
      compact: draft.compact,
    }),
  )
}

/**
 * Adds one input item to the conversation, joining it to the message
 * before when they belong together (calls to the assistant's turn,
 * results to the user's).
 */
const itemInto = (item: Json, request: Draft): void => {
  const push = (role: Role, part: Part): void => {
    const last = request.messages.at(-1)
    if (last !== undefined && last.role === role && joins(part, last)) last.parts.push(part)
    else request.messages.push({ role, parts: [part] })
  }
  const type = str(get(item, "type")) ?? "message"
  switch (type) {
    case "message": {
      const role = str(get(item, "role")) ?? "user"
      const content = get(item, "content") ?? null
      if (role === "system" || role === "developer") {
        const text = textOf(content)
        if (texts.trim(text) !== "") request.system.push(text)
        return
      }
      const as: Role = role === "assistant" ? "Assistant" : "User"
      if (typeof content === "string") {
        push(as, Part.Text(content))
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const p = contentPart(part)
          if (p !== undefined) push(as, p)
        }
      }
      return
    }
    case "function_call":
    case "custom_tool_call": {
      const freeform = type === "custom_tool_call"
      const call: Call = {
        id: strOf(item, "call_id"),
        name: strOf(item, "name"),
        input: strOf(item, freeform ? "input" : "arguments"),
        kind: freeform ? "Freeform" : "Function",
      }
      return push("Assistant", Part.Call(call))
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const output = get(item, "output")
      const content: Array<Part> = []
      if (typeof output === "string") {
        content.push(Part.Text(output))
      } else if (Array.isArray(output)) {
        for (const part of output) {
          const p = contentPart(part)
          if (p !== undefined) content.push(p)
        }
      }
      return push("User", Part.Result({ id: strOf(item, "call_id"), content, isError: false }))
    }
    // Codex asks for remote compaction by ending its input so.
    case "compaction_trigger":
      request.compact = true
      return
    // A summary slopmax wrote is read back as the conversation so far;
    // OpenAI's own is sealed and only OpenAI can expand it.
    case "compaction": {
      const sealed = str(get(item, "encrypted_content"))
      const summary = sealed === undefined ? undefined : open(sealed)
      if (summary !== undefined) push("User", Part.Text(`${PREFIX}\n\n${summary}`))
      return
    }
    case "reasoning": {
      const summary: Array<string> = []
      for (const s of array(get(item, "summary")) ?? []) {
        const text = str(get(s, "text"))
        if (text !== undefined) summary.push(text)
      }
      const reasoning: Reasoning = {
        text: summary.join("\n\n"),
        opaque: str(get(item, "encrypted_content")),
      }
      return push("Assistant", Part.Reasoning(reasoning))
    }
    // Hosted tool calls and other items only OpenAI can replay.
    default:
      return
  }
}

/**
 * Whether `part` continues `message` rather than starting a new one: text
 * does not join a turn that already holds calls or results.
 */
const joins = (part: Part, message: Message): boolean => {
  if (part._tag === "Call" || part._tag === "Result" || part._tag === "Reasoning") return true
  return !message.parts.some((p) => p._tag === "Call" || p._tag === "Result")
}

const contentPart = (part: Json): Part | undefined => {
  switch (str(get(part, "type"))) {
    case "input_text":
    case "output_text":
    case "text": {
      const text = str(get(part, "text"))
      return text === undefined || text === "" ? undefined : Part.Text(text)
    }
    case "refusal": {
      const text = str(get(part, "refusal"))
      return text === undefined ? undefined : Part.Text(text)
    }
    case "input_image": {
      const url = str(get(part, "image_url"))
      return url === undefined ? undefined : Part.Image(Media.fromUrl(url))
    }
    case "input_file": {
      const data = str(get(part, "file_data"))
      if (data === undefined) return undefined
      return Part.File({ ...Media.fromUrl(data), name: str(get(part, "filename")) })
    }
    default:
      return undefined
  }
}

/**
 * The request in Responses form. Always streamed: some upstreams only
 * stream, and a client that wants one answer gets the stream collected.
 */
export const encode = (request: Request): JsonObject => {
  const body: JsonObject = {}
  body["model"] = request.model
  body["instructions"] = request.system.join("\n\n")
  body["input"] = input(request)
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map(toolJson)
    body["tool_choice"] = toolChoice(request.toolChoice)
    body["parallel_tool_calls"] = request.parallelToolCalls ?? true
  }
  if (request.effort !== undefined) {
    body["reasoning"] = { effort: effortName(request.effort), summary: "auto" }
  }
  body["store"] = false
  body["stream"] = true
  body["include"] = ["reasoning.encrypted_content"]
  if (request.cacheKey !== undefined) body["prompt_cache_key"] = request.cacheKey
  if (request.format !== undefined) {
    const format = request.format
    body["text"] = {
      format: { type: "json_schema", name: format.name, schema: format.schema, strict: format.strict },
    }
  }
  if (request.maxTokens !== undefined) body["max_output_tokens"] = request.maxTokens
  return body
}

const effortName = (effort: Effort): string => {
  switch (effort) {
    case "Minimal":
      return "minimal"
    case "Low":
      return "low"
    case "Medium":
      return "medium"
    case "High":
      return "high"
    case "Max":
      return "xhigh"
  }
}

const input = (request: Request): Array<Json> => {
  // Results answer calls of the same kind.
  const kinds = new Map<string, ToolKind>()
  for (const message of request.messages) {
    for (const part of message.parts) if (part._tag === "Call") kinds.set(part.call.id, part.call.kind)
  }
  const items: Array<Json> = []
  for (const message of request.messages) {
    let content: Array<Json> = []
    const images: Array<Json> = []
    const role = message.role === "User" ? "user" : "assistant"
    const flush = (): void => {
      if (content.length === 0) return
      items.push({ type: "message", role, content })
      content = []
    }
    for (const part of message.parts) {
      switch (part._tag) {
        case "Text":
          content.push(
            message.role === "User"
              ? { type: "input_text", text: part.text }
              : { type: "output_text", text: part.text },
          )
          break
        case "Image":
          content.push({ type: "input_image", image_url: Media.url(part.media) })
          break
        case "File":
          content.push({
            type: "input_file",
            filename: part.media.name ?? "document.pdf",
            file_data: Media.url(part.media),
          })
          break
        case "Call": {
          const call = part.call
          flush()
          items.push(
            call.kind === "Function"
              ? { type: "function_call", call_id: call.id, name: call.name, arguments: call.input }
              : { type: "custom_tool_call", call_id: call.id, name: call.name, input: call.input },
          )
          break
        }
        case "Result": {
          const result = part.result
          flush()
          let output = ToolResult.text(result)
          if (result.isError && output !== "") output = `Error: ${output}`
          const kind = kinds.get(result.id) === "Freeform" ? "custom_tool_call_output" : "function_call_output"
          items.push({ type: kind, call_id: result.id, output })
          for (const p of result.content) {
            if (p._tag === "Image") images.push({ type: "input_image", image_url: Media.url(p.media) })
          }
          break
        }
        // Only state this provider issued can be replayed.
        case "Reasoning": {
          const reasoning = part.reasoning
          if (reasoning.opaque !== undefined) {
            flush()
            const summary: Array<Json> = reasoning.text === "" ? [] : [{ type: "summary_text", text: reasoning.text }]
            items.push({ type: "reasoning", summary, encrypted_content: reasoning.opaque })
          }
          break
        }
      }
    }
    flush()
    // Images a tool returned follow its output as a user message.
    if (images.length > 0) items.push({ type: "message", role: "user", content: images })
  }
  return items
}

const toolJson = (tool: Tool): Json => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.kind === "Function" ? tool.schema : freeformSchema(),
  strict: false,
})

/** The arguments of a freeform tool lowered to a function. */
export const freeformSchema = (): JsonObject => ({
  type: "object",
  properties: { input: { type: "string", description: "The tool's raw input." } },
  required: ["input"],
})

const toolChoice = (choice: ToolChoice): Json => {
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
