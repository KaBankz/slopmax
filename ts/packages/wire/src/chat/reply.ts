// Answers from another format, told in Chat Completions: a chunk stream,
// or a whole completion.
import { ids, Timestamp } from "@slopmax/common"

import { frame, type Usage } from "../base.ts"
import { Answer, type Call, type Event, Failure, type Stop } from "../ir.ts"
import { type Json, type JsonObject, stringify } from "../json.ts"

const DONE = "data: [DONE]\n\n"

/** Encodes one answer as a chunk stream. */
export class Reply {
  private readonly id: string
  private readonly created: number
  private started = false
  private calls = 0

  /**
   * `includeUsage`: whether the client asked for a usage chunk. `now` is
   * the clock's time (the Rust reads the clock here).
   */
  constructor(
    private readonly model: string,
    private readonly includeUsage: boolean,
    now: Timestamp,
  ) {
    this.id = `chatcmpl-${ids.token()}`
    this.created = Timestamp.asSecond(now)
  }

  private chunk(delta: JsonObject, finish: string | null): string {
    return frame(undefined, {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  }

  /** The chunks for `event`. */
  event(event: Event): string {
    let out = ""
    if (!this.started) {
      this.started = true
      out += this.chunk({ role: "assistant", content: "" }, null)
    }
    switch (event._tag) {
      case "Text":
        out += this.chunk({ content: event.text }, null)
        break
      // Not in the Chat spec, but widely shown by Chat clients.
      case "Reasoning":
        out += this.chunk({ reasoning_content: event.text }, null)
        break
      case "State":
        break
      case "Call": {
        const delta = { tool_calls: [toolCall(event.call, this.calls)] }
        this.calls++
        out += this.chunk(delta, null)
        break
      }
      case "Done": {
        const stop: Stop = this.calls > 0 && event.stop === "End" ? "ToolUse" : event.stop
        out += this.chunk({}, finishReason(stop))
        if (this.includeUsage) {
          out += frame(undefined, {
            id: this.id,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.model,
            choices: [],
            usage: usageJson(event.usage),
          })
        }
        out += DONE
        break
      }
      case "Error": {
        const failure = event.failure
        const error = { error: { message: failure.message, type: Failure.kind(failure), code: failure.status } }
        out += frame(undefined, error) + DONE
        break
      }
    }
    return out
  }
}

/** A whole answer as one completion. */
export const whole = (answer: Answer, model: string, now: Timestamp): JsonObject => {
  const message: JsonObject = { role: "assistant", content: answer.text === "" ? null : answer.text }
  if (answer.reasoning !== "") message["reasoning_content"] = answer.reasoning
  if (answer.calls.length > 0) message["tool_calls"] = answer.calls.map((c) => toolCall(c, undefined))
  return {
    id: `chatcmpl-${ids.token()}`,
    object: "chat.completion",
    created: Timestamp.asSecond(now),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(Answer.stop(answer)) }],
    usage: usageJson(answer.usage),
  }
}

const toolCall = (call: Call, index: number | undefined): Json => {
  const args = call.kind === "Function" ? call.input : stringify({ input: call.input })
  const value: JsonObject = { id: call.id, type: "function", function: { name: call.name, arguments: args } }
  if (index !== undefined) value["index"] = index
  return value
}

const finishReason = (stop: Stop): string => {
  switch (stop) {
    case "End":
    case "Sequence":
      return "stop"
    case "ToolUse":
      return "tool_calls"
    case "Length":
      return "length"
    case "Filtered":
      return "content_filter"
  }
}

const usageJson = (usage: Usage): JsonObject => {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  }
}
