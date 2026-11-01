// The clients slopmax serves, as they really call it: Claude Code (its
// headers, its session in two places, its billing block), Codex (its
// release in the user agent, its session header), and OpenAI-style tools.
// Each builds a `Request` for a proxy at `base`; the harness sends it in
// process or over the network.
import { Data, Effect, Option, Schedule, Schema } from "effect"

/** The owner key every harness runs with. */
export const ownerKey = "sm-test-key"

/** Claude Code's session, as its headers and its body name it. */
export const claudeSession = "sess-1"

/** Claude Code's user agent. */
export const claudeAgent = "claude-cli/2.1.287 (external, cli)"

/** Codex's user agent, naming its release. */
export const codexAgent = "codex_exec/0.159.3 (Linux; x86_64) unknown (codex_exec; 0.159.3)"

/** The OpenAI Python SDK's user agent. */
export const openaiAgent = "OpenAI/Python 2.4.0"

/**
 * The body Claude Code sends for `model`: its session inside
 * `metadata.user_id` (a JSON string), the billing block first in `system`,
 * and a stream. Native requests must reach the provider byte for byte.
 */
export const claudeCodeBody = (model = "claude-opus-5-5"): string =>
  JSON.stringify({
    model,
    metadata: {
      user_id: JSON.stringify({ device_id: "client-device", account_uuid: "", session_id: claudeSession }),
    },
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=cli;" },
      { type: "text", text: "You are Claude Code." },
    ],
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    stream: true,
  })

/** The body Codex sends for a turn. */
export const codexBody = (model = "gpt-6-sol"): string => JSON.stringify({ model, input: [], stream: true })

/** The body an OpenAI-style tool sends to Chat Completions. */
export const chatBody = (model: string): string =>
  JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })

export interface CallOptions {
  /** The path and query (each client has its own default). */
  readonly path?: string
  readonly body?: string
  /** Headers added to, or replacing, the client's own. */
  readonly headers?: Readonly<Record<string, string>>
  /** The key it presents: the owner key unless given; `null` for none. */
  readonly key?: string | null
}

const keyHeader = (key: string | null | undefined): Record<string, string> => {
  const given = key === undefined ? ownerKey : key
  return given === null ? {} : { authorization: `Bearer ${given}` }
}

const post = (base: string, path: string, headers: Record<string, string>, body: string) =>
  new Request(`${base}${path}`, { method: "POST", headers, body })

/** A request as Claude Code makes one, to `{base}/claude`. */
export const claudeCode = (base: string, options: CallOptions = {}): Request =>
  post(
    base,
    options.path ?? "/claude/v1/messages?beta=true",
    {
      ...keyHeader(options.key),
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
      "x-claude-code-session-id": claudeSession,
      "user-agent": claudeAgent,
      "accept-encoding": "gzip, br",
      "content-type": "application/json",
      ...options.headers,
    },
    options.body ?? claudeCodeBody(),
  )

/** A request as Codex makes one, to `{base}/codex`. */
export const codex = (base: string, options: CallOptions = {}): Request =>
  post(
    base,
    options.path ?? "/codex/responses",
    {
      ...keyHeader(options.key),
      "user-agent": codexAgent,
      "content-type": "application/json",
      ...options.headers,
    },
    options.body ?? codexBody(),
  )

/** A request as an OpenAI-style tool makes one to Chat Completions, for `model`. */
export const chat = (base: string, model: string, options: CallOptions = {}): Request =>
  post(
    base,
    options.path ?? "/v1/chat/completions",
    {
      ...keyHeader(options.key),
      "user-agent": openaiAgent,
      "content-type": "application/json",
      ...options.headers,
    },
    options.body ?? chatBody(model),
  )

/** Any other call: slopmax's API, the hub, a probe. */
export const other = (
  base: string,
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly key?: string | null; readonly headers?: Record<string, string> } = {},
): Request => {
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body)
  return new Request(`${base}${path}`, {
    method,
    headers: {
      ...keyHeader(options.key),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body }),
  })
}

/** What a call answered, read whole. */
export interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  /** The body as JSON; `undefined` when it is not JSON. */
  readonly json: unknown
}

/** Why a call has no answer to read: the connection failed, or the body was cut off part-way. */
export class Unanswered extends Data.TaggedError("Unanswered")<{ readonly cause: unknown }> {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A body as JSON; `undefined` when it is empty or not JSON. */
export const parseJson = (text: string): unknown => Option.getOrUndefined(decodeJson(text))

/** Reads an answer whole. A body cut off part-way is a failure the scenario can check. */
export const read = (response: Response): Effect.Effect<Answer, Unanswered> =>
  Effect.map(
    Effect.tryPromise({ try: () => response.text(), catch: (cause) => new Unanswered({ cause }) }),
    (text) => ({ status: response.status, headers: response.headers, text, json: parseJson(text) }),
  )

/** A field of a JSON value, for terse assertions. */
export const field = (value: unknown, ...path: ReadonlyArray<string | number>): unknown => {
  let at: unknown = value
  for (const step of path) {
    if (typeof at !== "object" || at === null) return undefined
    at = Reflect.get(at, step)
  }
  return at
}

/**
 * Runs `check` until it succeeds: up to 50 tries 20 ms apart. Ledger writes
 * and other effects of an answer happen after the client has it.
 */
export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(check, { schedule: Schedule.spaced("20 millis"), times: 49 })

/** A condition a scenario waits for has not come true yet. */
export class NotYet extends Data.TaggedError("NotYet")<{ readonly what: string }> {}

/** Fails unless `condition` holds, so {@link eventually} tries again. */
export const until = (condition: boolean, what: string): Effect.Effect<void, NotYet> =>
  condition ? Effect.void : Effect.fail(new NotYet({ what }))
