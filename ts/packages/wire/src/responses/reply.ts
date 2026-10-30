// Answers from another format, told in Responses: the event stream Codex
// reads, or a whole response.
import { ids, Timestamp } from "@slopmax/common"

import { frame, type Usage } from "../base.ts"
import { Answer, type Call, type Event, type Failure } from "../ir.ts"
import type { Json, JsonObject } from "../json.ts"
import { seal } from "./compaction.ts"

/** The item being streamed. */
interface Open {
  readonly kind: "Message" | "Reasoning"
  readonly id: string
  text: string
}

/** Encodes one answer as a Responses event stream. */
export class Reply {
  private readonly id: string
  private readonly created: number
  private sequence = 0
  private started = false
  private open: Open | undefined
  /** Finished items, for the final response. */
  private readonly output: Array<Json> = []
  /** Compacting: the answer's text is gathered into one compaction item. */
  private summary: string | undefined

  /** `now` is the clock's time (the Rust reads the clock here). */
  constructor(
    private readonly model: string,
    now: Timestamp,
  ) {
    this.id = `resp_${ids.token()}`
    this.created = Timestamp.asSecond(now)
  }

  /** An encoder that turns the answer into one compaction item. */
  static compacting(model: string, now: Timestamp): Reply {
    const reply = new Reply(model, now)
    reply.summary = ""
    return reply
  }

  private send(kind: string, data: JsonObject): string {
    data["type"] = kind
    data["sequence_number"] = this.sequence++
    return frame(kind, data)
  }

  private response(status: string): JsonObject {
    return {
      id: this.id,
      object: "response",
      created_at: this.created,
      status,
      model: this.model,
      output: this.output.slice(),
    }
  }

