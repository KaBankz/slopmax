// The three formats side by side, and translation between them.
//
// Each format can be a client's: slopmax reads its requests and writes it
// answers, streamed or whole. Responses and Chat can also be an upstream's:
// slopmax writes them requests and reads their answers. Messages never is:
// slopmax never sends Anthropic a request a client did not write, so nothing
// is translated into it, and the types say so.
import type { Dialect } from "@slopmax/domain"
import { Result } from "effect"
import * as chat from "./chat.ts"
import { type Answer, onlyFailed } from "./collect.ts"
import {
  type AnswerReader,
  type AnswerWriter,
  type ReplyContext,
  type Request,
  RequestInvalid,
  type UpstreamDialect,
} from "./common.ts"
import * as Compaction from "./compaction.ts"
import { type ErrorBody, errorBody, failureKind } from "./errors.ts"
import * as messages from "./messages.ts"
import * as responses from "./responses.ts"

/** What slopmax does with a format a client speaks. */
export interface ClientFormat {
  /** Reads a request (parsed JSON) into the common form. */
  readonly decodeRequest: (json: unknown) => Result.Result<Request, RequestInvalid>
  /** A writer for the streamed answer to `request`. */
  readonly writer: (request: Request, context: ReplyContext) => AnswerWriter
  /** The whole answer to `request`, as one JSON document. */
  readonly whole: (request: Request, answer: Answer, context: ReplyContext) => unknown
}

/** What slopmax does with a format an upstream speaks. */
export interface UpstreamFormat extends ClientFormat {
  /** Where requests go, under the API's base URL. */
  readonly path: string
  /** The request as this format's body (before any provider's own shaping). */
  readonly encodeRequest: (request: Request) => Record<string, unknown>
  /** A reader for the answer to `request`; `token` makes up ids the answer left out. */
  readonly reader: (request: Request, token: () => string) => AnswerReader
}

export const formats: { readonly messages: ClientFormat } & { readonly [D in UpstreamDialect]: UpstreamFormat } = {
  messages: {
    decodeRequest: messages.decodeRequest,
    writer: (_, context) => new messages.MessagesWriter(context),
    whole: (_, answer, context) => messages.whole(answer, context),
  },
  responses: {
    path: "/responses",
    decodeRequest: responses.decodeRequest,
    encodeRequest: responses.encodeRequest,
    reader: () => new responses.ResponsesReader(),
    // A Responses client asking for compaction gets one sealed compaction item back.
    writer: (request, context) => new responses.ResponsesWriter(context, request.compact),
    whole: (request, answer, context) =>
      request.compact ? responses.compacted(answer, context) : responses.whole(answer, context),
  },
  chat: {
    path: "/chat/completions",
    decodeRequest: chat.decodeRequest,
    encodeRequest: chat.encodeRequest,
    reader: (request, token) => chat.ChatReader.forRequest(request, token),
    writer: (request, context) => new chat.ChatWriter(context, request.includeUsage),
    whole: (_, answer, context) => chat.whole(answer, context),
  },
}

/** Where each format's requests go, under an API's base URL. */
export const paths: { readonly [D in Dialect]: string } = {
  messages: "/v1/messages",
  responses: formats.responses.path,
  chat: formats.chat.path,
}

/**
 * Whether an upstream speaking `upstream` can serve a client speaking
 * `client` by translation: the formats differ, and the upstream's is not
 * Messages.
 */
export const canTranslate = (client: Dialect, upstream: Dialect): upstream is UpstreamDialect =>
  client !== upstream && upstream !== "messages"

const text = new TextDecoder()

/** Reads a client's request body into the common form; a body that is not JSON, or not a request, is the client's mistake. */
export const decodeRequest = (client: Dialect, body: Uint8Array): Result.Result<Request, RequestInvalid> => {
  let json: unknown
  try {
    json = JSON.parse(text.decode(body))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return Result.fail(new RequestInvalid({ message: `the request is not valid JSON: ${reason}` }))
  }
  return formats[client].decodeRequest(json)
}

/**
 * The body to send an upstream for `request`. A request to compact asks the
 * model for a summary of the conversation instead.
 */
export const encodeRequest = (upstream: UpstreamDialect, request: Request): Record<string, unknown> =>
  formats[upstream].encodeRequest(request.compact ? Compaction.summaryRequest(request) : request)

/** A whole answer for a client: 200 with the answer, or, when the answer is only a failure, its status with an error in the client's format. */
export const wholeReply = (
  client: Dialect,
  request: Request,
  answer: Answer,
  context: ReplyContext,
): { readonly status: number; readonly body: unknown } => {
  if (onlyFailed(answer)) {
    const { status, message } = answer.failure
    const body: ErrorBody = errorBody(client, failureKind(status), message)
    return { status, body }
  }
  return { status: 200, body: formats[client].whole(request, answer, context) }
}
