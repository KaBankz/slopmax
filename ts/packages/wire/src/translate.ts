// Translation between formats, through `ir`.
//
// Requests are decoded from the client's format and encoded into the
// upstream's; answers are decoded from the upstream's events and encoded
// for the client. Anything translates into Responses or Chat. Nothing
// translates into Messages: slopmax never sends Anthropic a request a
// client did not write.
import { Data, Result } from "effect"

import type { Timestamp } from "@slopmax/common"

import * as chatEvents from "./chat/events.ts"
import * as chatReply from "./chat/reply.ts"
import * as chatRequest from "./chat/request.ts"
import type { Dialect } from "./dialect.ts"
import { type Answer, type Event, Part, Request, ToolChoice } from "./ir.ts"
import { type JsonObject, read, trimAscii } from "./json.ts"
import * as messagesReply from "./messages/reply.ts"
import * as messagesRequest from "./messages/request.ts"
import { PROMPT } from "./responses/compaction.ts"
import * as responsesEvents from "./responses/events.ts"
import * as responsesReply from "./responses/reply.ts"
import * as responsesRequest from "./responses/request.ts"

/** A client's request translation cannot read; `message` is for the client. */
export class RequestError extends Data.TaggedError("RequestError")<{ readonly message: string }> {}

/**
 * Whether an API speaking `upstream` can serve a client speaking `client`
 * by translation.
 */
export const canTranslate = (client: Dialect, upstream: Dialect): boolean =>
  client !== upstream && upstream !== "messages"

/** Where a translated request goes, under the API's base URL. */
export const path = (upstream: Dialect): string => {
  switch (upstream) {
    case "messages":
      return "/v1/messages"
    case "responses":
      return "/responses"
    case "chat":
      return "/chat/completions"
  }
}

/** Reads a client's request. */
export const decode = (client: Dialect, body: Uint8Array): Result.Result<Request, RequestError> => {
  const value = read(body)
  if (Result.isFailure(value)) {
    return Result.fail(new RequestError({ message: `the request is not valid JSON: ${value.failure}` }))
  }
  let request: Result.Result<Request, string>
  switch (client) {
    case "messages":
      request = messagesRequest.decode(value.success)
      break
    case "responses":
      request = responsesRequest.decode(value.success)
      break
    case "chat":
      request = chatRequest.decode(value.success)
      break
  }
  return Result.mapError(request, (message) => new RequestError({ message }))
}

/** What a request can be translated into: anything but Messages. */
export type Target = Exclude<Dialect, "messages">

/**
 * Writes a request for an upstream; see `canTranslate`. A request to
 * compact asks the model for a summary of the conversation instead.
 */
export const encode = (upstream: Target, request: Request): JsonObject => {
  const sent = request.compact
    ? Request.make({
        ...request,
        messages: [...request.messages, { role: "User", parts: [Part.Text(PROMPT)] }],
        toolChoice: ToolChoice.None,
      })
    : request
  switch (upstream) {
    case "responses":
      return responsesRequest.encode(sent)
    case "chat":
      return chatRequest.encode(sent)
  }
}

// `[DONE]`
const isDone = (d: Uint8Array): boolean =>
  d.length === 6 && d[0] === 0x5b && d[1] === 0x44 && d[2] === 0x4f && d[3] === 0x4e && d[4] === 0x45 && d[5] === 0x5d

/** Reads an upstream's answer. */
export class Decoder {
  private constructor(
    private readonly inner:
      | { readonly _tag: "Responses"; readonly events: responsesEvents.Events }
      | { readonly _tag: "Chat"; readonly events: chatEvents.Events },
  ) {}

  static make(upstream: Dialect, request: Request): Decoder {
    if (upstream === "chat") {
      const freeform = new Set<string>()
      for (const tool of request.tools) if (tool.kind === "Freeform") freeform.add(tool.name)
      return new Decoder({ _tag: "Chat", events: new chatEvents.Events(freeform) })
    }
    return new Decoder({ _tag: "Responses", events: new responsesEvents.Events() })
  }

  /** Reads one server-sent event's data. */
  data(data: Uint8Array, out: Array<Event>): void {
    const trimmed = trimAscii(data)
    if (isDone(trimmed)) return this.finish(out)
    const value = read(trimmed)
    if (Result.isFailure(value)) return
    this.inner.events.feed(value.success, out)
  }

  /** Reads an answer that came as one JSON document instead of a stream. */
  whole(body: Uint8Array, out: Array<Event>): void {
    const value = read(body)
    if (Result.isFailure(value)) return this.finish(out)
    if (this.inner._tag === "Responses") {
      for (const event of responsesEvents.whole(value.success)) out.push(event)
    } else {
      this.inner.events.feed(value.success, out)
      this.inner.events.finish(out)
    }
  }

  /** Called when the upstream body ends. */
  finish(out: Array<Event>): void {
    this.inner.events.finish(out)
  }
}

/** Writes an answer in the client's format as it streams. */
export interface Encoder {
  /** The bytes, as text, that `event` becomes. */
  event(event: Event): string
}

export const Encoder = {
  /**
   * `model` is the name the client asked for; `includeUsage` is a Chat
   * client's request for a usage chunk. `now` is the clock's time, for
   * the `created` fields.
   */
  make: (client: Dialect, model: string, includeUsage: boolean, now: Timestamp): Encoder => {
    switch (client) {
      case "messages":
        return new messagesReply.Reply(model)
      case "responses":
        return new responsesReply.Reply(model, now)
      case "chat":
        return new chatReply.Reply(model, includeUsage, now)
    }
  },

  /**
   * An encoder for the answer to `request`, which a compaction answer
   * turns into one compaction item.
   */
  forRequest: (client: Dialect, request: Request, model: string, includeUsage: boolean, now: Timestamp): Encoder =>
    client === "responses" && request.compact
      ? responsesReply.Reply.compacting(model, now)
      : Encoder.make(client, model, includeUsage, now),
} as const

/** A whole answer to `request` in the client's format. */
export const whole = (client: Dialect, request: Request, answer: Answer, model: string, now: Timestamp): JsonObject => {
  switch (client) {
    case "messages":
      return messagesReply.whole(answer, model)
    case "responses":
      return request.compact ? responsesReply.compacted(answer, model, now) : responsesReply.whole(answer, model, now)
    case "chat":
      return chatReply.whole(answer, model, now)
  }
}
