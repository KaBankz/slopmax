// The accounts and providers the end-to-end scenarios run against.
//
// Subscription accounts are named `{provider}{i}` and added at second
// `1000 + i`, so with fill-first they are tried in the order given; each
// holds the token that picks its script (`tok-ok`, `tok-limited`, …) and a
// refresh token `refresh-{name}`, and expires 8 hours from now on the clock
// the test runs on. Claude accounts belong to an organization of their own. Endpoints live under `https://endpoints.test`, which the
// harness rewrites to the mock provider like every provider origin.
import { AccountId, type Dialect, Limits, type ProviderId, Window } from "@slopmax/domain"
import { DateTime, Effect, Redacted } from "effect"
import { Account, Credential, Identity, Tokens } from "../../src/account.ts"
import { observe, Pool } from "../../src/pool.ts"
import { byToken, chatgptApi, claudeApi, endpointApi, json, on, type Route, sse, xaiApi } from "./memory-upstream.ts"

/** Where compatible endpoints live in these scenarios. */
export const endpointsOrigin = "https://endpoints.test"

/** A signed-in account named `name` holding `token`, added at second `1000 + order`; every test's sign-ins are built here. */
export const signedIn = (options: {
  readonly provider: ProviderId
  readonly id: string
  readonly name: string
  readonly token: string
  readonly order: number
  readonly expiresAt: DateTime.Utc
  readonly refresh?: string | undefined
  readonly orgId?: string | undefined
}): Account =>
  new Account({
    id: AccountId.make(options.id),
    provider: options.provider,
    credential: Credential.cases.OAuth.make({
      tokens: new Tokens({
        access: Redacted.make(options.token),
        refresh: Redacted.make(options.refresh ?? `refresh-${options.name}`),
        expiresAt: options.expiresAt,
      }),
    }),
    identity: new Identity({
      email: `${options.name}@example.com`,
      accountId: `acct-${options.name}`,
      ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
    }),
    addedAt: DateTime.makeUnsafe((1000 + options.order) * 1000),
  })

/** The Claude organization of the `order`th Claude account: a UUID, as Claude's are, since resets are spent by it. */
export const claudeOrg = (order: number): string => `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`

/** One subscription account, the `order`th of its provider, holding `token`. */
export const subscription = (
  provider: ProviderId,
  token: string,
  order: number,
  now: DateTime.Utc,
  options: { readonly refresh?: string; readonly expiresAt?: DateTime.Utc } = {},
): Account => {
  const name = `${provider}${order}`
  return signedIn({
    provider,
    id: `${provider}-${order}`,
    name,
    token,
    order,
    expiresAt: options.expiresAt ?? DateTime.add(now, { hours: 8 }),
    refresh: options.refresh,
    orgId: provider === "claude" ? claudeOrg(order) : undefined,
  })
}

/** Accounts of `provider` holding `tokens`, in that order, signed in as of now. */
export const subscriptions = (provider: ProviderId, tokens: ReadonlyArray<string>) =>
  Effect.map(DateTime.now, (now) => tokens.map((token, order) => subscription(provider, token, order, now)))

/** An API key account of `provider`, `{provider}-{name}`. */
export const keyAccount = (
  provider: ProviderId,
  key: string,
  options: { readonly name?: string; readonly order?: number } = {},
): Account =>
  new Account({
    id: AccountId.make(`${provider}-${options.name ?? "key"}`),
    provider,
    credential: Credential.cases.Key.make({ key: Redacted.make(key) }),
    addedAt: DateTime.makeUnsafe((1000 + (options.order ?? 50)) * 1000),
  })

/**
 * A compatible endpoint `compat-{name}` speaking `dialect`, serving
 * `models`, under `{endpointsOrigin}/{name}` unless `baseUrl` says where.
 * OpenAI-style bases end in `/v1`; Anthropic-style ones do not, since
 * Messages paths carry their own.
 */
export const endpointAccount = (
  name: string,
  dialect: Dialect,
  models: ReadonlyArray<string>,
  options: { readonly key?: string; readonly order?: number; readonly baseUrl?: string } = {},
): Account =>
  new Account({
    id: AccountId.make(`compat-${name}`),
    provider: "compat",
    credential: Credential.cases.Endpoint.make({
      baseUrl:
        options.baseUrl ?? (dialect === "messages" ? `${endpointsOrigin}/${name}` : `${endpointsOrigin}/${name}/v1`),
      dialect,
      models: [...models],
      ...(options.key === undefined ? {} : { key: Redacted.make(options.key) }),
    }),
    addedAt: DateTime.makeUnsafe((1000 + (options.order ?? 60)) * 1000),
  })

