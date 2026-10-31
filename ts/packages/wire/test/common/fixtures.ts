// Shared by the translation tests: a reply context with predictable ids and
// time, and a reader for the server-sent events a writer produced.
import { Usage } from "@slopmax/domain"
import { DateTime, Result } from "effect"
import type { Answer, common } from "../../src/index.ts"

/** A reply context whose ids count up (`t1`, `t2`, …) and whose clock reads 2026-10-31T00:00:00Z. */
export const context = (model = "gpt-6-sol"): common.ReplyContext => {
  let next = 0
  return {
    model,
    now: DateTime.makeUnsafe("2026-10-31T00:00:00Z"),
    token: () => {
      next += 1
      return `t${next}`
    },
  }
}

export interface Frame {
  readonly event: string | undefined
  readonly data: unknown
}

/** The frames of an event stream: each one's name, if any, and its data (`[DONE]` kept as a string). */
export const framesOf = (text: string): ReadonlyArray<Frame> =>
  text
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const lines = frame.split("\n")
      const named = lines.find((line) => line.startsWith("event: "))
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? ""
      return { event: named?.slice(7), data: data === "[DONE]" ? data : JSON.parse(data) }
    })

/** Everything a writer writes for these events, in order. */
export const written = (writer: common.AnswerWriter, events: ReadonlyArray<common.Event>): string =>
  events.map((event) => writer.write(event)).join("")

/** The value of a successful result; a failure fails the test with its error. */
export const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A gathered answer with nothing in it but `fields`. */
export const answer = (fields: Partial<Answer>): Answer => ({
  text: "",
  reasoning: "",
  calls: [],
  stop: undefined,
  usage: Usage.zero,
  failure: undefined,
  ...fields,
})
