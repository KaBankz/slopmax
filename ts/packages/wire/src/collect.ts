// A whole answer, gathered from its events.
//
// A client that asked for one JSON answer (`stream: false`, or a warmup) is
// still answered by a streaming upstream: slopmax always asks to stream, so
// it reads the stream to its end and writes the client one document.
import { Usage } from "@slopmax/domain"
import { Schema } from "effect"
import { type Event, Failure, Stop, ToolCall } from "./common.ts"

export const Answer = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  calls: Schema.Array(ToolCall),
  /** Why it ended, when it said so. */
  stop: Schema.UndefinedOr(Stop),
  usage: Usage,
  /** The last failure it reported. */
  failure: Schema.UndefinedOr(Failure),
})
export type Answer = typeof Answer.Type

/** Gathers an answer: its text and reasoning in order, every call, and the last end and failure it reported. */
export const collect = (events: Iterable<Event>): Answer => {
  let text = ""
  let reasoning = ""
  const calls: Array<ToolCall> = []
  let stop: Stop | undefined
  let usage = Usage.zero
  let failure: Failure | undefined
  for (const event of events) {
    switch (event._tag) {
      case "Text":
        text += event.text
        break
      case "Reasoning":
        reasoning += event.text
        break
      case "State":
        break
      case "Call":
        calls.push(event.call)
        break
      case "Done":
        stop = event.stop
        usage = event.usage
        break
      case "Failed":
        failure = event.failure
        break
    }
  }
  return { text, reasoning, calls, stop, usage, failure }
}

/**
 * Why the answer ended. Providers that end a turn with calls do not all say
 * so; an answer that called tools and ended normally (or never said) is
 * waiting for their results.
 */
export const stopOf = (answer: Answer): Stop =>
  (answer.stop === undefined || answer.stop === "end") && answer.calls.length > 0 ? "toolUse" : (answer.stop ?? "end")

/** Whether the answer is only a failure: nothing was said before it broke off. */
export const onlyFailed = (answer: Answer): answer is Answer & { readonly failure: Failure } =>
  answer.failure !== undefined && answer.text.length === 0 && answer.calls.length === 0