  /** The frames for `event`. */
  event(event: Event): string {
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
          const item = compactionItem(this.summary)
          this.summary = ""
          out += this.send("response.output_item.added", { output_index: this.output.length, item })
          out += this.finishItem(item)
          break
        }
        case "Error":
          break
        default:
          return out
      }
    }
    switch (event._tag) {
      case "Text": {
        if (this.open?.kind !== "Message") out += this.close() + this.openMessage()
        const open = this.open
        if (open !== undefined) {
          open.text += event.text
          const data = { item_id: open.id, output_index: this.output.length, content_index: 0, delta: event.text }
          out += this.send("response.output_text.delta", data)
        }
        break
      }
      case "Reasoning": {
        if (this.open?.kind !== "Reasoning") out += this.close() + this.openReasoning()
        const open = this.open
        if (open !== undefined) {
          open.text += event.text
          const data = { item_id: open.id, output_index: this.output.length, summary_index: 0, delta: event.text }
          out += this.send("response.reasoning_summary_text.delta", data)
        }
        break
      }
      case "State":
        break
      case "Call":
        out += this.close()
        out += this.call(event.call)
        break
      case "Done": {
        out += this.close()
        const response = this.response("completed")
        response["usage"] = usageJson(event.usage)
        let kind = "response.completed"
        if (event.stop === "Length") {
          response["status"] = "incomplete"
          response["incomplete_details"] = { reason: "max_output_tokens" }
          kind = "response.incomplete"
        }
        out += this.send(kind, { response })
        break
      }
      case "Error": {
        out += this.close()
        const response = this.response("failed")
        response["error"] = errorJson(event.failure)
        out += this.send("response.failed", { response })
        break
      }
    }
    return out
  }

  private openMessage(): string {
    const id = `msg_${ids.token()}`
    const index = this.output.length
    const item = { id, type: "message", role: "assistant", status: "in_progress", content: [] }
    let out = this.send("response.output_item.added", { output_index: index, item })
    const part = { type: "output_text", text: "", annotations: [] }
    out += this.send("response.content_part.added", { item_id: id, output_index: index, content_index: 0, part })
    this.open = { kind: "Message", id, text: "" }
    return out
  }

  private openReasoning(): string {
    const id = `rs_${ids.token()}`
    const index = this.output.length
    const item = { id, type: "reasoning", summary: [] }
    let out = this.send("response.output_item.added", { output_index: index, item })
    const part = { type: "summary_text", text: "" }
    out += this.send("response.reasoning_summary_part.added", {
      item_id: id,
      output_index: index,
      summary_index: 0,
      part,
    })
    this.open = { kind: "Reasoning", id, text: "" }
    return out
  }

  /** Finishes the item being streamed. */
  close(): string {
    const open = this.open
    if (open === undefined) return ""
    this.open = undefined
    const index = this.output.length
    const { id, text } = open
    let out = ""
    let item: JsonObject
    if (open.kind === "Message") {
      const part = { type: "output_text", text, annotations: [] }
      out += this.send("response.output_text.done", { item_id: id, output_index: index, content_index: 0, text })
      out += this.send("response.content_part.done", { item_id: id, output_index: index, content_index: 0, part })
      item = { id, type: "message", role: "assistant", status: "completed", content: [part] }
    } else {
      const part = { type: "summary_text", text }
      out += this.send("response.reasoning_summary_text.done", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        text,
      })
      out += this.send("response.reasoning_summary_part.done", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part,
      })
      item = { id, type: "reasoning", summary: [part] }
    }
    return out + this.finishItem(item)
  }

  private call(call: Call): string {
    const index = this.output.length
    const freeform = call.kind === "Freeform"
    const item: JsonObject = freeform
      ? {
          id: `ctc_${ids.token()}`,
          type: "custom_tool_call",
          status: "completed",
          call_id: call.id,
          name: call.name,
          input: call.input,
        }
      : {
          id: `fc_${ids.token()}`,
          type: "function_call",
          status: "completed",
          call_id: call.id,
          name: call.name,
          arguments: call.input,
        }
    const delta = freeform ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta"
    const done = freeform ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done"
    const added = { ...item, status: "in_progress" }
    const id = item["id"] ?? null
    let out = this.send("response.output_item.added", { output_index: index, item: added })
    out += this.send(delta, { item_id: id, output_index: index, delta: call.input })
    out += this.send(done, { item_id: id, output_index: index, [freeform ? "input" : "arguments"]: call.input })
    return out + this.finishItem(item)
  }

  private finishItem(item: JsonObject): string {
    const out = this.send("response.output_item.done", { output_index: this.output.length, item })
    this.output.push(item)
    return out
  }

  /** The final response, once the answer has run through `event`. */
  private completedWith(usage: Usage): JsonObject {
    const response = this.response("completed")
    response["usage"] = usageJson(usage)
    return response
  }

  /** A whole compaction answer: one compaction item. */
  static compacted(answer: Answer, model: string, now: Timestamp): JsonObject {
    const reply = new Reply(model, now)
    reply.output.push(compactionItem(answer.text))
    return reply.completedWith(answer.usage)
  }

  /** A whole answer as one response. */
  static whole(answer: Answer, model: string, now: Timestamp): JsonObject {
    const reply = new Reply(model, now)
    // Run the answer through the stream encoder and keep its final shape.
    reply.started = true
    if (answer.reasoning !== "") reply.event({ _tag: "Reasoning", text: answer.reasoning })
    if (answer.text !== "") reply.event({ _tag: "Text", text: answer.text })
    for (const call of answer.calls) reply.event({ _tag: "Call", call })
    reply.close()
    const response = reply.completedWith(answer.usage)
    if (Answer.stop(answer) === "Length") {
      response["status"] = "incomplete"
      response["incomplete_details"] = { reason: "max_output_tokens" }
    }
    return response
  }
}

/** A summary sealed in a compaction item. */
const compactionItem = (summary: string): JsonObject => ({
  id: `cmp_${ids.token()}`,
  type: "compaction",
  encrypted_content: seal(summary),
})

/** A whole compaction answer: one compaction item. */
export const compacted = (answer: Answer, model: string, now: Timestamp): JsonObject =>
  Reply.compacted(answer, model, now)

/** A whole answer as one response. */
export const whole = (answer: Answer, model: string, now: Timestamp): JsonObject => Reply.whole(answer, model, now)

const usageJson = (usage: Usage): JsonObject => {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.outputTokens,
  }
}

const errorJson = (failure: Failure): JsonObject => {
  let code: string
  switch (failure.status) {
    case 429:
      code = "rate_limit_exceeded"
      break
    case 503:
    case 529:
      code = "server_is_overloaded"
      break
    case 400:
      code = "invalid_request_error"
      break
    default:
      code = "server_error"
  }
  return { code, message: failure.message }
}
