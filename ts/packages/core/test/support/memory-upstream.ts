// Providers answered in process: an `Upstream` whose every call goes to a
// small router instead of the network. It records each request (method,
// path, headers and body) and answers from scripts, so proxy tests run with
// no sockets and on the test clock.
//
// `claudeApi`, `chatgptApi` and `endpointApi` are the scripted providers the
// proxy's tests and the end-to-end harness share: each answers by the
// bearer token an account holds, so a test picks an account's behavior by
// naming its token (`tok-ok`, `tok-limited`, `tok-busy`, …).
import { Layer } from "effect"
import { Upstream } from "../../src/upstream.ts"

/** One call the upstream saw. */
export interface Seen {
  readonly method: string
  readonly url: URL
  /** The path and query. */
  readonly path: string
  readonly headers: Headers
  readonly body: Uint8Array
  /** The body as text. */
  readonly text: string
  /** The bearer token it carried, else its `x-api-key`. */
  readonly token: string | undefined
}

/** What a script reads besides the call: the time, and how often a token was seen on a path. */
export interface Context {
  /** Now, in epoch seconds, from the clock the test runs on. */
  readonly now: () => number
  /** How many calls so far (this one counted) carried `token` to this path. */
  readonly count: (seen: Seen) => number
  /** Whether a call to `path` has been seen. */
  readonly saw: (path: string) => boolean
}

export type Answer = (seen: Seen, context: Context) => Response | Promise<Response>

/** A route: `METHOD /path` (the path may end in `*` to take everything under it), and its answer. */
export interface Route {
  readonly method: string
  readonly path: string
  readonly answer: Answer
}

/** Answers `METHOD /path` with `answer`. A path starting with a scheme matches the whole URL, else the path alone. */
export const on = (spec: string, answer: Answer): Route => {
  const space = spec.indexOf(" ")
  return { method: spec.slice(0, space), path: spec.slice(space + 1), answer }
}

/** Answers by the call's token; anything else hears `otherwise` (401 by default). */
export const byToken =
  (answers: Readonly<Record<string, Answer>>, otherwise: Answer = () => status(401, "invalid token")): Answer =>
  (seen, context) => {
    const answer = seen.token === undefined ? undefined : answers[seen.token]
    return (answer ?? otherwise)(seen, context)
  }

/** A JSON answer. */
export const json = (code: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", ...headers } })

/** An answer with a status and a JSON error body naming `message`. */
export const status = (code: number, message = "", headers: Readonly<Record<string, string>> = {}): Response =>
  json(code, { error: { type: code === 401 ? "authentication_error" : "error", message } }, headers)

/** One server-sent event: data alone, or a named event. */
export type Event = unknown | { readonly event: string; readonly data: unknown }

const isNamed = (event: Event): event is { readonly event: string; readonly data: unknown } =>
  typeof event === "object" && event !== null && "event" in event && "data" in event

/** The text of server-sent events. */
export const sseText = (events: ReadonlyArray<Event>): string =>
  events
    .map((event) =>
      isNamed(event)
        ? `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("")

/** A 200 event stream. */
export const sse = (events: ReadonlyArray<Event>, headers: Readonly<Record<string, string>> = {}, code = 200) =>
  new Response(sseText(events), { status: code, headers: { "content-type": "text/event-stream", ...headers } })

/** A 200 event stream sent as `chunks` (byte strings), each its own read, `gap` apart on the real clock. */
export const chunked = (chunks: ReadonlyArray<string>, headers: Readonly<Record<string, string>> = {}): Response => {
  const encoder = new TextEncoder()
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(encoder.encode(chunk))
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
}

/** An event stream whose body is the given stream, for tests that drive it chunk by chunk. */
export const streaming = (body: ReadableStream<Uint8Array>, headers: Readonly<Record<string, string>> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } })

const tokenOf = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization")
  if (authorization?.startsWith("Bearer ") === true) return authorization.slice(7)
  return headers.get("x-api-key") ?? undefined
}

const matches = (route: Route, seen: Seen): boolean => {
  if (route.method !== "*" && route.method !== seen.method) return false
  const target = /^[a-z]+:\/\//.test(route.path) ? `${seen.url.origin}${seen.url.pathname}` : seen.url.pathname
  return route.path.endsWith("*") ? target.startsWith(route.path.slice(0, -1)) : target === route.path
}

const wallClock = () => Date.now()

/**
 * An in-process upstream over `routes`; anything they do not take is a 404.
 * WebSockets cannot be answered in process: a dial to a URL starting with a
 * key of `sockets` goes to its value (a mock socket server) instead.
 */
export const memoryUpstream = (routes: ReadonlyArray<Route>, sockets: Readonly<Record<string, string>> = {}) => {
  const seen: Array<Seen> = []
  let now = wallClock
  const counts = new Map<string, number>()
  const context: Context = {
    now: () => Math.floor(now() / 1000),
    count: (call) => counts.get(`${call.url.pathname} ${call.token ?? ""}`) ?? 0,
    saw: (path) => seen.some((call) => call.url.pathname.endsWith(path)),
  }
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const body = new Uint8Array(await request.arrayBuffer())
    const call: Seen = {
      method: request.method,
      url,
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
      text: new TextDecoder().decode(body),
      token: tokenOf(request.headers),
    }
    seen.push(call)
    const key = `${url.pathname} ${call.token ?? ""}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const route = routes.find((candidate) => matches(candidate, call))
    return route === undefined ? json(404, {}) : route.answer(call, context)
  }
  const layer: Layer.Layer<Upstream> = Upstream.layerHandler(handle, sockets)
  return {
    layer,
    /** Records and answers one call as the upstream would: what the mock provider serves on a real port. */
    handle,
    seen,
    /** The calls to a path (the path alone, query ignored). */
    at: (path: string) => seen.filter((call) => call.url.pathname === path),
    /** The paths called, in order. */
    paths: () => seen.map((call) => call.url.pathname),
    /** Forgets the calls seen so far. */
    clear: () => {
      seen.length = 0
      counts.clear()
    },
    /** Reads the time from `clock` (epoch milliseconds), such as the test clock. */
    useClock: (clock: () => number) => {
      now = clock
    },
  }
}

