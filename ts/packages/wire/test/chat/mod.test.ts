import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { Outcome } from "../../src/base.ts"
import { limitReached, observe } from "../../src/chat/mod.ts"

describe("chat (Rust tests)", () => {
  it("usage_comes_from_the_final_chunk", () => {
    const outcome = Outcome.make()
    observe({ object: "chat.completion.chunk", choices: [], usage: null }, outcome)
    expect(outcome.usage.outputTokens).toBe(0)
    observe(
      {
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
      },
      outcome,
    )
    const usage = outcome.usage
    expect([usage.inputTokens, usage.cacheReadTokens, usage.outputTokens]).toEqual([20, 100, 30])
  })
})

describe("chat (contract details)", () => {
  it("the limit error names its cause in the code", () => {
    expect(JSON.stringify(limitReached("spent"))).toBe(
      '{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"spent"}}',
    )
  })
})
