// The parts of lib.rs every format uses: token counts, how a stream opens
// and what it said, and server-sent event frames. They live apart from
// `Dialect` so the formats can use them without importing it back.
import { Schema } from "effect"

import { type Json, type JsonObject, stringify } from "./json.ts"

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** `Usage` on disk and in the API: snake_case keys, every one required. */
export const UsageSchema = Schema.Struct({
  requests: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
}).pipe(
  Schema.encodeKeys({
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheReadTokens: "cache_read_tokens",
    cacheWriteTokens: "cache_write_tokens",
  }),
)

/** Token counts: one answer's, or everything an account has served. */
export type Usage = typeof UsageSchema.Type

export const Usage = {
  zero: (): Usage => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),

  /** `self` plus `other`, kind by kind. */
  add: (self: Usage, other: Usage): Usage => ({
    requests: self.requests + other.requests,
    inputTokens: self.inputTokens + other.inputTokens,
    outputTokens: self.outputTokens + other.outputTokens,
    cacheReadTokens: self.cacheReadTokens + other.cacheReadTokens,
    cacheWriteTokens: self.cacheWriteTokens + other.cacheWriteTokens,
  }),

  totalTokens: (self: Usage): number =>
    self.inputTokens + self.outputTokens + self.cacheReadTokens + self.cacheWriteTokens,
} as const

/** How a stream opens, judged one event at a time. */
export type Opening =
  /** Nothing telling yet (the response was merely created). */
  | { readonly _tag: "Wait" }
  /** Content began, or a failure that belongs to the request. */
  | { readonly _tag: "Content" }
  /**
   * A refusal another account may not give: a spent quota (`exhausted`) or
   * throttling.
   */
  | { readonly _tag: "Refused"; readonly exhausted: boolean }

export const Opening: {
  readonly Wait: Opening
  readonly Content: Opening
  readonly Refused: (exhausted: boolean) => Opening
} = {
  Wait: { _tag: "Wait" },
  Content: { _tag: "Content" },
  Refused: (exhausted) => ({ _tag: "Refused", exhausted }),
}

/** What a finished (or abandoned) stream said about the account. */
export interface Outcome {
  usage: Usage
  /** An in-stream error that means the account's quota is spent. */
  exhausted: boolean
}

export const Outcome = {
  make: (): Outcome => ({ usage: Usage.zero(), exhausted: false }),
} as const

/** A usage-limit answer: the error body and the extra response headers. */
export type Limit = readonly [body: JsonObject, headers: ReadonlyArray<readonly [string, string]>]

/** One server-sent event: an optional `event:` line, then the data. */
export const frame = (event: string | undefined, data: Json): string =>
  event === undefined ? `data: ${stringify(data)}\n\n` : `event: ${event}\ndata: ${stringify(data)}\n\n`