export type MemoryUpstream = ReturnType<typeof memoryUpstream>

/** Merged into another layer, for tests that build the rest themselves. */
export const upstreamLayer = (upstream: MemoryUpstream): Layer.Layer<Upstream> => upstream.layer

// ---------------------------------------------------------------------------
// Scripted providers

/** Claude's answer to a working token: a short stream with usage, and its 5-hour window a quarter used. */
const claudeOk: Answer = (_seen, { now }) =>
  sse(
    [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_1",
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 },
          },
        },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      },
      { event: "message_delta", data: { type: "message_delta", usage: { output_tokens: 25 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ],
    {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": String(now() + 7200),
    },
  )

/**
 * Claude's API and sign-in, by token:
 * - `tok-ok`, `tok-renewed`: a stream with usage;
 * - `tok-limited`: 429, the 5-hour window spent for an hour;
 * - `tok-fast`: 429 refusing fast mode, which is the request's problem;
 * - `tok-busy`: 429 `slow down`, with no window headers (throttled);
 * - `tok-overloaded`: 529;
 * - anything else: 401.
 * Refreshing `refresh-good` gives `tok-renewed`; any other refresh token is revoked.
 */
export const claudeApi: ReadonlyArray<Route> = [
  on(
    "POST /v1/messages*",
    byToken({
      "tok-ok": claudeOk,
      "tok-renewed": claudeOk,
      "tok-limited": (_seen, { now }) =>
        json(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "limited" } },
          {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": String(now() + 3600),
            "anthropic-ratelimit-unified-5h-utilization": "1.0",
          },
        ),
      "tok-fast": () =>
        json(
          429,
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Usage credits are required for fast mode." },
          },
          { "anthropic-ratelimit-unified-status": "allowed" },
        ),
      "tok-busy": () => json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
      "tok-overloaded": () => json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    }),
  ),
  on("POST https://platform.claude.com/v1/oauth/token", async (seen) => {
    const sent: unknown = JSON.parse(seen.text)
    const refresh = typeof sent === "object" && sent !== null && "refresh_token" in sent ? sent.refresh_token : ""
    return refresh === "refresh-good"
      ? json(200, { access_token: "tok-renewed", refresh_token: "refresh-next", expires_in: 3600 })
      : json(400, { error: "invalid_grant", error_description: "refresh token revoked" })
  }),
  on("GET /api/oauth/profile", () => json(200, {})),
]

const codexCompleted = (usage: { readonly input: number; readonly cached: number; readonly output: number }) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output,
    },
  },
})

/** ChatGPT's answer to a working token: created, a word, completed; the week 40% used. */
export const codexOk: Answer = (_seen, { now }) =>
  sse(
    [
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "Hi" },
      codexCompleted({ input: 100, cached: 60, output: 7 }),
    ],
    {
      "x-codex-primary-used-percent": "40",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": String(now() + 86_400),
    },
  )

