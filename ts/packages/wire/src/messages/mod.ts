// Anthropic Messages.
import { Timestamp } from "@slopmax/common"

import type { Limit, Outcome } from "../base.ts"
import { get, type Json, type JsonObject, str, u64 } from "../json.ts"

export const error = (kind: string, message: string): JsonObject => ({
  type: "error",
  error: { type: kind, message },
})

/**
 * Claude Code treats a rejected unified limit as the account's usage limit
 * and reads the reset time from the header.
 */
export const limitReached = (message: string, until: Timestamp): Limit => [
  error("rate_limit_error", message),
  [
    ["anthropic-ratelimit-unified-status", "rejected"],
    ["anthropic-ratelimit-unified-reset", String(Timestamp.asSecond(until))],
  ],
]

/**
 * `message_start` and `message_delta` carry usage (as does a whole
 * `message` from a non-streaming request); an `error` event of type
 * `rate_limit_error` means the quota ran out mid-stream.
 */
export const observe = (event: Json, outcome: Outcome): void => {
  let usage: Json | undefined
  switch (str(get(event, "type"))) {
    case "message":
    case "message_delta":
      usage = get(event, "usage")
      break
    case "message_start":
      usage = get(get(event, "message"), "usage")
      break
    case "error":
      if (str(get(get(event, "error"), "type")) === "rate_limit_error") outcome.exhausted = true
      return
    default:
      return
  }
  if (usage === undefined) return
  // A later event carries cumulative counts; zeros mean "unchanged".
  const field = (name: string): number | undefined => {
    const n = u64(get(usage, name))
    return n !== undefined && n > 0 ? n : undefined
  }
  const input = field("input_tokens")
  const output = field("output_tokens")
  const cacheRead = field("cache_read_input_tokens")
  const cacheWrite = field("cache_creation_input_tokens")
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return
  const total = outcome.usage
  outcome.usage = {
    ...total,
    inputTokens: input ?? total.inputTokens,
    outputTokens: output ?? total.outputTokens,
    cacheReadTokens: cacheRead ?? total.cacheReadTokens,
    cacheWriteTokens: cacheWrite ?? total.cacheWriteTokens,
  }
}
