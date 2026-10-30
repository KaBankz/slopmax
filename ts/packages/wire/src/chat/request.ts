// Chat Completions requests: decoded from a client, and encoded for an
// upstream that speaks Chat (xAI, local servers, most gateways).
import { Result } from "effect"

import { text as texts } from "@slopmax/common"

import {
  Effort,
  type Format,
  Media,
  type Message,
  Part,
  Request,
  type Role,
  type Tool,
  ToolChoice,
  ToolResult,
  textOf,
} from "../ir.ts"
import { array, bool, f64, f64Value, get, type Json, type JsonObject, or, str, stringify, strOf, u64 } from "../json.ts"
import { freeformSchema } from "../responses/request.ts"

export const decode = (body: Json): Result.Result<Request, string> => {
  const model = str(get(body, "model"))
  if (model === undefined) return Result.fail("the request names no model")
  const effort = str(get(body, "reasoning_effort"))
  const stopField = get(body, "stop")
  const stop: Array<string> = []
  if (typeof stopField === "string") {
    stop.push(stopField)
  } else if (Array.isArray(stopField)) {
    for (const s of stopField) if (typeof s === "string") stop.push(s)
  }
  const system: Array<string> = []
  const messages: Array<{ readonly role: Role; readonly parts: Array<Part> }> = []
  const push = (role: Role, parts: Array<Part>): void => {
    if (parts.length > 0) messages.push({ role, parts })
  }
  for (const message of array(get(body, "messages")) ?? []) {
    const content = get(message, "content") ?? null
    switch (str(get(message, "role")) ?? "user") {
      case "system":
      case "developer": {
        const text = textOf(content)
        if (texts.trim(text) !== "") system.push(text)
        break
      }
      case "assistant": {
        const ps = parts(content)
        for (const call of array(get(message, "tool_calls")) ?? []) {
          const fn = get(call, "function")
          ps.push(
            Part.Call({
              id: strOf(call, "id"),
              name: str(get(fn, "name")) ?? "",
              input: str(get(fn, "arguments")) ?? "{}",
              kind: "Function",
            }),
          )
        }
        push("Assistant", ps)
        break
      }
      case "tool": {
        const result = Part.Result({ id: strOf(message, "tool_call_id"), content: parts(content), isError: false })
        // Consecutive results answer one turn.
        const last = messages.at(-1)
        if (last !== undefined && last.role === "User" && !last.parts.some((p) => p._tag !== "Result")) {
          last.parts.push(result)
        } else {
          push("User", [result])
        }
        break
      }
      default:
        push("User", parts(content))
    }
  }
  const tools: Array<Tool> = []
  for (const tool of array(get(body, "tools")) ?? []) {
    const fn = get(tool, "function")
    if (fn === undefined) continue
    const parameters = get(fn, "parameters")
    tools.push({
      name: strOf(fn, "name"),
      description: strOf(fn, "description"),
      schema: parameters === undefined ? { type: "object", properties: {} } : parameters,
      kind: "Function",
    })
  }
  let toolChoice = ToolChoice.Auto
  const choice = get(body, "tool_choice")
  if (typeof choice === "string") {
    toolChoice = choice === "none" ? ToolChoice.None : choice === "required" ? ToolChoice.Required : ToolChoice.Auto
  } else if (choice !== undefined) {
    const name = str(get(get(choice, "function"), "name"))
    toolChoice = name === undefined ? ToolChoice.Auto : ToolChoice.Named(name)
  }
  let format: Format | undefined
  const schema = get(get(body, "response_format"), "json_schema")
  if (schema !== undefined) {
    format = {
      name: strOf(schema, "name"),
      schema: get(schema, "schema") ?? null,
      strict: bool(get(schema, "strict")) === true,
    }
  }
  return Result.succeed(
    Request.make({
      model,
      stream: bool(get(body, "stream")) === true,
      maxTokens: u64(or(get(body, "max_completion_tokens"), get(body, "max_tokens"))),
      temperature: f64(get(body, "temperature")),
      topP: f64(get(body, "top_p")),
      parallelToolCalls: bool(get(body, "parallel_tool_calls")),
      effort: effort === undefined ? undefined : Effort.parse(effort),
      cacheKey: str(get(body, "prompt_cache_key")),
      stop,
      system,
      messages,
      tools,
      toolChoice,
      format,
    }),
  )
}