const usageLimit: Answer = (_seen, { now }) =>
  json(429, { error: { type: "usage_limit_reached", message: "limit", resets_at: now() + 5400 } })

const untilRedeemed: Answer = (seen, context) =>
  context.saw("/rate-limit-reset-credits/consume") ? codexOk(seen, context) : usageLimit(seen, context)

/** A time in epoch seconds, as ChatGPT writes one. */
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/**
 * ChatGPT's Codex backend and reset credits, by token:
 * - `tok-ok`: a stream, the week 40% used;
 * - `tok-talk`: reasoning state, `Hello`, a `Bash` call `call_1`, completed;
 * - `tok-quiet`: 200, then `usage_limit_reached` inside the stream;
 * - `tok-overloaded`: 200, then `server_is_overloaded` inside the stream;
 * - `tok-limited`: 429 `usage_limit_reached` for 90 minutes;
 * - `tok-credit`, `tok-expiring`: spent until a credit is redeemed (`…/consume`), then like `tok-ok`;
 * - `tok-flaky`: 503 on every odd call, else like `tok-ok`;
 * - `tok-down`: 502;
 * - anything else: 401.
 * Every account lists `credit-later` (in 48 hours); `tok-expiring` also
 * `credit-soon` (in an hour) and one already redeemed.
 */
export const chatgptApi: ReadonlyArray<Route> = [
  on(
    "POST /backend-api/codex/responses",
    byToken({
      "tok-ok": codexOk,
      "tok-talk": () =>
        sse([
          { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
          {
            type: "response.output_item.done",
            item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] },
          },
          { type: "response.output_text.delta", delta: "Hello" },
          {
            type: "response.output_item.done",
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash", arguments: '{"command":"ls"}' },
          },
          codexCompleted({ input: 30, cached: 10, output: 5 }),
        ]),
      "tok-quiet": () =>
        sse([
          { type: "response.created", response: { id: "resp_3", status: "in_progress" } },
          {
            type: "response.failed",
            response: {
              id: "resp_3",
              status: "failed",
              error: { code: "usage_limit_reached", message: "The usage limit has been reached" },
            },
          },
        ]),
      "tok-overloaded": () =>
        sse([
          { type: "response.created", response: { id: "resp_4", status: "in_progress" } },
          {
            type: "response.failed",
            response: { id: "resp_4", status: "failed", error: { code: "server_is_overloaded", message: "busy" } },
          },
        ]),
      "tok-limited": usageLimit,
      "tok-credit": untilRedeemed,
      "tok-expiring": untilRedeemed,
      "tok-flaky": (seen, context) =>
        context.count(seen) % 2 === 1 ? status(503, "upstream connect error") : codexOk(seen, context),
      "tok-down": () => status(502, "bad gateway"),
    }),
  ),
  on("GET /backend-api/wham/rate-limit-reset-credits", (seen, { now }) => {
    const later = {
      id: "credit-later",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: iso(now() + 48 * 3600),
    }
    if (seen.token !== "tok-expiring") return json(200, { credits: [later] })
    return json(200, {
      credits: [
        later,
        {
          id: "credit-soon",
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: iso(now() - 29 * 86_400),
          expires_at: iso(now() + 3600),
        },
        { id: "credit-spent", status: "redeemed", reset_type: "codex_rate_limits", expires_at: iso(now() + 7200) },
      ],
    })
  }),
  on("POST /backend-api/wham/rate-limit-reset-credits/consume", () => json(200, { code: "reset" })),
  on("GET /backend-api/wham/usage", () => json(200, { plan_type: "pro" })),
  on("GET /backend-api/codex/models", () =>
    json(200, {
      models: [{ slug: "gpt-6-sol" }, { slug: "gpt-6-sol-mini" }, { slug: "codex-internal", visibility: "hide" }],
    }),
  ),
]

/** xAI's API for the key `key-xai`: two models listed. */
export const xaiApi: ReadonlyArray<Route> = [
  on(
    "GET https://api.x.ai/v1/models",
    byToken({ "key-xai": () => json(200, { object: "list", data: [{ id: "grok-4" }, { id: "grok-code-fast-1" }] }) }),
  ),
]

/** A compatible endpoint at `/local/v1` that answers Chat requests with a short completion. */
export const endpointApi: ReadonlyArray<Route> = [
  on("POST /local/v1/chat/completions", () =>
    json(200, {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "local-model",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }),
  ),
]
