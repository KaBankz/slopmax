// A request as the proxy holds it: the client's bytes, kept whole so they
// can go to another account, plus the few values routing reads from them.
//
// Nothing here parses a body. A body is inspectable only when it is plain
// JSON (not compressed, and valid); then the model, the session and the
// rest are found by scanning the bytes in front of them.
import type { ClientKey } from "@slopmax/domain"
import { scan } from "@slopmax/wire"
import { Data, Effect } from "effect"
import { type Agent, commonSession, detect } from "../agents/index.ts"
import { affinityOverride } from "../pool.ts"
import type { Step } from "../router.ts"
import { type Caller, heldKey } from "./auth.ts"
import type { Route } from "./classify.ts"
import { concat } from "./hold.ts"

/** The largest request body slopmax takes; Messages bodies with images get big. */
export const maxBody = 256 * 1024 * 1024

/** The body is past {@link maxBody}. */
export class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{}> {
  override get message(): string {
    return "request body is too large"
  }
}

/** The body could not be read: the client went away, or sent something broken. */
export class BodyUnreadable extends Data.TaggedError("BodyUnreadable")<{ readonly cause: unknown }> {
  override get message(): string {
    const why = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `could not read the request body: ${why}`
  }
}

const empty = new Uint8Array(0)

/** Reads a request's body whole, up to {@link maxBody}. */
export const readBody = (request: Request): Effect.Effect<Uint8Array<ArrayBuffer>, BodyTooLarge | BodyUnreadable> => {
  // `request.body` is made on first use, as a stream: a body of declared length is read whole without it.
  const declared = request.headers.get("content-length")
  if (declared === null) {
    const body = request.body
    return body === null ? Effect.succeed(empty) : readCounting(body)
  }
  // A declared length is the body's length: one past the limit is refused before a byte is read.
  if (Number(declared) > maxBody) return Effect.fail(new BodyTooLarge())
  if (declared.trim() === "0") return Effect.succeed(empty)
  return Effect.callback<Uint8Array<ArrayBuffer>, BodyTooLarge | BodyUnreadable>((resume) => {
    request.arrayBuffer().then(
      (buffer) =>
        resume(buffer.byteLength > maxBody ? Effect.fail(new BodyTooLarge()) : Effect.succeed(new Uint8Array(buffer))),
      (cause: unknown) => resume(Effect.fail(new BodyUnreadable({ cause }))),
    )
  })
}

/** A body sent in chunks, with no length declared: counted as it comes, and given up at the limit. */
const readCounting = (body: ReadableStream<Uint8Array>) =>
  Effect.callback<Uint8Array<ArrayBuffer>, BodyTooLarge | BodyUnreadable>((resume) => {
    const reader = body.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    const stop = () => void reader.cancel().catch(() => undefined)
    const next = (): void => {
      reader.read().then(
        (read) => {
          if (read.done) return resume(Effect.succeed(concat(chunks)))
          size += read.value.byteLength
          if (size > maxBody) {
            stop()
            return resume(Effect.fail(new BodyTooLarge()))
          }
          chunks.push(read.value)
          next()
        },
        (cause: unknown) => resume(Effect.fail(new BodyUnreadable({ cause }))),
      )
    }
    next()
    // A client gone meanwhile: stop reading what it sent.
    return Effect.sync(stop)
  })

/** One request, read and inspected. */
export interface Inbound {
  readonly route: Route
  readonly headers: Headers
  readonly body: Uint8Array<ArrayBuffer>
  readonly caller: Caller
  /** Whether the body is plain JSON that slopmax may read and edit. */
  readonly json: boolean
  /** The first top-level `model` string, when the body is JSON. */
  readonly model: string | undefined
  /** The agent the request comes from, when it is one slopmax knows. */
  readonly agent: Agent | undefined
  /** The conversation it belongs to, which keeps it on one account. */
  readonly session: string | undefined
  /** Its own say on session affinity (`x-slopmax-affinity`), over the settings'. */
  readonly affinity: boolean | undefined
  /** When its body was in, in clock milliseconds: the ledger's timings start here. */
  readonly startedAt: number
}

const isSpace = (b: number | undefined): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09

/** Whether the bytes hold one JSON object as far as its ends show: `{` first and `}` last, whitespace aside. */
export const framedAsObject = (body: Uint8Array): boolean => {
  let first = 0
  while (isSpace(body[first])) first++
  let last = body.length - 1
  while (last > first && isSpace(body[last])) last--
  return last > first && body[first] === 0x7b && body[last] === 0x7d
}

/**
 * Whether the bytes can be read: not compressed, and JSON. Checking every
 * byte of a body costs about 1 ns a byte (0.3 ms for a long conversation,
 * more than everything else the proxy does for it), so a body framed as
 * one JSON object is read as one: the scanner finds the model and the
 * session by walking only what lies before them, and answers "not found"
 * on anything malformed it meets on the way. A body broken further on is
 * still forwarded as sent, and its provider refuses it. `strict` checks
 * every byte, for a client key held to some models: only a valid body can
 * prove it names one model, and no other.
 */
export const isInspectable = (headers: Headers, body: Uint8Array, strict = false): boolean => {
  const encoding = headers.get("content-encoding")
  return (
    (encoding === null || encoding.trim() === "identity") &&
    body.length > 0 &&
    (strict ? scan.isJson(body) : framedAsObject(body))
  )
}

/** Reads what routing needs from a request whose body is in. */
export const inspect = (
  route: Route,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>,
  caller: Caller,
  startedAt: number,
): Inbound => {
  const json = isInspectable(headers, body, heldKey(caller) !== undefined)
  const readable = json ? body : empty
  const agent = detect(headers)
  return {
    route,
    headers,
    body,
    caller,
    json,
    model: json ? scan.findString(body, "model") : undefined,
    agent,
    session: agent?.session(headers, readable) ?? commonSession(headers, readable),
    affinity: affinityOverride(headers.get("x-slopmax-affinity")),
    startedAt,
  }
}

/**
 * Why a client key held to some models may not send this request, or
 * undefined when it may. A body naming `model` twice could be routed by one
 * and answered by the other; a body slopmax cannot read could name any
 * model, except that listing models spends nothing.
 */
export const keyRefusal = (inbound: Inbound): string | undefined => {
  const key = heldKey(inbound.caller)
  if (key === undefined) return undefined
  const name = JSON.stringify(key.name)
  if (inbound.model !== undefined) {
    if (!key.allows(inbound.model)) return `the key ${name} may not use ${inbound.model}`
    if (scan.countTopLevel(inbound.body, "model") > 1)
      return `the key ${name} may not send a request that names two models`
    return undefined
  }
  return inbound.route.listing
    ? undefined
    : `the key ${name} may use only some models, and this request names none slopmax can read`
}

/**
 * The steps a held key may take: aliases and fallbacks can name models the
 * key may not use, and must not route past it. A step with no model (a
 * request routed by its path) stays.
 */
export const stepsFor = (
  key: ClientKey | undefined,
  steps: ReadonlyArray<Step>,
): { readonly steps: ReadonlyArray<Step> } | { readonly refused: string } => {
  if (key === undefined) return { steps }
  const allowed = steps.filter((step) => step.model === "" || key.allows(step.model))
  return allowed.length > 0
    ? { steps: allowed }
    : { refused: `the key ${JSON.stringify(key.name)} may not use the models this request is routed to` }
}
