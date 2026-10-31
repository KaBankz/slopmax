// The common form every translation goes through.
//
// When an account cannot speak the client's format, slopmax reads the
// client's request into a `Request`, writes it again in the account's format,
// and reads the answer back as `Event`s that the client's format writes out.
// Each format then needs one reader and one writer, not one translator per
// pair of formats.
//
// Only what coding agents use crosses: text, images and documents, tool calls
// and their results, reasoning, and the settings that shape an answer.
// Anything else stays behind rather than being guessed at.
import type { Dialect, Usage } from "@slopmax/domain"
import { Data, type DateTime, Effect, Option, Schema, SchemaTransformation } from "effect"
import { Base64Url } from "effect/encoding"
import { parseText } from "./lines.ts"

// --- Reading what clients and upstreams send ---------------------------------

/**
 * A field read only when it is there and of the expected kind. Clients send
 * `null` for "not set" and older or newer shapes than slopmax knows; a field
 * that does not fit reads as absent instead of failing the whole request.
 */
export const field = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.catchDecoding<S>(() => Effect.succeedNone)(schema))

/**
 * A list read item by item: an item that does not fit (a block type slopmax
 * does not know, a stray value) is dropped, and the rest of the list is kept.
 */
export const listOf = <S extends Schema.ConstraintDecoder<unknown>>(item: S) => {
  const read = Schema.decodeUnknownOption(item)
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transform<ReadonlyArray<S["Type"]>, ReadonlyArray<unknown>>({
        decode: (items) => items.flatMap((value) => Option.toArray(read(value))),
        encode: (items) => items,
      }),
    ),
  )
}

/** A token count or a size: a whole number that is not negative. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A field holding any JSON at all (a tool's schema, a call's input), kept as it came. */
export const anyJson = Schema.optionalKey(Schema.Unknown)

/** Why a client's request cannot be translated: answered with a 400 carrying the message. */
export class RequestInvalid extends Data.TaggedError("RequestInvalid")<{ readonly message: string }> {}

// --- The request -------------------------------------------------------------

/** How hard the model should think, from the lightest to the most. */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "max"])
export type Effort = typeof Effort.Type

/** The effort a format's name for it means; `none` is the lightest, `xhigh` the most. */
export const effortNamed = (name: string): Effort | undefined => {
  switch (name) {
    case "minimal":
    case "none":
      return "minimal"
    case "low":
    case "medium":
    case "high":
      return name
    case "xhigh":
    case "max":
      return "max"
    default:
      return undefined
  }
}

/** The effort a thinking budget in tokens amounts to. */
export const effortForBudget = (tokens: number): Effort =>
  tokens < 4_096 ? "low" : tokens < 16_384 ? "medium" : "high"

/** Where an image or document's bytes are: inline as base64, or at a URL. */
export const MediaSource = Schema.TaggedUnion({
  Inline: { data: Schema.String },
  Link: { url: Schema.String },
})
export type MediaSource = typeof MediaSource.Type

/** An image or a document such as a PDF. */
export const Media = Schema.Struct({
  mediaType: Schema.String,
  source: MediaSource,
  /** A document's file name, when it has one. */
  name: Schema.UndefinedOr(Schema.String),
})
export type Media = typeof Media.Type

/** Inline media as a `data:` URL, else its URL. */
export const mediaUrl = (media: Media): string =>
  media.source._tag === "Inline" ? `data:${media.mediaType};base64,${media.source.data}` : media.source.url

/** Media at a URL that may be a `data:` URL; a plain URL has no known type. */
export const mediaFromUrl = (url: string, name?: string): Media => {
  const marker = url.startsWith("data:") ? url.indexOf(";base64,") : -1
  return marker < 0
    ? { mediaType: "", source: { _tag: "Link", url }, name }
    : { mediaType: url.slice(5, marker), source: { _tag: "Inline", data: url.slice(marker + 8) }, name }
}

