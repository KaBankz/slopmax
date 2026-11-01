// The bench's mock provider: answers like Claude and ChatGPT do, with a
// streamed reply carrying usage and the rate-limit headers slopmax reads,
// and both providers' limit resets, so a load generator measures what
// slopmax adds and the demo has resets to list and spend.
//
// The answers are plain functions over a Bun server, with no Effect on the
// path a request takes: the mock is the measuring instrument, and it must
// answer far faster than the proxy it measures. Streams are encoded once
// and sent as a provider sends them: chunked, one event per chunk, so the
// proxy's relay and usage tap see many small writes rather than one buffer.
import { Data, DateTime, Effect, type Scope } from "effect"

/** Text deltas per streamed answer. */
export const deltas = 60
/** The text of each delta. */
export const deltaText = "The quick brown fox jumps over the lazy dog, then naps for a while. "

const event = (kind: string, data: unknown) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`

/** Claude's streamed answer: usage at the start and the end, 60 deltas between. */
export const messagesEvents = (): ReadonlyArray<string> => [
  event("message_start", {
    type: "message_start",
    message: {
      id: "msg_bench",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 1200,
        cache_read_input_tokens: 48000,
        cache_creation_input_tokens: 900,
        output_tokens: 1,
      },
    },
  }),
  event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...Array.from({ length: deltas }, () =>
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: deltaText },
    }),
  ),
  event("content_block_stop", { type: "content_block_stop", index: 0 }),
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 620 },
  }),
  event("message_stop", { type: "message_stop" }),
]

/** ChatGPT's streamed answer: created, 60 deltas, completed with usage. */
export const responsesEvents = (): ReadonlyArray<string> => [
  event("response.created", {
    type: "response.created",
    response: { id: "resp_bench", status: "in_progress", model: "gpt-6-sol" },
  }),
  ...Array.from({ length: deltas }, () =>
    event("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg_bench",
      output_index: 0,
      content_index: 0,
      delta: deltaText,
    }),
  ),
  event("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_bench",
      status: "completed",
      model: "gpt-6-sol",
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens: 620,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1820,
      },
    },
  }),
]

const utf8 = new TextEncoder()
const messagesFrames = messagesEvents().map((frame) => utf8.encode(frame))
const responsesFrames = responsesEvents().map((frame) => utf8.encode(frame))

/** A streamed body of `frames`, one chunk each and no length, as a provider streams. */
export const framed = (frames: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    pull(controller) {
      for (const frame of frames) controller.enqueue(frame)
      controller.close()
    },
  })

/** Claude's rate-limit headers: 21% of five hours used, resetting in three hours, and 43% of the week. */
export const claudeHeaders = (nowSeconds: number): Record<string, string> => {
  const reset = nowSeconds + 3 * 3600
  return {
    "content-type": "text/event-stream",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.21",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "0.43",
    "anthropic-ratelimit-unified-7d-reset": String(reset + 86_400),
    "request-id": "req_bench",
  }
}

/** ChatGPT's rate-limit headers: the same shares, in its own words. */
export const codexHeaders = (nowSeconds: number): Record<string, string> => {
  const reset = nowSeconds + 3 * 3600
  return {
    "content-type": "text/event-stream",
    "x-codex-primary-used-percent": "21.0",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(reset),
    "x-codex-secondary-used-percent": "43.0",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(reset + 86_400),
  }
}

/** The limit-reset grant every Pro and Max Claude account got at a model's launch. */
export const launchGrant = "opus55-launch-promax-20260921"

/**
 * Each ChatGPT account's unspent reset credits, as hours from the mock's
 * start (granted, then expiring): two each, granted weeks apart, the first
 * account's first one about to expire.
 */
const creditHours: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  "bench-codex-0": [
    [-27 * 24 - 5, 19],
    [-6 * 24, 24 * 24],
  ],
  "bench-codex-1": [
    [-12 * 24, 18 * 24],
    [-30, 29 * 24 - 6],
  ],
}

/** What the mock remembers between requests: when it started, and the resets spent so far. */
export interface MockState {
  readonly startedAt: DateTime.Utc
  readonly redeemed: Set<string>
}

const hoursFrom = (state: MockState, hours: number) => DateTime.formatIso(DateTime.add(state.startedAt, { hours }))

/** `GET /wham/rate-limit-reset-credits`: the credits a ChatGPT token has left. */
export const creditList = (state: MockState, token: string) => {
  const credits = (creditHours[token] ?? [])
    .map(([granted, expires], i) => ({ id: `${token}-credit-${i}`, granted, expires }))
    .filter((credit) => !state.redeemed.has(credit.id))
    .map((credit) => ({
      id: credit.id,
      status: "available",
      reset_type: "codex_rate_limits",
      title: "Rate limit reset",
      granted_at: hoursFrom(state, credit.granted),
      expires_at: hoursFrom(state, credit.expires),
    }))
  return { available_count: credits.length, credits }
}

/** `POST /wham/rate-limit-reset-credits/consume`: spends the credit asked for, once. */
export const consumeCredit = (state: MockState, creditId: string) => {
  if (state.redeemed.has(creditId)) return { code: "already_redeemed", windows_reset: 2 }
  state.redeemed.add(creditId)
  return { code: "reset", windows_reset: 2 }
}

/**
 * `GET /api/oauth/usage`, with only Claude's limit resets, so seeded windows
 * stay as they were: the first account holds the launch grant, the second
 * none. Claude lists them to Claude Code alone.
 */
export const claudeResets = (state: MockState, token: string, userAgent: string) => {
  if (!userAgent.startsWith("claude-cli/")) {
    return { cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } }
  }
  const holds = token === "bench-claude-0" && !state.redeemed.has(`${token}/${launchGrant}`)
  const grants = holds
    ? [
        {
          id: launchGrant,
          label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
          resets_total: 1,
          resets_left: 1,
          starts_at: hoursFrom(state, -15 * 24 - 5),
          ends_at: hoursFrom(state, 15 * 24 - 5),
          clears: ["five_hour", "seven_day", "seven_day_overage_included"],
          paused: false,
          usable_now: true,
          use_requires_limit: false,
        },
      ]
    : []
  return { cedar_ember: { eligible: true, grants, next_grant_id: holds ? launchGrant : null } }
}

/** `POST /api/organizations/{org}/reset_rate_limits`: spends the account's reset of the grant asked for, once. */
export const claimReset = (state: MockState, token: string, grantId: string) => {
  const key = `${token}/${grantId}`
  if (token !== "bench-claude-0" || grantId !== launchGrant) return { result: "ineligible", reason: "unknown_grant" }
  if (state.redeemed.has(key)) return { result: "already_used", reason: "already_used", resets_left: 0 }
  state.redeemed.add(key)
  return { result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] }
}

const json = (value: unknown) => Response.json(value)

const notFound = () => new Response(null, { status: 404 })

/** The bearer token a request carries, or empty. */
export const bearerOf = (headers: Headers): string => (headers.get("authorization") ?? "").replace(/^Bearer /, "")

/** A field of a JSON body as text, or empty: a broken body asks for nothing. */
const fieldOf = async (request: Request, field: string): Promise<string> => {
  const parsed: unknown = await request.json().catch(() => undefined)
  if (typeof parsed !== "object" || parsed === null || !(field in parsed)) return ""
  const value: unknown = Reflect.get(parsed, field)
  return typeof value === "string" ? value : ""
}

/** The mock's answers over `state`; `nowSeconds` dates the rate-limit headers. */
export const makeMock = (state: MockState, nowSeconds: () => number = () => Math.floor(Date.now() / 1000)) => ({
  state,
  handle: async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    const token = bearerOf(request.headers)
    if (request.method === "POST" && path === "/v1/messages") {
      // The body is read in full, as a provider would, before answering.
      await request.arrayBuffer()
      return new Response(framed(messagesFrames), { headers: claudeHeaders(nowSeconds()) })
    }
    if (request.method === "POST" && path === "/codex/responses") {
      await request.arrayBuffer()
      return new Response(framed(responsesFrames), { headers: codexHeaders(nowSeconds()) })
    }
    if (request.method === "GET" && path === "/wham/rate-limit-reset-credits") return json(creditList(state, token))
    if (request.method === "POST" && path === "/wham/rate-limit-reset-credits/consume") {
      return json(consumeCredit(state, await fieldOf(request, "credit_id")))
    }
    if (request.method === "GET" && path === "/api/oauth/usage") {
      return json(claudeResets(state, token, request.headers.get("user-agent") ?? ""))
    }
    if (request.method === "POST" && path.endsWith("/reset_rate_limits")) {
      return json(claimReset(state, token, await fieldOf(request, "grant_id")))
    }
    return notFound()
  },
})

export type Mock = ReturnType<typeof makeMock>

/** A host and port to listen on. */
export interface Address {
  readonly hostname: string
  readonly port: number
}

/** The mock could not listen where it was asked to, most often because the port is taken. */
export class MockCannotListen extends Data.TaggedError("MockCannotListen")<{
  readonly address: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `the mock provider cannot listen on ${this.address}; is something else using that port?`
  }
}

/** The mock provider listening on `address` (port 0 picks a free one) until the scope closes; gives its URL. */
export const serveMock = (address: Address): Effect.Effect<string, MockCannotListen, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.flatMap(DateTime.now, (startedAt) =>
      Effect.try({
        try: () => {
          const mock = makeMock({ startedAt, redeemed: new Set() })
          return Bun.serve({ hostname: address.hostname, port: address.port, idleTimeout: 0, fetch: mock.handle })
        },
        catch: (cause) => new MockCannotListen({ address: `${address.hostname}:${address.port}`, cause }),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map((server) => `http://${address.hostname}:${server.port ?? address.port}`))
