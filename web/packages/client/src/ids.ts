// Ids and the small values every other schema is built from.
import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { formatInstant, parseInstant } from "./time.ts"

/**
 * The providers slopmax pools accounts of, in the order requests try them:
 * subscriptions first, then API keys, then compatible endpoints. The same
 * order sorts every list of providers.
 */
export const ProviderId = Schema.Literals(["claude", "codex", "anthropic", "openai", "xai", "compat"]).annotate({
  identifier: "ProviderId",
  description: "A provider slopmax pools accounts of",
})
export type ProviderId = typeof ProviderId.Type

/** The providers whose accounts are subscriptions people sign in to; the rest are paid per token. */
export const SubscriptionId = Schema.Literals(["claude", "codex"])
export type SubscriptionId = typeof SubscriptionId.Type

/** The coding agents slopmax serves and can wire up. */
export const AgentId = Schema.Literals(["claude-code", "codex"]).annotate({
  identifier: "AgentId",
  description: "A coding agent slopmax serves",
})
export type AgentId = typeof AgentId.Type

/** An account's id: its provider and 8 hex digits of a hash of who it is, such as `claude-1a2b3c4d`. */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

/** The name of a client key, given when it is made. */
export const KeyName = Schema.NonEmptyString.pipe(Schema.brand("KeyName"))
export type KeyName = typeof KeyName.Type

/** The three API formats slopmax speaks: Anthropic Messages, OpenAI Responses, and Chat Completions. */
export const Dialect = Schema.Literals(["messages", "responses", "chat"])
export type Dialect = typeof Dialect.Type

/** A usage window's nominal length. */
export const Span = Schema.Literals(["5h", "7d", "30d"])
export type Span = typeof Span.Type

/** How a new session picks the account it starts on. */
export const Strategy = Schema.Literals(["reset-first", "fill-first", "least-used", "round-robin"]).annotate({
  message: "strategy is one of reset-first, fill-first, least-used, round-robin",
})
export type Strategy = typeof Strategy.Type

/** Tokens and keys: plain text in files, `Redacted` in memory so logs and inspection never show them. */
export const Secret = Schema.RedactedFromValue(Schema.String)
export type Secret = typeof Secret.Type

/**
 * A moment in time, written as RFC 3339 in UTC. Reading takes any offset and
 * any number of fraction digits; writing gives only the digits needed.
 */
export const Instant = Schema.String.annotate({ format: "date-time", description: "An RFC 3339 time" }).pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transformEffect({
      decode: (text, options) =>
        Option.match(parseInstant(text), {
          onNone: () =>
            Effect.fail(new SchemaIssue.InvalidValue({ message: "invalid RFC 3339 timestamp" }, text, options)),
          onSome: Effect.succeed,
        }),
      encode: (at) => Effect.succeed(formatInstant(at)),
    }),
  ),
)
export type Instant = typeof Instant.Type

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A field that takes `value` (in its encoded form) when a file or body leaves it out. */
export const withDefault = <S extends Schema.Constraint>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value))
