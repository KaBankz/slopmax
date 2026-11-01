// The hub's answers. CLIProxyAPI's `api-call` sends any request to any
// address with an account's token filled in; slopmax keeps the request and
// answer shapes but not the relay. It answers the usage and limit-reset
// calls hub clients make, usage from the readings slopmax already keeps,
// and refuses everything else, so no token ever leaves for an address the
// caller picked.
import {
  type AccountId,
  isSubscription,
  type Limits,
  type ProviderId,
  upcomingReset,
  usedAt,
  type Window,
} from "@slopmax/domain"
import { Data, DateTime, Duration, Effect, FiberSet, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import type { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import { clearBlocks, type Health, healthOf, isBlocked, Pool, unexpiredResets } from "../pool.ts"
import { providerOf } from "../providers/registry.ts"
import { Quota } from "../quota.ts"
import { SettingsService } from "../settings.ts"
import { type AuthFile, type CallAnswer, HubApi, HubBadRequest, HubForbidden, HubNotFound } from "./hub-api.ts"

/** The calls slopmax answers, by the provider whose accounts they are for. */
export const claudeUsageUrl = "https://api.anthropic.com/api/oauth/usage"
export const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage"
export const codexCreditsUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
export const codexConsumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"

/** How long a listing of limit resets is reused: clients read it on every refresh, and it changes only when one comes or goes. */
export const creditsFresh: Duration.Duration = Duration.minutes(5)

export const notAnswered =
  "slopmax answers only the usage and reset-credit calls of its accounts; it does not send their tokens elsewhere"

const signedOutText = "the account needs signing in again"

/**
 * A call slopmax answers but cannot serve: the status the call reports and
 * the message its body carries. The hub request itself still succeeds.
 */
export class CallRefused extends Data.TaggedError("CallRefused")<{
  readonly status: number
  readonly message: string
}> {}

const signedOut = () => new CallRefused({ status: 401, message: signedOutText })

/** Why the provider would not list or redeem limit resets, as the call reports it. */
const upstreamRefused = (error: { readonly _tag: string; readonly message: string }) =>
  error._tag === "NotReady" ? signedOut() : new CallRefused({ status: 502, message: error.message })

// --- Pure shapes ----------------------------------------------------------------

/** One subscription account, as CLIProxyAPI lists its auth files. */
export const authFile = (account: Account, health: Health, now: DateTime.Utc): AuthFile => {
  const status = account.authError !== undefined ? "error" : account.disabled ? "disabled" : "active"
  const { email, accountId, plan } = account.identity
  return {
    id: account.id,
    auth_index: account.id,
    name: `${account.id}.json`,
    type: account.provider,
    provider: account.provider,
    label: account.name,
    status,
    disabled: account.disabled,
    unavailable: account.authError !== undefined || isBlocked(health, now),
    priority: account.priority,
    ...(email === undefined ? {} : { email }),
    ...(account.authError === undefined ? {} : { status_message: account.authError }),
    ...(account.provider === "codex"
      ? {
          id_token: {
            ...(accountId === undefined ? {} : { chatgpt_account_id: accountId }),
            ...((plan ?? health.limits.plan) === undefined ? {} : { chatgpt_plan_type: plan ?? health.limits.plan }),
          },
        }
      : {}),
  }
}

const resetText = (window: Window, now: DateTime.Utc): string | null =>
  Option.match(upcomingReset(window, now), { onNone: () => null, onSome: DateTime.formatIso })

/** A reading in the shape of Anthropic's `GET /api/oauth/usage`. A window whose reset passed reads as unused. */
export const claudeUsage = (limits: Limits, now: DateTime.Utc) => {
  const shared = (span: string) => {
    const window = limits.windows.find((w) => w.span === span && w.model === undefined)
    return window === undefined ? null : { utilization: usedAt(window, now), resets_at: resetText(window, now) }
  }
  return {
    five_hour: shared("5h"),
    seven_day: shared("7d"),
    limits: limits.windows.flatMap((window) =>
      window.model === undefined
        ? []
        : [
            {
              kind: "weekly_scoped",
              percent: usedAt(window, now),
              resets_at: resetText(window, now),
              scope: { model: { display_name: window.model } },
            },
          ],
    ),
  }
}

/** How long a window lasts, in seconds, as ChatGPT reports it. */
export const spanSeconds = (span: string): number =>
  span === "5h" ? 5 * 3600 : span === "30d" ? 30 * 86_400 : 7 * 86_400

/** A reading in the shape of ChatGPT's `GET /wham/usage`, the shortest window first. */
export const codexUsage = (plan: string | undefined, limits: Limits, now: DateTime.Utc) => {
  const shared = limits.windows
    .filter((window) => window.model === undefined)
    .toSorted((a, b) => spanSeconds(a.span) - spanSeconds(b.span))
  const shown = (window: Window | undefined) =>
    window === undefined
      ? null
      : {
          used_percent: usedAt(window, now),
          reset_at: Option.match(upcomingReset(window, now), {
            onNone: () => null,
            onSome: (at) => Math.floor(DateTime.toEpochMillis(at) / 1000),
          }),
          limit_window_seconds: spanSeconds(window.span),
        }
  return {
    rate_limit: { primary_window: shown(shared[0]), secondary_window: shown(shared[1]) },
    // Clients reject a null plan, so an unknown one is left out.
    ...(plan === undefined ? {} : { plan_type: plan }),
    ...(limits.resetCredits === undefined
      ? {}
      : { rate_limit_reset_credits: { available_count: limits.resetCredits } }),
  }
}

/** Limit resets in ChatGPT's list shape; one without an expiry is not shown. */
export const creditList = (
  resets: ReadonlyArray<{ readonly id: string; readonly grantedAt?: DateTime.Utc; readonly expiresAt?: DateTime.Utc }>,
) => ({
  credits: resets.flatMap((reset) =>
    reset.expiresAt === undefined
      ? []
      : [
          {
            id: reset.id,
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: DateTime.formatIso(reset.expiresAt),
            ...(reset.grantedAt === undefined ? {} : { granted_at: DateTime.formatIso(reset.grantedAt) }),
          },
        ],
  ),
})

/** An answered call: HTTP 200 always, with the call's status and its JSON body as text. */
export const callAnswer = (status: number, body: unknown): CallAnswer => ({
  status_code: status,
  header: { "Content-Type": ["application/json"] },
  body: JSON.stringify(body),
})

/** The usage reading an account's calls are answered from, or why there is none. */
export const reading = (account: Account, health: Health): Effect.Effect<Limits, CallRefused> =>
  account.authError !== undefined
    ? Effect.fail(signedOut())
    : health.limits.observedAt === undefined
      ? Effect.fail(new CallRefused({ status: 503, message: "slopmax has not read this account's usage yet" }))
      : Effect.succeed(health.limits)

/** What slopmax answers a call with, by its method, address and the account's provider. */
export type Answering = "claudeUsage" | "codexUsage" | "codexCredits" | "codexConsume"

export const answering = (method: string, url: string, provider: ProviderId): Answering | undefined => {
  const verb = method.trim().toUpperCase()
  const address = url.trim()
  if (verb === "GET" && address === claudeUsageUrl && provider === "claude") return "claudeUsage"
  if (provider !== "codex") return undefined
  if (verb === "GET" && address === codexUsageUrl) return "codexUsage"
  if (verb === "GET" && address === codexCreditsUrl) return "codexCredits"
  if (verb === "POST" && address === codexConsumeUrl) return "codexConsume"
  return undefined
}

const decodeConsume = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ credit_id: Schema.String })))

