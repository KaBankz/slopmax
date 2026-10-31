// A load-test rig: a mock provider, the real proxy in front of it with
// throwaway accounts, and the request bodies to send, so a load generator
// can measure what slopmax adds.
//
//   bun bench/bench.ts upstream 127.0.0.1:9100
//   bun bench/bench.ts proxy 127.0.0.1:9101 http://127.0.0.1:9100 /tmp/home
//   bun bench/bench.ts bodies /tmp/bodies
//
// `bench/bench.sh` runs them (or the compiled `dist/bench`) and drives the
// proxy with `oha`, as the Rust's `scripts/bench.sh` does.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

import { ConfigProvider, Effect, Layer } from "effect"

import {
  Account,
  Config,
  config as configs,
  daemon,
  error,
  Failure,
  Home,
  log,
  net,
  ProviderId,
  Store,
  time,
} from "@slopmax/core"

/** Text deltas per streamed answer. */
const DELTAS = 60
const DELTA = "The quick brown fox jumps over the lazy dog, then naps for a while. "

const USAGE = "usage: bench upstream <addr> | bench proxy <addr> <upstream-url> <home> | bench bodies <dir>"

const address = (text: string): configs.SocketAddr => {
  const addr = configs.SocketAddr.parse(text)
  if (addr === undefined) throw new Failure({ message: "invalid socket address syntax" })
  return addr
}

const upstream = (listen: configs.SocketAddr): void => {
  Bun.serve({ hostname: listen.ip, port: listen.port, fetch: answer })
  process.stderr.write(`mock provider on http://${configs.SocketAddr.display(listen)}\n`)
}

const utf8 = new TextEncoder()

/**
 * Answers like the providers do: a streamed reply with usage, and the
 * rate-limit headers slopmax reads; and both providers' limit resets.
 */
const answer = async (request: Request): Promise<Response> => {
  const sent = new Uint8Array(await request.arrayBuffer())
  const path = new URL(request.url).pathname
  const token = (request.headers.get("authorization") ?? "").replace(/^(?:Bearer )+/, "")
  const agent = request.headers.get("user-agent") ?? ""
  const method = request.method
  if (method === "GET" && path === "/wham/rate-limit-reset-credits") return creditList(token)
  if (method === "POST" && path === "/wham/rate-limit-reset-credits/consume") return consume(sent)
  if (method === "GET" && path === "/api/oauth/usage") return claudeResets(token, agent)
  if (method === "POST" && path.endsWith("/reset_rate_limits")) return claim(token, sent)
  const reset = time.Timestamp.asSecond(time.Timestamp.add(Date.now(), time.SignedDuration.fromHours(3)))
  let frames: ReadonlyArray<Uint8Array>
  let headers: Array<[string, string]>
  if (method === "POST" && path === "/v1/messages") {
    frames = MESSAGES
    headers = [
      ["anthropic-ratelimit-unified-status", "allowed"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-5h-reset", String(reset)],
      ["anthropic-ratelimit-unified-7d-utilization", "0.43"],
      ["anthropic-ratelimit-unified-7d-reset", String(reset + 86_400)],
      ["request-id", "req_bench"],
    ]
  } else if (method === "POST" && path === "/codex/responses") {
    frames = RESPONSES
    headers = [
      ["x-codex-primary-used-percent", "21.0"],
      ["x-codex-primary-window-minutes", "300"],
      ["x-codex-primary-reset-at", String(reset)],
      ["x-codex-secondary-used-percent", "43.0"],
      ["x-codex-secondary-window-minutes", "10080"],
      ["x-codex-secondary-reset-at", String(reset + 86_400)],
    ]
  } else {
    return new Response(null, { status: 404 })
  }
  // One frame at a time, as a provider streams them.
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[next++]
      if (frame === undefined) controller.close()
      else controller.enqueue(frame)
    },
  })
  return new Response(body, { headers: [["content-type", "text/event-stream"], ...headers] })
}

