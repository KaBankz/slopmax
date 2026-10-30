// Messages requests, decoded for a model that speaks another format.
import { Result } from "effect"

import { text as texts } from "@slopmax/common"

import {
  type Call,
  Effort,
  type Media,
  type Message,
  Part,
  Request,
  type Role,
  Source,
  type Tool,
  ToolChoice,
} from "../ir.ts"
import { array, bool, f64, get, type Json, str, stringify, strOf, u64 } from "../json.ts"

/** Claude Code's billing line, which only Anthropic reads. */
const BILLING = "x-anthropic-billing-header:"

const isBlank = (s: string): boolean => texts.trim(s) === ""

export const decode = (body: Json): Result.Result<Request, string> => {
  const model = str(get(body, "model"))
  if (model === undefined) return Result.fail("the request names no model")
  const system: Array<string> = []
  const pushSystem = (text: string): void => {
    if (!isBlank(text) && !text.startsWith(BILLING)) system.push(text)
  }
  const systemField = get(body, "system")
  if (typeof systemField === "string") {
    pushSystem(systemField)
  } else if (Array.isArray(systemField)) {
    for (const block of systemField) {
      const text = str(get(block, "text"))
      if (text !== undefined) pushSystem(text)
    }
  }
  const messages: Array<Message> = []
  for (const message of array(get(body, "messages")) ?? []) {
    const role: Role = str(get(message, "role")) === "assistant" ? "Assistant" : "User"
    const content = get(message, "content")
    let parts: Array<Part> = []
    if (typeof content === "string") parts = [Part.Text(content)]
    else if (Array.isArray(content)) parts = partsOf(content)
    if (parts.length > 0) messages.push({ role, parts })
  }
  // Client tools carry a schema; Anthropic's server tools (web search,
  // code execution) only work on Anthropic and are left out.
  const tools: Array<Tool> = []
  for (const tool of array(get(body, "tools")) ?? []) {
    const name = str(get(tool, "name"))
    const schema = get(tool, "input_schema")
    if (name === undefined || schema === undefined) continue
    tools.push({ name, description: strOf(tool, "description"), schema, kind: "Function" })
  }
  let toolChoice = ToolChoice.Auto
  let parallelToolCalls: boolean | undefined
  const choice = get(body, "tool_choice")
  if (choice !== undefined) {
    switch (str(get(choice, "type"))) {
      case "any":
        toolChoice = ToolChoice.Required
        break
      case "none":
        toolChoice = ToolChoice.None
        break
      case "tool":
        toolChoice = ToolChoice.Named(strOf(choice, "name"))
        break
      default:
        toolChoice = ToolChoice.Auto
    }
    if (bool(get(choice, "disable_parallel_tool_use")) === true) parallelToolCalls = false
  }
  const stop: Array<string> = []
  for (const s of array(get(body, "stop_sequences")) ?? []) if (typeof s === "string") stop.push(s)
  return Result.succeed(
    Request.make({
      model,
      stream: bool(get(body, "stream")) === true,
      maxTokens: u64(get(body, "max_tokens")),
      temperature: f64(get(body, "temperature")),
      topP: f64(get(body, "top_p")),
      system,
      messages,
      tools,
      toolChoice,
      parallelToolCalls,
      stop,
      effort: effort(body),
    }),
  )
}

/** The effort asked for: named outright, or implied by a thinking budget. */
const effort = (body: Json): Effort | undefined => {
  const name = str(get(get(body, "output_config"), "effort"))
  const named = name === undefined ? undefined : Effort.parse(name)
  if (named !== undefined) return named
  const thinking = get(body, "thinking")
  if (thinking === undefined) return undefined
  switch (str(get(thinking, "type"))) {
    case "enabled": {
      const budget = u64(get(thinking, "budget_tokens"))
      return budget === undefined ? undefined : Effort.fromBudget(budget)
    }
    case "disabled":
      return "Low"
    default:
      return undefined
  }
}

const partsOf = (blocks: ReadonlyArray<Json>): Array<Part> => {
  const parts: Array<Part> = []
  for (const block of blocks) {
    const p = part(block)
    if (p !== undefined) parts.push(p)
  }
  return parts
}

const part = (block: Json): Part | undefined => {
  switch (str(get(block, "type"))) {
    case "text": {
      const text = str(get(block, "text"))
      return text === undefined || text === "" ? undefined : Part.Text(text)
    }
    case "image": {
      const m = media(block)
      return m === undefined ? undefined : Part.Image(m)
    }
    case "document": {
      const source = get(block, "source")
      if (source === undefined) return undefined
      // A plain-text document is just text.
      if (str(get(source, "type")) === "text") {
        const text = str(get(source, "data"))
        return text === undefined ? undefined : Part.Text(text)
      }
      const file = media(block)
      if (file === undefined) return undefined
      return Part.File({ ...file, name: str(get(block, "title")) })
    }
    case "tool_use": {
      const input = get(block, "input")
      const call: Call = {
        id: strOf(block, "id"),
        name: strOf(block, "name"),
        input: input === undefined ? "{}" : stringify(input),
        kind: "Function",
      }
      return Part.Call(call)
    }
    case "tool_result": {
      const content = get(block, "content")
      let parts: Array<Part> = []
      if (typeof content === "string") parts = [Part.Text(content)]
      else if (Array.isArray(content)) parts = partsOf(content)
      return Part.Result({
        id: strOf(block, "tool_use_id"),
        content: parts,
        isError: bool(get(block, "is_error")) === true,
      })
    }
    // Thinking carries Anthropic's signature, which no one else can
    // read; server tool blocks only make sense on Anthropic.
    default:
      return undefined
  }
}

const media = (block: Json): Media | undefined => {
  const source = get(block, "source")
  if (source === undefined) return undefined
  const mediaType = strOf(source, "media_type")
  switch (str(get(source, "type"))) {
    case "base64":
      return { mediaType, source: Source.Base64(strOf(source, "data")), name: undefined }
    case "url":
      return { mediaType, source: Source.Url(strOf(source, "url")), name: undefined }
    default:
      return undefined
  }
}
