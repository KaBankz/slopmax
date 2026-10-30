// Answers from another format, told in Messages: the event stream Claude
// Code reads, or a whole message.
import { ids, text } from "@slopmax/common"

import { frame, type Usage } from "../base.ts"
import { Answer, type Call, type Event, Failure, type Stop } from "../ir.ts"
import { type Json, type JsonObject, parse, stringify } from "../json.ts"
import { error } from "./mod.ts"

/** Encodes one answer as a Messages event stream. */
export class Reply {
  private readonly id: string
  private started = false
  /** The next content block's index. */
  private index = 0
  /** Whether a text block is open. */
  private text = false
  /** Whether the answer called tools, which is why it stops. */
  private called = false

  constructor(private readonly model: string) {
    this.id = `msg_${ids.token()}`
  }

  /** The frames for `event`. */
  event(event: Event): string {
    let out = ""
    if (!this.started) {
      this.started = true
      const message: JsonObject = {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
      out += frame("message_start", { type: "message_start", message })
    }
    switch (event._tag) {
      case "Text": {
        if (!this.text) {
          this.text = true
          const start = { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } }
          out += frame("content_block_start", start)
        }
        const delta = {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "text_delta", text: event.text },
        }
        out += frame("content_block_delta", delta)
        break
      }
      // Reasoning from another model is not shown: Claude Code would
      // send it back to Anthropic, which rejects thinking it did not
      // sign.
      case "Reasoning":
      case "State":
        break
      case "Call": {
        const call = event.call
        out += this.close()
        const start = {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        }
        out += frame("content_block_start", start)
        const delta = {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "input_json_delta", partial_json: input(call) },
        }
        out += frame("content_block_delta", delta)
        out += this.stopBlock()
        this.called = true
        break
      }
      case "Done": {
        out += this.close()
        const stop: Stop = event.stop === "End" && this.called ? "ToolUse" : event.stop
        const delta = {
          type: "message_delta",
          delta: { stop_reason: stopReason(stop), stop_sequence: null },
          usage: usageJson(event.usage),
        }
        out += frame("message_delta", delta)
        out += frame("message_stop", { type: "message_stop" })
        break
      }
      case "Error": {
        out += this.close()
        out += frame("error", error(Failure.kind(event.failure), event.failure.message))
        break
      }
    }
    return out
  }

  private close(): string {
    if (!this.text) return ""
    this.text = false
    return this.stopBlock()
  }

  private stopBlock(): string {
    const out = frame("content_block_stop", { type: "content_block_stop", index: this.index })
    this.index++
    return out
  }
}

/** A whole answer as one message. */
export const whole = (answer: Answer, model: string): JsonObject => {
  const content: Array<Json> = []
  if (answer.text !== "") content.push({ type: "text", text: answer.text })
  for (const call of answer.calls) {
    const parsed = parse(input(call))
    content.push({ type: "tool_use", id: call.id, name: call.name, input: parsed === undefined ? {} : parsed })
  }
  return {
    id: `msg_${ids.token()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(Answer.stop(answer)),
    stop_sequence: null,
    usage: usageJson(answer.usage),
  }
}

/** The call's input as a JSON object: freeform input is wrapped. */
const input = (call: Call): string => {
  if (call.kind === "Freeform") return stringify({ input: call.input })
  return text.trim(call.input) === "" ? "{}" : call.input
}

const stopReason = (stop: Stop): string => {
  switch (stop) {
    case "End":
      return "end_turn"
    case "ToolUse":
      return "tool_use"
    case "Length":
      return "max_tokens"
    case "Sequence":
      return "stop_sequence"
    case "Filtered":
      return "refusal"
  }
}

const usageJson = (usage: Usage): JsonObject => ({
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  cache_read_input_tokens: usage.cacheReadTokens,
  cache_creation_input_tokens: usage.cacheWriteTokens,
})