const parts = (content: Json): Array<Part> => {
  if (typeof content === "string") return content === "" ? [] : [Part.Text(content)]
  if (!Array.isArray(content)) return []
  const out: Array<Part> = []
  for (const part of content) {
    switch (str(get(part, "type"))) {
      case "text": {
        const text = str(get(part, "text"))
        if (text !== undefined) out.push(Part.Text(text))
        break
      }
      case "image_url": {
        const url = str(get(get(part, "image_url"), "url"))
        if (url !== undefined) out.push(Part.Image(Media.fromUrl(url)))
        break
      }
      case "file": {
        const file = get(part, "file")
        const data = str(get(file, "file_data"))
        if (data !== undefined) out.push(Part.File({ ...Media.fromUrl(data), name: str(get(file, "filename")) }))
        break
      }
    }
  }
  return out
}

/** The request in Chat form, streamed with usage. */
export const encode = (request: Request): JsonObject => {
  const body: JsonObject = {}
  body["model"] = request.model
  body["messages"] = messages(request)
  body["stream"] = true
  body["stream_options"] = { include_usage: true }
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.kind === "Function" ? tool.schema : freeformSchema(),
      },
    }))
    body["tool_choice"] = toolChoice(request.toolChoice)
    if (request.parallelToolCalls !== undefined) body["parallel_tool_calls"] = request.parallelToolCalls
  }
  if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens
  if (request.temperature !== undefined) body["temperature"] = f64Value(request.temperature)
  if (request.topP !== undefined) body["top_p"] = f64Value(request.topP)
  if (request.stop.length > 0) body["stop"] = request.stop.slice()
  if (request.format !== undefined) {
    const format = request.format
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: format.strict },
    }
  }
  return body
}

const toolChoice = (choice: ToolChoice): Json => {
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

const messages = (request: Request): Array<Json> => {
  const out: Array<Json> = []
  if (request.system.length > 0) out.push({ role: "system", content: request.system.join("\n\n") })
  for (const message of request.messages) {
    if (message.role === "Assistant") assistant(message, out)
    else user(message, out)
  }
  return out
}

const assistant = (message: Message, out: Array<Json>): void => {
  const textParts: Array<string> = []
  const calls: Array<Json> = []
  for (const part of message.parts) {
    if (part._tag === "Text") textParts.push(part.text)
    else if (part._tag === "Call") {
      const call = part.call
      const args = call.kind === "Function" ? call.input : stringify({ input: call.input })
      calls.push({ id: call.id, type: "function", function: { name: call.name, arguments: args } })
    }
  }
  const text = textParts.join("\n\n")
  if (text === "" && calls.length === 0) return
  const reply: JsonObject = { role: "assistant", content: text === "" ? null : text }
  if (calls.length > 0) reply["tool_calls"] = calls
  out.push(reply)
}

const user = (message: Message, out: Array<Json>): void => {
  const content: Array<JsonObject> = []
  // Images a tool returned go to the model with the next user turn.
  const images: Array<JsonObject> = []
  for (const part of message.parts) {
    switch (part._tag) {
      case "Result": {
        const result = part.result
        let text = ToolResult.text(result)
        if (result.isError && text !== "") text = `Error: ${text}`
        out.push({ role: "tool", tool_call_id: result.id, content: text })
        for (const p of result.content) {
          if (p._tag === "Image") images.push({ type: "image_url", image_url: { url: Media.url(p.media) } })
        }
        break
      }
      case "Text":
        content.push({ type: "text", text: part.text })
        break
      case "Image":
        content.push({ type: "image_url", image_url: { url: Media.url(part.media) } })
        break
      case "File":
        content.push({
          type: "file",
          file: { filename: part.media.name ?? "document.pdf", file_data: Media.url(part.media) },
        })
        break
      case "Call":
      case "Reasoning":
        break
    }
  }
  const all = images.concat(content)
  const only = all.length === 1 ? all[0] : undefined
  if (all.length === 0) return
  // A lone text part reads best as a plain string.
  if (only !== undefined && only["type"] === "text") out.push({ role: "user", content: only["text"] ?? null })
  else out.push({ role: "user", content: all })
}