/** Tells the pool `id` has used `used` percent of its week, resetting in 72 hours, with 2 limit resets left. */
export const observeUsage = (id: AccountId, used: number) =>
  Effect.gen(function* () {
    const pool = yield* Pool
    yield* pool.update((m, now) =>
      observe(
        m,
        id,
        new Limits({
          windows: [Window.of("7d", used, DateTime.add(now, { hours: 72 }))],
          observedAt: now,
          resetCredits: 2,
        }),
        now,
      ),
    )
  })

/** A Chat completion whose usage is `prompt` in and `completion` out. */
const chatCompletion = (model: string, prompt: number, completion: number) =>
  json(200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })

/**
 * The API-key and endpoint vendors beside the subscriptions:
 * - xAI's Chat for `key-xai` (12 in, 3 out);
 * - OpenAI's Responses for `key-openai` (a stream, 5 in, 2 out);
 * - a Messages endpoint at `kimi` taking `x-api-key: key-kimi` (a whole message, 3 in, 1 out);
 * - a Chat endpoint at `local` with no key (4 in, 1 out).
 */
export const vendorApis: ReadonlyArray<Route> = [
  on("POST https://api.x.ai/v1/chat/completions", byToken({ "key-xai": () => chatCompletion("grok-4", 12, 3) })),
  on(
    "POST https://api.openai.com/v1/responses",
    byToken({
      "key-openai": () =>
        sse([
          { type: "response.created", response: { id: "resp_k", status: "in_progress" } },
          { type: "response.output_text.delta", delta: "Hi" },
          {
            type: "response.completed",
            response: {
              id: "resp_k",
              status: "completed",
              usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 },
            },
          },
        ]),
    }),
  ),
  on(
    `POST ${endpointsOrigin}/kimi/v1/messages`,
    byToken({
      "key-kimi": () =>
        json(200, {
          id: "msg_k",
          type: "message",
          role: "assistant",
          model: "kimi-k2",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
    }),
  ),
  ...endpointApi,
]

/** A time `hours` from `now` (epoch seconds), as the providers write one. */
const hoursFrom = (now: number, hours: number) => new Date((now + hours * 3600) * 1000).toISOString()

/**
 * The providers' usage and limit-reset endpoints, which the daemon's polling,
 * reset listing and spending reach:
 * - ChatGPT's usage for `tok-ok`: plan `pro`, a 5-hour window 5% used, resetting in an hour (other tokens 401);
 * - Claude's usage: the 5-hour window 25% used, resetting in 2 hours, and its limit resets:
 *   to anything but Claude Code, not eligible (`surface`); for `tok-ok`, the grants `older`
 *   (ending in 30 hours) and `launch` (labelled, granted 15 days ago, ending in 15 days),
 *   `launch` spent next; for other tokens, `no_grant`;
 * - spending a Claude limit reset clears both windows, leaving none.
 */
export const usageApis: ReadonlyArray<Route> = [
  on(
    "GET /backend-api/wham/usage",
    byToken({
      "tok-ok": (_seen, { now }) =>
        json(200, {
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: hoursFrom(now(), 1) },
          },
        }),
    }),
  ),
  on("GET /api/oauth/usage", (seen, { now }) => {
    const claudeCode = seen.headers.get("user-agent")?.startsWith("claude-cli/") === true
    const resets = !claudeCode
      ? { eligible: false, ineligible_reason: "surface", grants: [] }
      : seen.token === "tok-ok"
        ? {
            eligible: true,
            next_grant_id: "launch",
            grants: [
              { id: "older", resets_total: 1, resets_left: 1, ends_at: hoursFrom(now(), 30) },
              {
                id: "launch",
                label: "Model launch: one usage-limit reset",
                resets_total: 1,
                resets_left: 1,
                starts_at: hoursFrom(now(), -24 * 15),
                ends_at: hoursFrom(now(), 24 * 15),
              },
            ],
          }
        : { eligible: false, ineligible_reason: "no_grant" }
    return json(200, { five_hour: { utilization: 25, resets_at: hoursFrom(now(), 2) }, cedar_ember: resets })
  }),
  on("POST /api/organizations/*", (seen) =>
    seen.url.pathname.endsWith("/reset_rate_limits")
      ? json(200, { result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] })
      : json(404, {}),
  ),
]

/** Every provider a scenario may reach: Claude, ChatGPT, xAI, OpenAI and the endpoints, usage and limit resets first. */
export const providers: ReadonlyArray<Route> = [...usageApis, ...claudeApi, ...chatgptApi, ...xaiApi, ...vendorApis]
