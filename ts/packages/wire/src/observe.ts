// What an answer says about the account that gave it.
//
// Each format reports token usage in its own events, and can refuse inside a
// stream that already began with a 200. These observers fold one parsed event
// (or a whole JSON answer) into a `TapOutcome`, which the proxy settles into
// the pool's counts and the ledger once the answer ends.
//
// The small readers of parsed JSON they use come first; the error bodies and
// the opening judge use them too, and `textOf` reads a message's text.
import { type Dialect, Usage } from "@slopmax/domain"
import { Data, Predicate } from "effect"

/** Token counts as an answer reports them, before they settle as the request's `Usage`. */
export interface Counts {
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** No tokens, and no request yet. */
export const noCounts: Counts = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Counts the observers checked already (whole numbers, never negative)
 * skip the schema's checks when they become `Usage`.
 */
const unchecked = { disableChecks: true } as const

/** What a finished (or abandoned) answer said about its account. */
export class TapOutcome extends Data.Class<{
  /** The tokens it moved, and the one request it was once the answer ended. */
  readonly counts: Counts
  /** The answer said the account's quota ran out partway. */
  readonly exhausted: boolean
  /** The answer carried an error event of its own, whatever its cause. */
  readonly failed: boolean
}> {
  static readonly empty: TapOutcome = new TapOutcome({ counts: noCounts, exhausted: false, failed: false })

  #usage: Usage | undefined

  /**
   * The counts as `Usage`, made once and only when asked: an answer's
   * events update its counts several times, and only the last is settled.
   */
  get usage(): Usage {
    this.#usage ??= new Usage(this.counts, unchecked)
    return this.#usage
  }

  /** The same outcome with other counts. Fields are named, not spread, so the compiler keeps their types. */
  withCounts(counts: Counts): TapOutcome {
    return new TapOutcome({ counts, exhausted: this.exhausted, failed: this.failed })
  }

  /** The same outcome, counted as the one request it was. */
  counted(): TapOutcome {
    const { input, output, cacheRead, cacheWrite } = this.counts
    return this.withCounts({ requests: 1, input, output, cacheRead, cacheWrite })
  }
}

/** Folds one event (or a whole JSON answer) into the outcome so far, returning it unchanged when the event says nothing. */
export type Observer = (outcome: TapOutcome, event: unknown) => TapOutcome

// --- Reading parsed JSON ------------------------------------------------------

/** The value at a path of member names inside parsed JSON, or undefined when the path leads nowhere. */
export const jsonPath = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let at = value
  for (const name of path) {
    if (!Predicate.isObject(at)) return undefined
    at = at[name]
  }
  return at
}

/** `jsonPath` with the names written out. */
export const jsonAt = (value: unknown, ...path: ReadonlyArray<string>): unknown => jsonPath(value, path)

const stringAt = (value: unknown, ...path: ReadonlyArray<string>): string | undefined => {
  const found = jsonPath(value, path)
  return typeof found === "string" ? found : undefined
}

/**
 * The text inside JSON `content`: a plain string, or the `text` of each part
 * of an array of typed parts, one per line.
 */
export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: ReadonlyArray<unknown> = content
  const texts: Array<string> = []
  for (const part of parts) {
    const text = stringAt(part, "text")
    if (text !== undefined) texts.push(text)
  }
  return texts.join("\n")
}

/** A token count: a whole number that is not negative. Anything else counts as absent. */
const countAt = (value: unknown, ...path: ReadonlyArray<string>): number | undefined => {
  const found = jsonPath(value, path)
  return typeof found === "number" && Number.isSafeInteger(found) && found >= 0 ? found : undefined
}

const failedWith = (outcome: TapOutcome, exhausted: boolean): TapOutcome =>
  outcome.failed && (outcome.exhausted || !exhausted)
    ? outcome
    : new TapOutcome({ counts: outcome.counts, failed: true, exhausted: outcome.exhausted || exhausted })

// --- Messages ---------------------------------------------------------------

/** Each non-zero count in a Messages `usage` replaces the one before. */
const messagesUsage = (outcome: TapOutcome, usage: unknown): TapOutcome => {
  if (!Predicate.isObject(usage)) return outcome
  const nonZero = (name: string): number | undefined => {
    const n = countAt(usage, name)
    return n === undefined || n === 0 ? undefined : n
  }
  const input = nonZero("input_tokens")
  const output = nonZero("output_tokens")
  const cacheRead = nonZero("cache_read_input_tokens")
  const cacheWrite = nonZero("cache_creation_input_tokens")
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return outcome
  const was = outcome.counts
  return outcome.withCounts({
    requests: was.requests,
    input: input ?? was.input,
    output: output ?? was.output,
    cacheRead: cacheRead ?? was.cacheRead,
    cacheWrite: cacheWrite ?? was.cacheWrite,
  })
}

/**
 * An observer that reads only events of the types in `byType`. The tap
 * passes over events of any other type without parsing them (see
 * {@link observedTypes}), so the types it reads and the ones it skips come
 * from this one table.
 */
interface Typed {
  readonly byType: ReadonlyMap<string, Observer>
  readonly observe: Observer
}

