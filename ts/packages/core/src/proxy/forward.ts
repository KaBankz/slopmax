// The proxy: a request from its key to its answer, failing over between
// accounts until one serves it.
//
// Routing turns the request into steps (providers, the model to ask each
// for, and the accounts that may serve it), in order. Within a step the
// pool picks an account; each account gets one try per request. A refusal
// that is the account's (spent, throttled, signed out, a passing outage)
// moves on to the next; one that is the request's goes back to the client.
// Failover happens only before the first byte of an answer: once an answer
// streams, whatever happens reaches the client inside it.
//
// When no account can serve, the client hears why in its own format: that
// every account is spent until a time (in the shape it shows as its own
// usage limit), the last refusal, or that nothing could take the request.
import {
  type AccountId,
  agentFacts,
  type ClientKey,
  type Dialect,
  LedgerRecord,
  type ProviderId,
  providerFacts,
  type Settings,
  Usage,
} from "@slopmax/domain"
import { duration } from "@slopmax/domain/format"
import { limitReached, retell } from "@slopmax/wire"
import { Clock, Context, DateTime, Effect, Layer, Option, Result } from "effect"
import type { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import { Ledger } from "../ledger.ts"
import { pick, Pool, routingOf, sawAgent, sawCodex } from "../pool.ts"
import { claudeCodeAgent } from "../providers/claude.ts"
import { clientVersion } from "../providers/codex.ts"
import { providers } from "../providers/registry.ts"
import { Quota } from "../quota.ts"
import type { Plan, Step } from "../router.ts"
import { SettingsService } from "../settings.ts"
import { Upstream } from "../upstream.ts"
import { type Failure, makeAttempt, shownHeaders, Translation } from "./attempt.ts"
import { authenticate, heldKey, keyRing } from "./auth.ts"
import type { Route } from "./classify.ts"
import { estimated, speaks } from "./count-tokens.ts"
import { type Inbound, inspect, keyRefusal, readBody, stepsFor } from "./inbound.ts"
import { LiveStreams } from "./live.ts"
import { Catalog } from "./models.ts"
import { Planner } from "./planner.ts"
import { error, fromReply, noKey } from "./replies.ts"
import { recordRequest, Replay, Settler } from "./settle.ts"

/** Why a step's pool could not serve: the reason, and when some account is expected back. */
export interface Unavailable {
  readonly reason: string
  readonly until: DateTime.Utc | undefined
}

/** Why the steps could not serve, combined: the earliest return wins, and the first reason is kept. */
export const sooner = (earlier: Unavailable | undefined, next: Unavailable): Unavailable => {
  if (earlier === undefined) return next
  const until =
    earlier.until === undefined
      ? next.until
      : next.until === undefined
        ? earlier.until
        : DateTime.min(earlier.until, next.until)
  return { reason: earlier.reason, until }
}

/** The answer when routing finds no way to serve a request. */
export const noRoute = (plan: Exclude<Plan, { readonly _tag: "Steps" }>, inbound: Inbound): Response => {
  const dialect = inbound.route.dialect
  switch (plan._tag) {
    case "Refused": {
      const from = inbound.headers.get("user-agent") ?? "an unidentified client"
      return error(
        dialect,
        403,
        `slopmax serves ${providerFacts[plan.provider].title} accounts to ${agentFacts[plan.agent].title} only; this request came from ${from}`,
      )
    }
    case "NoModel":
      return error(dialect, 400, "the request names no model")
    case "Unserved":
      return error(
        dialect,
        404,
        `no connected account serves ${JSON.stringify(plan.model)} in the ${dialect} format (\`slopmax status\` lists accounts)`,
      )
  }
}

/** The answer when every account of `provider` is spent until `until`, in the shape the client shows as its own limit. */
export const limitReply = (
  dialect: Dialect,
  provider: ProviderId,
  until: DateTime.Utc,
  now: DateTime.Utc,
): Response => {
  const message = `slopmax: every ${providerFacts[provider].title} account is rate limited; the next one frees up in ${duration(DateTime.distance(now, until))} (\`slopmax status\` for details)`
  return fromReply(limitReached(dialect, message, until, now))
}

export interface Shape {
  /** Answers an inference request on `route`. Never fails: every outcome is a reply. */
  readonly handle: (request: Request, route: Route) => Effect.Effect<Response>
  /** Answers `GET /v1/models` for an OpenAI-style client. */
  readonly models: (request: Request) => Effect.Effect<Response>
  /**
   * Notes what an authenticated agent shows of itself (Codex's release,
   * Claude Code's user agent), for requests that do not go through
   * `handle`, such as a Codex WebSocket.
   */
  readonly noteAgents: (headers: Headers) => Effect.Effect<void>
}

const make = Effect.gen(function* () {
  const settings = yield* SettingsService
  const accounts = yield* Accounts
  const pool = yield* Pool
  const quota = yield* Quota
  const ledger = yield* Ledger
  const planner = yield* Planner
  const catalog = yield* Catalog
  const attempt = yield* makeAttempt

  /** Notes what the agents show of themselves: Codex's release, for model lists, and Claude Code's user agent, for limit resets. */
  const noteAgents = (headers: Headers): Effect.Effect<void> => {
    const version = clientVersion(headers)
    const claudeCode = claudeCodeAgent(headers)
    if (version === undefined && claudeCode === undefined) return Effect.void
    // Agents send the same release on every request: only a new one changes the pool.
    return Effect.flatMap(pool.model, (seen) =>
      (version === undefined || seen.codex.version === version) &&
      (claudeCode === undefined || seen.agents.claude === claudeCode)
        ? Effect.void
        : pool.update((m) => {
            const codex = version === undefined ? m : sawCodex(m, { version })
            return claudeCode === undefined ? codex : sawAgent(codex, "claude", claudeCode)
          }),
    )
  }

  /** Records a request that ended without an answer, so the ledger counts failures beside answers. */
  const recordFailure = (
    inbound: Inbound,
    provider: ProviderId,
    account: AccountId | undefined,
    status: number,
    attempts: number,
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      recordRequest(
        pool,
        ledger,
        LedgerRecord.cases.Request.make({
          at: DateTime.makeUnsafe(now),
          ...(account === undefined ? {} : { account }),
          provider,
          ...(inbound.model === undefined ? {} : { model: inbound.model }),
          status,
          usage: Usage.zero,
          ms: Math.max(0, Math.round(now - inbound.startedAt)),
          attempts,
          ...(inbound.agent === undefined ? {} : { agent: inbound.agent.id }),
          ...(inbound.session === undefined ? {} : { session: inbound.session }),
          via: "http",
        }),
      ),
    )

  /** Whether one of the step's accounts takes `dialect` untranslated. */
  const countsExactly = Effect.fnUntraced(function* (step: Step, dialect: Dialect) {
    for (const id of step.accounts) {
      const account = yield* accounts.get(id)
      if (Option.isSome(account) && speaks(account.value, dialect)) return true
    }
    return false
  })

  /** A provider's refusal for the client: as it came, or retold in the client's format when translated. */
  const passBack = Effect.fnUntraced(function* (failure: Failure, inbound: Inbound) {
    if (failure.lane._tag === "Translate") return fromReply(retell(inbound.route.dialect, failure.status, failure.body))
    const shown = shownHeaders(providers[failure.provider], failure.headers, yield* pool.pooled(failure.provider))
    return new Response(failure.body.length === 0 ? null : failure.body, { status: failure.status, headers: shown })
  })

  const forward = Effect.fnUntraced(function* (
    inbound: Inbound,
    steps: ReadonlyArray<Step>,
    first: Step,
    values: Settings,
  ) {
    const routing = routingOf(values, inbound.affinity)
    const translation = new Translation(inbound)
    const tried = new Set<AccountId>()
    let lastTried: AccountId | undefined
    let last: Failure | undefined
    let unavailable: Unavailable | undefined
    for (const step of steps) {
      let rescued = false
      for (;;) {
        const picked = yield* pool.modify((m, now) =>
          pick(
            m,
            {
              ...routing,
              provider: step.provider,
              candidates: step.accounts,
              model: step.model === "" ? undefined : step.model,
              session: inbound.session,
              housekeeping: inbound.route.housekeeping,
              exclude: tried,
            },
            now,
          ),
        )
        if (picked._tag === "NoneReady") {
          if (!rescued && picked.spent && values.redeemWhenExhausted) {
            rescued = true
            const freed = yield* quota.rescue(step.provider)
            if (Option.isSome(freed)) {
              tried.delete(freed.value)
              continue
            }
          }
          unavailable = sooner(unavailable, { reason: picked.reason, until: picked.until })
          break
        }
        const account: Account = picked.account
        tried.add(account.id)
        lastTried = account.id
        const result = yield* attempt(account, picked.movedFrom, step, translation, tried.size)
        switch (result._tag) {
          case "Served":
            return result.response
          case "Reply":
            yield* recordFailure(inbound, step.provider, account.id, result.response.status, tried.size)
            return result.response
          case "Answer": {
            const answer = yield* passBack(result.failure, inbound)
            yield* recordFailure(inbound, step.provider, account.id, answer.status, tried.size)
            return answer
          }
          case "Skip":
            continue
          case "Next":
            last = result.failure ?? last
            continue
        }
      }
    }
    const now = yield* DateTime.now
    const until = unavailable?.until
    const answer =
      last !== undefined && until !== undefined && last.exhausted
        ? limitReply(inbound.route.dialect, first.provider, until, now)
        : last !== undefined
          ? yield* passBack(last, inbound)
          : until !== undefined
            ? limitReply(inbound.route.dialect, first.provider, until, now)
            : error(inbound.route.dialect, 503, unavailable?.reason ?? "no account could take the request")
    yield* recordFailure(inbound, last?.provider ?? first.provider, lastTried, answer.status, tried.size)
    return answer
  })

  // The steps every request takes are untraced functions: a traced one captures a stack and opens a
  // span on each call even with tracing off. With SLOPMAX_TRACE=1 the front door gives each request a span.
  const handle = Effect.fnUntraced(function* (request: Request, route: Route) {
    const dialect = route.dialect
    const values = yield* settings.get
    const caller = authenticate(request.headers, keyRing(values))
    if (caller === undefined) return noKey(dialect)
    yield* noteAgents(request.headers)
    const body = yield* Effect.result(readBody(request))
    if (Result.isFailure(body)) {
      return error(dialect, body.failure._tag === "BodyTooLarge" ? 413 : 400, body.failure.message)
    }
    const inbound = inspect(route, request.headers, body.success, caller, yield* Clock.currentTimeMillis)
    const refused = keyRefusal(inbound)
    if (refused !== undefined) return error(dialect, 403, refused)
    const plan = yield* planner.plan(inbound)
    if (plan._tag !== "Steps") return noRoute(plan, inbound)
    const allowed = stepsFor(heldKey(caller), plan.steps)
    if ("refused" in allowed) return error(dialect, 403, allowed.refused)
    const [first] = allowed.steps
    if (first === undefined) return error(dialect, 503, "no account could take the request")
    // Only a Messages API can count Messages tokens; anywhere else gets an estimate.
    if (route.countTokens && !(yield* countsExactly(first, dialect))) return estimated(inbound.body)
    return yield* forward(inbound, allowed.steps, first, values)
  })

  const models = Effect.fn("Proxy.models")(function* (request: Request) {
    const caller = authenticate(request.headers, keyRing(yield* settings.get))
    if (caller === undefined) return noKey("chat")
    const key: ClientKey | undefined = caller._tag === "Client" ? caller.key : undefined
    return yield* catalog.list(key)
  })

  return { handle, models, noteAgents } satisfies Shape
})

/** The HTTP proxy. */
export class Proxy extends Context.Service<Proxy, Shape>()("@slopmax/core/Proxy", { make }) {
  /** The proxy over the shared settler, live streams and reasoning replay. */
  static readonly layer: Layer.Layer<
    Proxy,
    never,
    SettingsService | Accounts | Pool | Quota | Ledger | Upstream | Settler | LiveStreams | Replay
  > = Layer.effect(Proxy, Proxy.make).pipe(Layer.provide(Layer.merge(Planner.layer, Catalog.layer)))

  /** The proxy with its settler, live streams and replay, which the socket relay and the server share. */
  static readonly layerWithParts: Layer.Layer<
    Proxy | Settler | LiveStreams | Replay,
    never,
    SettingsService | Accounts | Pool | Quota | Ledger | Upstream
  > = Proxy.layer.pipe(
    Layer.provideMerge(Settler.layer),
    Layer.provideMerge(Layer.merge(Replay.layer, LiveStreams.layer)),
  )
}