/** The credit a consume call names: `{"credit_id": …}`. */
export const creditIdOf = (data: string): string | undefined =>
  Option.getOrUndefined(Option.map(decodeConsume(data), (body) => body.credit_id))

// --- Handlers -------------------------------------------------------------------

/** The hub, over the same pool and quota as the proxy. */
export const hubHandlers = HttpApiBuilder.group(HubApi, "management", (handlers) =>
  Effect.gen(function* () {
    const pool = yield* Pool
    const accounts = yield* Accounts
    const quota = yield* Quota
    const settings = yield* SettingsService
    // Background polls started by a cooldown reset end with the server.
    const background = yield* FiberSet.make<void>()

    /** The subscription account an `auth_index` names: an account id. */
    const find = (index: string) =>
      Effect.map(accounts.list, (list) =>
        list.find((account) => account.id === index.trim() && isSubscription(account.provider)),
      )

    const healthNow = (id: AccountId) => Effect.map(pool.model, (m) => healthOf(m, id))

    /** The account's unspent limit resets: a recent listing again, else listed now (and kept). */
    const credits = Effect.fnUntraced(function* (account: Account) {
      if (Option.isNone(providerOf(account).resets)) return []
      const health = yield* healthNow(account.id)
      const now = yield* DateTime.now
      // The usage reading counts them, which saves asking when there are none.
      if (health.limits.resetCredits === 0) return []
      const listed = health.resets
      if (listed !== undefined && Duration.isLessThan(DateTime.distance(listed.listedAt, now), creditsFresh)) {
        return unexpiredResets(health, now)
      }
      return yield* quota.listResets(account).pipe(Effect.mapError(upstreamRefused))
    })

    const consume = Effect.fnUntraced(function* (account: Account, data: string) {
      const credit = creditIdOf(data)
      if (credit === undefined) return yield* new CallRefused({ status: 400, message: "no credit_id to redeem" })
      // Redeeming takes the one redemption at a time that every redeemer shares.
      // The redemption logs itself, once, naming the hub client as the one who asked.
      const outcome = yield* quota.redeem(account, credit, "hub").pipe(Effect.mapError(upstreamRefused))
      // ChatGPT's own codes.
      return { code: outcome.replaceAll("-", "_") }
    })

    /** The body a call is answered with, or why it is refused. */
    const answer = Effect.fnUntraced(function* (account: Account, kind: Answering, data: string) {
      const now = yield* DateTime.now
      const health = yield* healthNow(account.id)
      switch (kind) {
        case "claudeUsage":
          return claudeUsage(yield* reading(account, health), now)
        case "codexUsage": {
          const limits = yield* reading(account, health)
          return codexUsage(account.identity.plan ?? limits.plan, limits, now)
        }
        case "codexCredits":
          return creditList(yield* credits(account))
        case "codexConsume":
          return yield* consume(account, data)
      }
    })

    return handlers
      .handle("authFiles", () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const m = yield* pool.model
          const files = (yield* accounts.list)
            .filter((account) => isSubscription(account.provider))
            .map((account) => authFile(account, healthOf(m, account.id), now))
          return { files }
        }),
      )
      .handle("apiCall", ({ payload }) =>
        Effect.gen(function* () {
          const account = yield* find(payload.authIndex)
          if (account === undefined) return yield* new HubBadRequest({ error: "no account has this auth_index" })
          const kind = answering(payload.method, payload.url, account.provider)
          if (kind === undefined) return yield* new HubForbidden({ error: notAnswered })
          return yield* answer(account, kind, payload.data).pipe(
            Effect.map((body) => callAnswer(200, body)),
            Effect.catchTag("CallRefused", (refused) =>
              Effect.succeed(callAnswer(refused.status, { error: { message: refused.message } })),
            ),
          )
        }),
      )
      .handle("resetQuota", ({ payload }) =>
        Effect.gen(function* () {
          const account = yield* find(payload.authIndex)
          if (account === undefined) return yield* new HubNotFound({ error: "no account has this auth_index" })
          const models = yield* pool.modify((m) => clearBlocks(m, account.id))
          // A fresh reading tells what the windows hold now; the answer does not wait for it.
          const { pollMinutes } = yield* settings.get
          if (pollMinutes > 0 && account.authError === undefined) {
            yield* FiberSet.run(background, quota.poll(account))
          }
          return { status: "ok" as const, auth_index: account.id, models }
        }),
      )
  }),
)
