import { describe, expect } from "bun:test"
import { Dialect, Usage } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Schema } from "effect"
import { observe, observers, TapOutcome, textOf } from "../../src/index.ts"

const fold = (dialect: Dialect, ...events: ReadonlyArray<unknown>): TapOutcome =>
  events.reduce<TapOutcome>((outcome, event) => observe(dialect, outcome, event), TapOutcome.empty)

const counts = (usage: Usage) => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
})

describe("formats", () => {
  it("are named messages, responses and chat, and each has its own observer", () => {
    expect(Dialect.literals).toEqual(["messages", "responses", "chat"])
    expect(Schema.decodeUnknownSync(Dialect)("responses")).toBe("responses")
    expect(Object.keys(observers)).toEqual(["messages", "responses", "chat"])
  })
})

describe("Messages usage", () => {
  it("is read from message_start, then each message_delta's running totals", () => {
    const outcome = fold(
      "messages",
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 2095,
            cache_creation_input_tokens: 7185,
            cache_read_input_tokens: 355_598,
            output_tokens: 1,
          },
        },
      },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 15 } },
    )
    expect(counts(outcome.usage)).toEqual({ input: 2095, output: 15, cacheRead: 355_598, cacheWrite: 7185 })
    expect(outcome.exhausted).toBe(false)
    expect(outcome.failed).toBe(false)
  })

  it("keeps a count when a later event says zero, which means unchanged", () => {
    const outcome = fold(
      "messages",
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "message_delta", usage: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 0 } },
    )
    expect(counts(outcome.usage)).toEqual({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0 })
  })

  it("is read from a whole message answer", () => {
    const outcome = fold("messages", { type: "message", content: [], usage: { input_tokens: 12, output_tokens: 3 } })
    expect(counts(outcome.usage)).toEqual({ input: 12, output: 3, cacheRead: 0, cacheWrite: 0 })
  })

  it("ignores counts that are not whole numbers, and events of other types", () => {
    const outcome = fold(
      "messages",
      { type: "message_delta", usage: { output_tokens: -3, input_tokens: 1.5, cache_read_input_tokens: "9" } },
      { type: "ping", usage: { output_tokens: 99 } },
    )
    expect(outcome).toBe(TapOutcome.empty)
  })

  it("marks the account spent on a rate_limit_error event, and any error event as a failure", () => {
    const spent = fold("messages", { type: "error", error: { type: "rate_limit_error", message: "slow down" } })
    expect([spent.exhausted, spent.failed]).toEqual([true, true])
    const overloaded = fold("messages", { type: "error", error: { type: "overloaded_error" } })
    expect([overloaded.exhausted, overloaded.failed]).toEqual([false, true])
  })
})

describe("Responses usage", () => {
  it("counts cached input apart from the rest of the input", () => {
    const outcome = fold("responses", {
      type: "response.completed",
      response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 25 }, output_tokens: 40 } },
    })
    expect(counts(outcome.usage)).toEqual({ input: 75, output: 40, cacheRead: 25, cacheWrite: 0 })
  })

  it("is read from the last event of a stream, however it ended, or from a whole response", () => {
    for (const type of ["response.completed", "response.incomplete", "response.done"]) {
      const outcome = fold("responses", { type, response: { usage: { input_tokens: 9, output_tokens: 3 } } })
      expect([type, counts(outcome.usage)]).toEqual([type, { input: 9, output: 3, cacheRead: 0, cacheWrite: 0 }])
    }
    const whole = fold("responses", {
      object: "response",
      usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5 },
    })
    expect(counts(whole.usage)).toEqual({ input: 30, output: 5, cacheRead: 20, cacheWrite: 0 })
    expect(fold("responses", { type: "response.created", response: { usage: null } })).toBe(TapOutcome.empty)
  })

  it("never counts input below zero when more is cached than was sent", () => {
    const outcome = fold("responses", {
      type: "response.completed",
      response: { usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 8 }, output_tokens: 1 } },
    })
    expect(outcome.usage.input).toBe(0)
    expect(outcome.usage.cacheRead).toBe(8)
  })

  it("marks the account spent when the stream fails coded as a spent quota", () => {
    for (const code of ["usage_limit_reached", "usage_limit_exceeded"]) {
      expect(fold("responses", { type: "response.failed", response: { error: { code } } }).exhausted).toBe(true)
      expect(fold("responses", { type: "error", error: { code } }).exhausted).toBe(true)
      expect(fold("responses", { type: "error", error: { type: code } }).exhausted).toBe(true)
    }
    const other = fold("responses", {
      type: "response.failed",
      response: { error: { code: "context_length_exceeded" } },
    })
    expect([other.exhausted, other.failed]).toEqual([false, true])
  })
})

describe("Chat usage", () => {
  it("comes from the final chunk, with cached prompt tokens counted apart", () => {
    const outcome = fold(
      "chat",
      { object: "chat.completion.chunk", choices: [], usage: null },
      {
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
      },
    )
    expect(counts(outcome.usage)).toEqual({ input: 20, output: 30, cacheRead: 100, cacheWrite: 0 })
  })

  it("is read from a whole completion, and an error object is a failure", () => {
    const outcome = fold("chat", { object: "chat.completion", usage: { prompt_tokens: 7, completion_tokens: 2 } })
    expect(counts(outcome.usage)).toEqual({ input: 7, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(fold("chat", { error: { message: "bad" } }).failed).toBe(true)
  })
})

describe("TapOutcome", () => {
  it("counts the answer as one request", () => {
    const outcome = fold("chat", { usage: { prompt_tokens: 7, completion_tokens: 2 } }).counted()
    expect(outcome.usage.requests).toBe(1)
    expect(outcome.usage.tokens).toBe(9)
    expect(TapOutcome.empty.counted().usage.requests).toBe(1)
  })
})

describe("textOf", () => {
  it("reads a string, or the text of each part joined by newlines", () => {
    expect(textOf("plain")).toBe("plain")
    expect(
      textOf([
        { type: "text", text: "one" },
        { type: "image", source: {} },
        { type: "input_text", text: "two" },
      ]),
    ).toBe("one\ntwo")
    expect(textOf([])).toBe("")
    expect(textOf(null)).toBe("")
    expect(textOf({ text: "not a list" })).toBe("")
  })
})
