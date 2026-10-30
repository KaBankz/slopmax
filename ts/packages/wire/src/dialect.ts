// Wire formats: the shapes agents and providers exchange requests,
// responses, and errors in.
//
// slopmax forwards each agent's requests in the dialect it speaks. What it
// needs to know about a dialect lives here: how errors look, how to say
// "every account is spent" so the agent shows its usual limit message, and
// where a stream reports token usage and in-stream refusals. When the
// model a request asks for speaks another format, `translate` carries it
// across through `ir`.
import { Schema } from "effect"

import type { Timestamp } from "@slopmax/common"

import { type Limit, Opening, type Outcome } from "./base.ts"
import * as chat from "./chat/mod.ts"
import type { Json, JsonObject } from "./json.ts"
import * as messages from "./messages/mod.ts"
import * as responses from "./responses/mod.ts"

/** `Dialect` on disk and on the wire: its lowercase name. */
export const DialectSchema = Schema.Literals(["messages", "responses", "chat"])

/**
 * A request and response format: Anthropic Messages (`/v1/messages`),
 * spoken by Claude Code; OpenAI Responses (`/v1/responses`), spoken by
 * Codex; OpenAI Chat Completions (`/v1/chat/completions`), spoken by most
 * other tools.
 */
export type Dialect = typeof DialectSchema.Type

export const Dialect = {
  all: DialectSchema.literals,

  /** An error body of the given `kind`, e.g. `rate_limit_error`. */
  error: (self: Dialect, kind: string, message: string): JsonObject =>
    self === "messages" ? messages.error(kind, message) : responses.error(kind, message),

  /**
   * The answer when every account is spent until `until`: the body and
   * extra headers of the provider's own usage-limit error, so the agent
   * shows its usual message and waits as it normally would.
   */
  limitReached: (self: Dialect, message: string, until: Timestamp, now: Timestamp): Limit => {
    switch (self) {
      case "messages":
        return messages.limitReached(message, until)
      case "responses":
        return responses.limitReached(message, until, now)
      case "chat":
        return [chat.limitReached(message), []]
    }
  },

  /**
   * Whether the proxy holds back the start of streams until they open, so
   * a refusal inside a 200 stream can still move to another account.
   * Claude refuses with a status code before streaming, so only Codex
   * needs it.
   */
  holdsStart: (self: Dialect): boolean => self === "responses",

  /** How a stream opening with `event` should be treated. */
  opening: (self: Dialect, event: Json): Opening => (self === "responses" ? responses.opening(event) : Opening.Content),

  /** Folds one stream event into `outcome`. */
  observe: (self: Dialect, event: Json, outcome: Outcome): void => {
    switch (self) {
      case "messages":
        return messages.observe(event, outcome)
      case "responses":
        return responses.observe(event, outcome)
      case "chat":
        return chat.observe(event, outcome)
    }
  },

  asStr: (self: Dialect): string => self,
} as const
