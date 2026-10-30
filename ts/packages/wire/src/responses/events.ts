// A Responses event stream from upstream, read as answer events.
import type { Usage } from "../base.ts"
import { Event, type Failure, type Stop } from "../ir.ts"
import { array, count, get, isSome, type Json, or, str } from "../json.ts"

/** Reads one answer's events. */
export class Events {
  /** Message items whose text already streamed as deltas. */
  private readonly streamed = new Set<string>()
  /** Reasoning summary parts seen, to separate them. */
  private summaries = 0
  private done = false

  /** Reads one event. */
  feed(event: Json, out: Array<Event>): void {
    const text = (key: string): string => str(get(event, key)) ?? ""
    switch (str(get(event, "type")) ?? "") {
      case "response.output_text.delta":
        this.streamed.add(text("item_id"))
        out.push(Event.Text(text("delta")))
        break
      case "response.reasoning_summary_part.added":
        if (this.summaries > 0) out.push(Event.Reasoning("\n\n"))
        this.summaries++
        break
      case "response.reasoning_summary_text.delta":
        out.push(Event.Reasoning(text("delta")))
        break
      case "response.output_item.done": {
        const item = get(event, "item")
        if (item !== undefined) this.item(item, out)
        break
      }
      case "response.completed":
      case "response.incomplete":
      case "response.done":
        this.done = true
        out.push(done(get(event, "response") ?? null))
        break
      case "response.failed":
      case "error":
        this.done = true
        out.push(Event.Error(failure(event)))
        break
    }
  }

  /** The events of a whole (unstreamed) response. */
  static whole(response: Json): Array<Event> {
    const events = new Events()
    const out: Array<Event> = []
    if (isSome(get(response, "error"))) return [Event.Error(failure(response))]
    for (const item of array(get(response, "output")) ?? []) events.item(item, out)
    out.push(done(response))
    return out
  }

  /** Reads one finished output item. */
  private item(item: Json, out: Array<Event>): void {
    const field = (key: string): string => str(get(item, key)) ?? ""
    switch (str(get(item, "type")) ?? "") {
      case "function_call":
        out.push(Event.Call({ id: field("call_id"), name: field("name"), input: field("arguments"), kind: "Function" }))
        break
      case "custom_tool_call":
        out.push(Event.Call({ id: field("call_id"), name: field("name"), input: field("input"), kind: "Freeform" }))
        break
      case "reasoning": {
        const state = str(get(item, "encrypted_content"))
        if (state !== undefined) out.push(Event.State(state))
        break
      }
      // Text that did not stream arrives whole.
      case "message":
        if (!this.streamed.has(field("id"))) {
          const text = messageText(item)
          if (text !== "") out.push(Event.Text(text))
        }
        break
    }
  }

  /** Called when the stream ends: a stream cut short is a failure. */
  finish(out: Array<Event>): void {
    if (!this.done) {
      this.done = true
      out.push(Event.Error({ status: 502, message: "the upstream stream ended before the response completed" }))
    }
  }
}

/** The events of a whole (unstreamed) response. */
export const whole = (response: Json): Array<Event> => Events.whole(response)

const messageText = (item: Json): string => {
  let text = ""
  for (const part of array(get(item, "content")) ?? []) text += str(get(part, "text")) ?? ""
  return text
}

const done = (response: Json): Event => {
  let stop: Stop
  switch (str(get(get(response, "incomplete_details"), "reason"))) {
    case "max_output_tokens":
      stop = "Length"
      break
    case "content_filter":
      stop = "Filtered"
      break
    default:
      stop = "End"
  }
  return Event.Done(stop, usage(get(response, "usage") ?? null))
}

/** Usage with cached tokens split out of `input_tokens`. */
export const usage = (value: Json): Usage => {
  const cached = count(get(get(value, "input_tokens_details"), "cached_tokens"))
  return {
    requests: 1,
    inputTokens: Math.max(count(get(value, "input_tokens")) - cached, 0),
    cacheReadTokens: cached,
    outputTokens: count(get(value, "output_tokens")),
    cacheWriteTokens: 0,
  }
}

/** A failure event's error, with the status its code implies. */
const failure = (event: Json): Failure => {
  const error = or(or(get(get(event, "response"), "error"), get(event, "error")), event) ?? event
  const code = str(or(get(error, "code"), get(error, "type"))) ?? ""
  let status: number
  switch (code) {
    case "rate_limit_exceeded":
    case "usage_limit_reached":
    case "usage_limit_exceeded":
      status = 429
      break
    case "server_is_overloaded":
    case "slow_down":
      status = 529
      break
    case "context_length_exceeded":
    case "invalid_request_error":
    case "invalid_prompt":
      status = 400
      break
    default:
      status = 500
  }
  const message = str(get(error, "message"))
  return { status, message: message === undefined || message === "" ? "the upstream response failed" : message }
}