const typed = (byType: ReadonlyMap<string, Observer>, whole: Observer = (outcome) => outcome): Typed => ({
  byType,
  observe: (outcome, event) => {
    const type = stringAt(event, "type")
    const read = type === undefined ? undefined : byType.get(type)
    return read === undefined ? whole(outcome, event) : read(outcome, event)
  },
})

const messages = typed(
  new Map<string, Observer>([
    ["message_start", (outcome, event) => messagesUsage(outcome, jsonAt(event, "message", "usage"))],
    ["message_delta", (outcome, event) => messagesUsage(outcome, jsonAt(event, "usage"))],
    ["message", (outcome, event) => messagesUsage(outcome, jsonAt(event, "usage"))],
    ["error", (outcome, event) => failedWith(outcome, stringAt(event, "error", "type") === "rate_limit_error")],
  ]),
)

/**
 * Messages: `message_start` carries the usage so far under `message`, each
 * `message_delta` (and a whole `message`) under `usage`. The counts are
 * running totals, and a zero means "unchanged", so each non-zero count
 * replaces the one before. An `error` event typed `rate_limit_error` means the
 * quota ran out mid-stream.
 */
export const observeMessages: Observer = messages.observe

// --- Responses --------------------------------------------------------------

/**
 * The code a Responses failure carries: from `response.error`, else the
 * event's own `error`, its `code` or else its `type`.
 */
export const responsesFailureCode = (event: unknown): string | undefined => {
  const nested = jsonAt(event, "response", "error")
  const error = nested === undefined ? jsonAt(event, "error") : nested
  return stringAt(error, "code") ?? stringAt(error, "type")
}

/** Codes a Responses failure uses for a spent quota. */
export const isSpentCode = (code: string | undefined): boolean =>
  code === "usage_limit_reached" || code === "usage_limit_exceeded"

/** Responses and Chat count cached input inside the input: slopmax counts it apart. */
const openAiUsage = (outcome: TapOutcome, input: number, cached: number, output: number): TapOutcome =>
  outcome.withCounts({
    requests: outcome.counts.requests,
    input: Math.max(0, input - cached),
    output,
    cacheRead: cached,
    cacheWrite: outcome.counts.cacheWrite,
  })

const responsesUsage = (outcome: TapOutcome, usage: unknown): TapOutcome =>
  Predicate.isObject(usage)
    ? openAiUsage(
        outcome,
        countAt(usage, "input_tokens") ?? 0,
        countAt(usage, "input_tokens_details", "cached_tokens") ?? 0,
        countAt(usage, "output_tokens") ?? 0,
      )
    : outcome

const responsesEnd: Observer = (outcome, event) => responsesUsage(outcome, jsonAt(event, "response", "usage"))
const responsesFailed: Observer = (outcome, event) => failedWith(outcome, isSpentCode(responsesFailureCode(event)))

const responses = typed(
  new Map<string, Observer>([
    ["response.completed", responsesEnd],
    ["response.incomplete", responsesEnd],
    ["response.done", responsesEnd],
    ["response.failed", responsesFailed],
    ["error", responsesFailed],
  ]),
  // A whole answer names no type first, so the tap never skips it.
  (outcome, event) =>
    stringAt(event, "object") === "response" ? responsesUsage(outcome, jsonAt(event, "usage")) : outcome,
)

/**
 * Responses: a whole `response` object carries `usage`, as does the last
 * event of a stream (`response.completed`, `.incomplete` or `.done`) under
 * `response`. A `response.failed` or `error` coded as a spent quota means it
 * ran out mid-stream.
 */
export const observeResponses: Observer = responses.observe

// --- Chat -------------------------------------------------------------------

/**
 * Chat Completions: a whole `chat.completion`, or the stream chunk that
 * carries `usage` (the last one, when the client asked for
 * `stream_options.include_usage`; the others say `"usage": null`).
 */
export const observeChat: Observer = (outcome, event) => {
  const usage = jsonAt(event, "usage")
  if (Predicate.isObject(usage)) {
    return openAiUsage(
      outcome,
      countAt(usage, "prompt_tokens") ?? 0,
      countAt(usage, "prompt_tokens_details", "cached_tokens") ?? 0,
      countAt(usage, "completion_tokens") ?? 0,
    )
  }
  return Predicate.isObject(jsonAt(event, "error")) ? failedWith(outcome, false) : outcome
}

/**
 * The event types each format's observer reads, from the tables it reads
 * them by. Streams of those formats name an event's type first
 * (`{"type":"…"`), so the tap passes over every other event (the many text
 * deltas) without reading it. Chat chunks name no type up front, so the tap
 * looks into each of them for usage or an error.
 */
export const observedTypes: { readonly [D in Dialect]: ReadonlyArray<string> | undefined } = {
  messages: [...messages.byType.keys()],
  responses: [...responses.byType.keys()],
  chat: undefined,
}

/** Each format's observer. */
export const observers: { readonly [D in Dialect]: Observer } = {
  messages: observeMessages,
  responses: observeResponses,
  chat: observeChat,
}

/** Folds `event` into `outcome` by `dialect`'s rules. */
export const observe = (dialect: Dialect, outcome: TapOutcome, event: unknown): TapOutcome =>
  observers[dialect](outcome, event)
