// A Chat Completions stream from upstream, read as answer events.
//
// Text and reasoning pass on as they arrive. Tool calls stream as argument
// fragments, possibly several at once; they are gathered and passed on
// whole when the answer ends, with the finish reason and usage (which
// comes in a chunk of its own after the last choice).
import { ids } from "@slopmax/common"

import type { Usage } from "../base.ts"
import { type Call, Event, type Failure, type Stop } from "../ir.ts"
import { array, count, get, isObject, isSome, type Json, or, parse, str, u64 } from "../json.ts"

interface Pending {
  id: string
  name: string
  arguments: string
}

/** Reads one answer's chunks. */
export class Events {
  private readonly calls = new Map<number, Pending>()
  private finishReason: string | undefined
  private usage: Usage | undefined
  private done = false

  /**
   * `freeform` names the tools the client declared as freeform, whose calls
   * carry `{"input": …}` here.
   */
  constructor(private readonly freeform: ReadonlySet<string> = new Set()) {}

  /** Reads one chunk. */
  feed(chunk: Json, out: Array<Event>): void {
    if (isSome(get(chunk, "error"))) {
      this.done = true
      out.push(Event.Error(failure(chunk)))
      return
    }
    const usage = get(chunk, "usage")
    if (isObject(usage)) this.usage = readUsage(usage)
    const choice = array(get(chunk, "choices"))?.[0]
    if (choice === undefined) return
    const delta = or(get(choice, "delta"), get(choice, "message"))
    if (delta !== undefined) this.delta(delta, out)
    const reason = str(get(choice, "finish_reason"))
    if (reason !== undefined) this.finishReason = reason
  }

  private delta(delta: Json, out: Array<Event>): void {
    for (const key of ["reasoning_content", "reasoning"]) {
      const text = str(get(delta, key))
      if (text !== undefined && text !== "") out.push(Event.Reasoning(text))
    }
    const text = str(get(delta, "content"))
    if (text !== undefined && text !== "") out.push(Event.Text(text))
    const calls = array(get(delta, "tool_calls")) ?? []
    for (let position = 0; position < calls.length; position++) {
      const call = calls[position] ?? null
      const index = u64(get(call, "index")) ?? position
      let partial = this.calls.get(index)
      if (partial === undefined) {
        partial = { id: "", name: "", arguments: "" }
        this.calls.set(index, partial)
      }
      const id = str(get(call, "id"))
      if (id !== undefined) partial.id = id
      const fn = get(call, "function")
      const name = str(get(fn, "name"))
      if (name !== undefined) partial.name += name
      const args = str(get(fn, "arguments"))
      if (args !== undefined) partial.arguments += args
    }
  }

  /**
   * Called at `[DONE]` or the end of the body: passes on the calls and
   * the end of the answer.
   */
  finish(out: Array<Event>): void {
    if (this.done) return
    this.done = true
    const indexes = [...this.calls.keys()].toSorted((a, b) => a - b)
    for (const index of indexes) {
      const partial = this.calls.get(index)
      if (partial !== undefined) out.push(Event.Call(this.call(partial)))
    }
    this.calls.clear()
    const reason = this.finishReason
    this.finishReason = undefined
    if (reason === undefined) {
      out.push(Event.Error({ status: 502, message: "the upstream stream ended before the answer finished" }))
      return
    }
    let stop: Stop
    switch (reason) {
      case "length":
        stop = "Length"
        break
      case "tool_calls":
      case "function_call":
        stop = "ToolUse"
        break
      case "content_filter":
        stop = "Filtered"
        break
      default:
        stop = "End"
    }
    const usage = this.usage ?? {
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    this.usage = undefined
    out.push(Event.Done(stop, usage))
  }

  private call(partial: Pending): Call {
    const id = partial.id === "" ? `call_${ids.token()}` : partial.id
    if (this.freeform.has(partial.name)) {
      const input = str(get(parse(partial.arguments), "input")) ?? partial.arguments
      return { id, name: partial.name, input, kind: "Freeform" }
    }
    return { id, name: partial.name, input: partial.arguments, kind: "Function" }
  }
}

/** The events of a whole (unstreamed) completion. */
export const whole = (completion: Json, freeform: ReadonlySet<string> = new Set()): Array<Event> => {
  const events = new Events(freeform)
  const out: Array<Event> = []
  events.feed(completion, out)
  events.finish(out)
  return out
}

/** Usage with cached tokens split out of `prompt_tokens`. */
export const readUsage = (usage: Json): Usage => {
  const cached = count(get(get(usage, "prompt_tokens_details"), "cached_tokens"))
  return {
    requests: 1,
    inputTokens: Math.max(count(get(usage, "prompt_tokens")) - cached, 0),
    cacheReadTokens: cached,
    outputTokens: count(get(usage, "completion_tokens")),
    cacheWriteTokens: 0,
  }
}

const failure = (chunk: Json): Failure => {
  const error = get(chunk, "error") ?? chunk
  const code = u64(get(error, "code"))
  const status = code !== undefined && code >= 400 && code < 600 ? code : 500
  return { status, message: str(get(error, "message")) ?? "the upstream answer failed" }
}
