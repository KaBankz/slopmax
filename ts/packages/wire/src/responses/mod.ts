// OpenAI Responses.
import { SignedDuration, Timestamp } from "@slopmax/common"

import { type Limit, Opening, type Outcome } from "../base.ts"
import { count, get, type Json, type JsonObject, or, str } from "../json.ts"

export const error = (kind: string, message: string): JsonObject => ({ error: { type: kind, message } })

/**
 * Codex shows `usage_limit_reached` as its usage-limit message and waits
 * until `resets_at`.
 */
export const limitReached = (message: string, until: Timestamp, now: Timestamp): Limit => {
  const body: JsonObject = {
    error: {
      type: "usage_limit_reached",
      message,
      resets_at: Timestamp.asSecond(until),
      resets_in_seconds: Math.max(SignedDuration.asSecs(Timestamp.durationSince(until, now)), 1),
    },
  }
  return [body, []]
}

/**
 * Lifecycle events say nothing yet; a failure coded as a spent quota or
 * throttling is the account's, anything else (context length, policy) is
 * the request's and goes to the agent.
 */
export const opening = (event: Json): Opening => {
  switch (str(get(event, "type"))) {
    case "response.created":
    case "response.in_progress":
    case "response.queued":
      return Opening.Wait
    case "response.failed":
    case "error":
      switch (failureCode(event)) {
        case "usage_limit_reached":
        case "usage_limit_exceeded":
          return Opening.Refused(true)
        case "server_is_overloaded":
        case "slow_down":
        case "rate_limit_exceeded":
          return Opening.Refused(false)
        default:
          return Opening.Content
      }
    default:
      return Opening.Content
  }
}

const counted = (usage: Json, outcome: Outcome): void => {
  const cached = count(get(get(usage, "input_tokens_details"), "cached_tokens"))
  // Cached tokens are counted inside input_tokens.
  outcome.usage = {
    ...outcome.usage,
    inputTokens: Math.max(count(get(usage, "input_tokens")) - cached, 0),
    cacheReadTokens: cached,
    outputTokens: count(get(usage, "output_tokens")),
  }
}

const failureCode = (event: Json): string | undefined => {
  const found = or(get(get(event, "response"), "error"), get(event, "error"))
  if (found === undefined) return undefined
  return str(or(get(found, "code"), get(found, "type")))
}

/**
 * The final `response.*` event carries usage (as does a whole `response`
 * object from a non-streaming request); a failure coded
 * `usage_limit_reached` means the quota ran out mid-stream.
 */
export const observe = (event: Json, outcome: Outcome): void => {
  if (str(get(event, "object")) === "response") {
    const usage = get(event, "usage")
    if (usage !== undefined) counted(usage, outcome)
    return
  }
  switch (str(get(event, "type"))) {
    case "response.completed":
    case "response.incomplete":
    case "response.done": {
      const usage = get(get(event, "response"), "usage")
      if (usage !== undefined) counted(usage, outcome)
      break
    }
    case "response.failed":
    case "error": {
      const code = failureCode(event)
      if (code === "usage_limit_reached" || code === "usage_limit_exceeded") outcome.exhausted = true
      break
    }
  }
}