/**
 * How a tool takes its input: JSON arguments matching a schema, or free text
 * (Codex's `apply_patch`). Formats without freeform tools see a function
 * taking `{"input": string}`.
 */
export const ToolKind = Schema.Literals(["function", "freeform"])
export type ToolKind = typeof ToolKind.Type

/** A tool call the model made. */
export const ToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** JSON text for a function; the raw text for a freeform tool. */
  input: Schema.String,
  kind: ToolKind,
})
export type ToolCall = typeof ToolCall.Type

/** What a tool's result can hold. */
export const ResultPart = Schema.TaggedUnion({
  Text: { text: Schema.String },
  Image: { media: Media },
})
export type ResultPart = typeof ResultPart.Type

/** One piece of a turn in the conversation. */
export const Part = Schema.TaggedUnion({
  Text: { text: Schema.String },
  Image: { media: Media },
  /** A document such as a PDF. */
  File: { media: Media },
  Call: ToolCall.fields,
  Result: { callId: Schema.String, content: Schema.Array(ResultPart), isError: Schema.Boolean },
  /** Reasoning from an earlier turn: its readable summary, and state only the provider that wrote it can read. */
  Reasoning: { text: Schema.String, opaque: Schema.UndefinedOr(Schema.String) },
})
export type Part = typeof Part.Type
export type CallPart = Extract<Part, { readonly _tag: "Call" }>
export type ResultOf = Extract<Part, { readonly _tag: "Result" }>

/** A tool result's text, its pieces one per line. */
export const resultText = (result: ResultOf): string => {
  const texts: Array<string> = []
  for (const part of result.content) if (part._tag === "Text") texts.push(part.text)
  return texts.join("\n")
}

/** The text a tool result is sent as: an error's text says it was one. */
export const resultOutput = (result: ResultOf): string => {
  const text = resultText(result)
  return result.isError && text.length > 0 ? `Error: ${text}` : text
}

export const Role = Schema.Literals(["user", "assistant"])
export type Role = typeof Role.Type

export const Message = Schema.Struct({ role: Role, parts: Schema.Array(Part) })
export type Message = typeof Message.Type

/** A tool the client offers the model. */
export const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** JSON schema of a function's arguments. */
  schema: Schema.Unknown,
  kind: ToolKind,
})
export type Tool = typeof Tool.Type

/** Whether and which tool the model must call. */
export const ToolChoice = Schema.TaggedUnion({
  Auto: {},
  None: {},
  Required: {},
  Named: { name: Schema.String },
})
export type ToolChoice = typeof ToolChoice.Type

/** A JSON schema the answer must follow. */
export const AnswerFormat = Schema.Struct({ name: Schema.String, schema: Schema.Unknown, strict: Schema.Boolean })
export type AnswerFormat = typeof AnswerFormat.Type

/** A request, as far as translation carries it. */
export const Request = Schema.Struct({
  model: Schema.String,
  /** System instructions, in order. */
  system: Schema.Array(Schema.String),
  messages: Schema.Array(Message),
  tools: Schema.Array(Tool),
  toolChoice: ToolChoice,
  parallelToolCalls: Schema.UndefinedOr(Schema.Boolean),
  maxTokens: Schema.UndefinedOr(Count),
  temperature: Schema.UndefinedOr(Schema.Finite),
  topP: Schema.UndefinedOr(Schema.Finite),
  stop: Schema.Array(Schema.String),
  effort: Schema.UndefinedOr(Effort),
  format: Schema.UndefinedOr(AnswerFormat),
  stream: Schema.Boolean,
  /** Keys the provider's prompt cache: the conversation's id. */
  cacheKey: Schema.UndefinedOr(Schema.String),
  /** The client asks for its history to be compacted into a summary (Codex's remote compaction), not for an answer. */
  compact: Schema.Boolean,
  /** The client wants a usage report at the end of the stream (Chat's `stream_options.include_usage`). */
  includeUsage: Schema.Boolean,
})
export type Request = typeof Request.Type

