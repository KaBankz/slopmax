// OpenAI Chat Completions.
import type { Outcome } from "../base.ts"
import { count, get, isObject, type Json, type JsonObject } from "../json.ts"

/** Clients read `retry-after`; the code names the cause. */
export const limitReached = (message: string): JsonObject => ({
  error: { type: "rate_limit_error", code: "rate_limit_exceeded", message },
})

/**
 * A whole `chat.completion`, or the stream chunk that carries usage (the
 * last one, when the client asked for `stream_options.include_usage`).
 */
export const observe = (event: Json, outcome: Outcome): void => {
  const usage = get(event, "usage")
  if (!isObject(usage)) return
  const cached = count(get(get(usage, "prompt_tokens_details"), "cached_tokens"))
  // Cached tokens are counted inside prompt_tokens.
  outcome.usage = {
    ...outcome.usage,
    inputTokens: Math.max(count(get(usage, "prompt_tokens")) - cached, 0),
    cacheReadTokens: cached,
    outputTokens: count(get(usage, "completion_tokens")),
  }
}