/** The reset credits redeemed so far. */
const REDEEMED: Array<string> = []

// When each of the two listings was first asked for, so their dates stay put.
let creditsStarted: time.Timestamp | undefined
let claudeStarted: time.Timestamp | undefined

const at = (started: time.Timestamp, hours: number): string =>
  time.Timestamp.display(time.Timestamp.add(started, time.SignedDuration.fromHours(hours)))

/**
 * Each ChatGPT account's unspent reset credits: two, granted weeks apart,
 * the first account's soon to expire. Dated from when the mock started,
 * so they stay put.
 */
const creditList = (token: string): Response => {
  creditsStarted ??= Date.now()
  const started = creditsStarted
  // Granted, then expiring, in hours from the start.
  const dates: ReadonlyArray<readonly [number, number]> =
    token === "bench-codex-0"
      ? [
          [-27 * 24 - 5, 19],
          [-6 * 24, 24 * 24],
        ]
      : token === "bench-codex-1"
        ? [
            [-12 * 24, 18 * 24],
            [-30, 29 * 24 - 6],
          ]
        : []
  const credits = dates
    .map(([granted, expires], i) => [`${token}-credit-${i}`, granted, expires] as const)
    .filter(([id]) => !REDEEMED.includes(id))
    .map(([id, granted, expires]) => ({
      id,
      status: "available",
      reset_type: "codex_rate_limits",
      title: "Rate limit reset",
      granted_at: at(started, granted),
      expires_at: at(started, expires),
    }))
  return jsonResponse({ available_count: credits.length, credits })
}

// `serde_json::from_slice(sent).unwrap_or_default()`, then a string field of it.
const stringField = (sent: Uint8Array, name: string): string => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(sent))
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const found = (value as Record<string, unknown>)[name]
      if (typeof found === "string") return found
    }
  } catch {
    // Not JSON: as an empty value.
  }
  return ""
}

/** Redeems the credit asked for, once. */
const consume = (sent: Uint8Array): Response => {
  const id = stringField(sent, "credit_id")
  let code: string
  if (REDEEMED.includes(id)) code = "already_redeemed"
  else {
    REDEEMED.push(id)
    code = "reset"
  }
  return jsonResponse({ code, windows_reset: 2 })
}

/** The reset grant every Pro and Max account got at a model's launch. */
const LAUNCH = "opus55-launch-promax-20260921"

/**
 * Claude's usage, with only its limit resets, so the demo's windows stay
 * as seeded: the first account holds a model launch's reset, the second
 * none. Claude lists them to Claude Code alone.
 */
const claudeResets = (token: string, agent: string): Response => {
  claudeStarted ??= Date.now()
  const started = claudeStarted
  if (!agent.startsWith("claude-cli/")) {
    return jsonResponse({ cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } })
  }
  const grants =
    token === "bench-claude-0" && !REDEEMED.includes(`${token}/${LAUNCH}`)
      ? [
          {
            id: LAUNCH,
            label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
            resets_total: 1,
            resets_left: 1,
            starts_at: at(started, -15 * 24 - 5),
            ends_at: at(started, 15 * 24 - 5),
            clears: ["five_hour", "seven_day", "seven_day_overage_included"],
            paused: false,
            usable_now: true,
            use_requires_limit: false,
          },
        ]
      : []
  const next = grants.length > 0 ? LAUNCH : null
  return jsonResponse({ cedar_ember: { eligible: true, grants, next_grant_id: next } })
}

/** Spends the account's reset of the grant asked for, once. */
const claim = (token: string, sent: Uint8Array): Response => {
  const grant = stringField(sent, "grant_id")
  const key = `${token}/${grant}`
  if (token !== "bench-claude-0" || grant !== LAUNCH) {
    return jsonResponse({ result: "ineligible", reason: "unknown_grant" })
  }
  if (REDEEMED.includes(key)) return jsonResponse({ result: "already_used", reason: "already_used", resets_left: 0 })
  REDEEMED.push(key)
  return jsonResponse({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] })
}

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