/** A request for `model` with nothing else set; each format's reader fills in what its client sent. */
export const emptyRequest = (model: string): Request => ({
  model,
  system: [],
  messages: [],
  tools: [],
  toolChoice: { _tag: "Auto" },
  parallelToolCalls: undefined,
  maxTokens: undefined,
  temperature: undefined,
  topP: undefined,
  stop: [],
  effort: undefined,
  format: undefined,
  stream: false,
  cacheKey: undefined,
  compact: false,
  includeUsage: false,
})

/** The names of the tools the client declared as freeform. */
export const freeformNames = (request: Request): ReadonlySet<string> =>
  new Set(request.tools.filter((tool) => tool.kind === "freeform").map((tool) => tool.name))

/** The arguments a freeform tool takes when it is lowered to a function. */
export const freeformSchema = {
  type: "object",
  properties: { input: { type: "string", description: "The tool's raw input." } },
  required: ["input"],
}

/**
 * A call's input as JSON object text, for formats whose calls always take
 * JSON: a freeform call's text is wrapped as `{"input": …}`, and a function
 * called with nothing gets `{}`.
 */
export const callArguments = (call: ToolCall): string => {
  if (call.kind === "freeform") return JSON.stringify({ input: call.input })
  return call.input.trim().length === 0 ? "{}" : call.input
}

/** A freeform call's text back out of the `{"input": …}` it travelled in; arguments of any other shape are kept as they are. */
export const unwrapFreeform = (args: string): string => {
  // Arguments that are not JSON are the raw input the model wrote itself.
  const value = parseText(args)
  return typeof value === "object" && value !== null && "input" in value && typeof value.input === "string"
    ? value.input
    : args
}

// --- The answer --------------------------------------------------------------

/** Why an answer ended. */
export const Stop = Schema.Literals(["end", "toolUse", "length", "sequence", "filtered"])
export type Stop = typeof Stop.Type

/** An upstream failure, in terms every format can state. */
export const Failure = Schema.Struct({ status: Schema.Int, message: Schema.String })
export type Failure = typeof Failure.Type

/** One step of an answer, as it streams. */
export type Event = Data.TaggedEnum<{
  /** More of the answer's text. */
  Text: { readonly text: string }
  /** More of the model's readable reasoning. */
  Reasoning: { readonly text: string }
  /** Reasoning state for the next turn, readable only by its provider. It belongs to the calls that follow. */
  State: { readonly state: string }
  /** A complete tool call. */
  Call: { readonly call: ToolCall }
  /** The answer ended. */
  Done: { readonly stop: Stop; readonly usage: Usage }
  /** The answer failed partway. */
  Failed: { readonly failure: Failure }
}>
export const Event = Data.taggedEnum<Event>()

/**
 * Reads one upstream answer into events. `event` takes each event's parsed
 * data, `document` an answer that came whole, and `finish` is called when the
 * body ends: an answer that never said it ended becomes a failure, so the
 * client hears an error in its own format instead of a cut stream. Once the
 * answer ended (`done`), the reader ignores anything more.
 */
export interface AnswerReader {
  readonly done: boolean
  readonly event: (data: unknown, out: Array<Event>) => void
  readonly document: (body: unknown, out: Array<Event>) => void
  readonly finish: (out: Array<Event>) => void
}

/** Writes an answer's events in a client's format, as server-sent event frames. */
export interface AnswerWriter {
  readonly write: (event: Event) => string
}

/** What writing a reply needs from outside: who asked, when, and fresh ids. */
export interface ReplyContext {
  /** The model the client asked for: replies are told under its name. */
  readonly model: string
  /** When the answer started; replies that carry a creation time use it. */
  readonly now: DateTime.Utc
  /** A fresh random token, for the ids replies carry. */
  readonly token: () => string
}

/** The formats slopmax can send a translated request to: anything but Messages. */
export type UpstreamDialect = Exclude<Dialect, "messages">

/** 32 random bytes as base64url: 43 characters, as every id slopmax makes up. */
export const randomToken = (): string => Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))