const event = (kind: string, data: string): Uint8Array => utf8.encode(`event: ${kind}\ndata: ${data}\n\n`)

const MESSAGES: ReadonlyArray<Uint8Array> = [
  event(
    "message_start",
    '{"type":"message_start","message":{"id":"msg_bench","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1200,"cache_read_input_tokens":48000,"cache_creation_input_tokens":900,"output_tokens":1}}}',
  ),
  event("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
  ...Array.from({ length: DELTAS }, () =>
    event(
      "content_block_delta",
      `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${DELTA}"}}`,
    ),
  ),
  event("content_block_stop", '{"type":"content_block_stop","index":0}'),
  event(
    "message_delta",
    '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":620}}',
  ),
  event("message_stop", '{"type":"message_stop"}'),
]

const RESPONSES: ReadonlyArray<Uint8Array> = [
  event(
    "response.created",
    '{"type":"response.created","response":{"id":"resp_bench","status":"in_progress","model":"gpt-6-sol"}}',
  ),
  ...Array.from({ length: DELTAS }, () =>
    event(
      "response.output_text.delta",
      `{"type":"response.output_text.delta","item_id":"msg_bench","output_index":0,"content_index":0,"delta":"${DELTA}"}`,
    ),
  ),
  event(
    "response.completed",
    '{"type":"response.completed","response":{"id":"resp_bench","status":"completed","model":"gpt-6-sol","usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":1000},"output_tokens":620,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":1820}}}',
  ),
]

/**
 * The production server, with two Claude and two ChatGPT accounts whose
 * traffic goes to `upstream`.
 */
const proxy = (listen: configs.SocketAddr, to: string, dir: string): Effect.Effect<void, Failure> =>
  Effect.gen(function* () {
    const home = Home.at(dir)
    const store = Store.at(home.accounts())
    const now = yield* time.Timestamp.now
    for (const provider of ["claude", "codex"] as const) {
      for (const i of [0, 1]) {
        const tokens = {
          accessToken: `bench-${provider}-${i}`,
          refreshToken: `bench-refresh-${provider}-${i}`,
          expiresAt: time.Timestamp.add(now, time.SignedDuration.fromHours(24 * 30)),
        }
        // A UUID, as Claude's organizations have: spending a limit reset
        // names it.
        const org = 100 * ProviderId.order(provider) + i
        // Plans, for what unused quota is worth.
        const plans = provider === "claude" ? ["max 20x", "max 5x"] : ["pro", "plus"]
        const account = Account.assignId({
          ...Account.make(provider, tokens, now),
          email: `${provider}${i}@bench.invalid`,
          orgId: `00000000-0000-4000-8000-${String(org).padStart(12, "0")}`,
          accountId: `acct-${provider}-${i}`,
          plan: plans[i] ?? "pro",
        })
        yield* store.upsert(account).pipe(error.context("saving a bench account"))
      }
    }
    // The home's own settings, but for what keeps the rig to itself.
    const loaded = yield* Config.loadFrom(home.config()).pipe(Effect.orElseSucceed(() => Config.default()))
    const config: Config = { ...loaded, listen, apiKey: "bench", refreshTokens: false, pollMins: 0 }
    const origins = new net.Origins([
      ["https://api.anthropic.com", to],
      ["https://chatgpt.com/backend-api", to],
    ])
    yield* daemon.serve(config, home, origins)
  })

/** Filler text from a fixed seed, so every run sends the same bodies. */
class Words {
  private static readonly WORDS = [
    "the",
    "quick",
    "brown",
    "fox",
    "jumps",
    "over",
    "lazy",
    "dog",
    "file",
    "path",
    "function",
    "return",
    "value",
    "error",
    "test",
    "build",
  ] as const

  constructor(private state: bigint) {}

  text(count: number): string {
    const mask = (1n << 64n) - 1n
    const out: Array<string> = []
    for (let i = 0; i < count; i++) {
      // xorshift64
      let x = this.state
      x ^= (x << 13n) & mask
      x ^= x >> 7n
      x ^= (x << 17n) & mask
      this.state = x
      out.push(Words.WORDS[Number(x % 16n)] ?? "the")
    }
    return out.join(" ")
  }
}

/**
 * Writes the request bodies to send: a first turn, and a long conversation
 * of about 300 KB, for each agent.
 */
const bodies = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  const write = (name: string, body: unknown): void => writeFileSync(join(dir, `${name}.json`), JSON.stringify(body))
  const words = new Words(7n)

  const userId = { device_id: "d".repeat(64), account_uuid: "", session_id: "bench" }
  const tools = Array.from({ length: 25 }, (_, i) => {
    const properties: Record<string, unknown> = {}
    for (let j = 0; j < 6; j++) properties[`p${j}`] = { type: "string", description: words.text(15) }
    return {
      name: `Tool${i}`,
      description: words.text(120),
      input_schema: { type: "object", properties },
    }
  })
  const turns: Array<unknown> = []
  for (let i = 0; i < 60; i++) {
    turns.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: words.text(500) }],
    })
    const thinking = { type: "thinking", thinking: words.text(60), signature: "S".repeat(400) }
    turns.push({
      role: "assistant",
      content: [thinking, { type: "tool_use", id: `t${i + 1}`, name: "Tool3", input: { p0: words.text(40) } }],
    })
  }
  turns.push({ role: "user", content: "continue" })
  const system = `You are Claude Code. ${words.text(2500)}`
  const claude = (messages: unknown, withTools: unknown) => ({
    model: "claude-opus-5-5",
    max_tokens: 32000,
    stream: true,
    thinking: { type: "adaptive" },
    metadata: { user_id: JSON.stringify(userId) },
    system: [{ type: "text", text: system }],
    tools: withTools,
    messages,
  })
  write("claude-small", claude([{ role: "user", content: "hi" }], []))
  write("claude-large", claude(turns, tools))

  const items: Array<unknown> = []
  for (let i = 0; i < 60; i++) {
    const command = JSON.stringify({ command: ["bash", "-lc", words.text(30)] })
    const message = { type: "message", role: "user", content: [{ type: "input_text", text: words.text(200) }] }
    const output = { type: "function_call_output", call_id: `c${i}`, output: words.text(500) }
    items.push(
      message,
      { type: "reasoning", summary: [], encrypted_content: "E".repeat(600) },
      { type: "function_call", name: "shell", arguments: command, call_id: `c${i}` },
      output,
    )
  }
  const instructions = `You are Codex. ${words.text(1500)}`
  const codex = (input: unknown) => ({
    model: "gpt-6-sol",
    instructions,
    input,
    tools: [],
    store: false,
    stream: true,
    prompt_cache_key: "bench",
  })
  const hi = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
  write("codex-small", codex(hi))
  write("codex-large", codex(items))
}

const fail = (e: unknown): never => {
  process.stderr.write(`Error: ${error.chain(e)}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
try {
  const [command, ...rest] = args
  if (command === "upstream" && rest.length === 1) upstream(address(rest[0] ?? ""))
  else if (command === "proxy" && rest.length === 3) {
    const [listen = "", to = "", home = ""] = rest
    const environment = ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))
    const program = proxy(address(listen), to, home).pipe(
      Effect.provide(log.layer(log.Level.Warn).pipe(Layer.provideMerge(environment))),
    )
    Effect.runPromise(program).then(() => process.exit(0), fail)
  } else if (command === "bodies" && rest.length === 1) bodies(rest[0] ?? "")
  else throw new Failure({ message: USAGE })
} catch (e) {
  fail(e)
}
