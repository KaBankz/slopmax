// CLIProxyAPI's management API, as far as tools that show a hub's quotas
// use it. T3 Code's usage-limit sources are one: given a hub's URL and
// management key, they list its accounts, read each account's usage and
// reset credits, and redeem credits.
//
// CLIProxyAPI serves those reads through `api-call`, which sends any
// request to any address with an account's token filled in. slopmax keeps
// the request and reply shapes but not the relay: its `api-call` answers
// the usage and reset-credit calls those tools make, usage from the
// readings slopmax already keeps, and refuses everything else.
import { Buffer } from "node:buffer"

import { Effect, Result } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"

import { log, SignedDuration, text, Timestamp } from "@slopmax/common"
import { body as bodies } from "@slopmax/net"
import { json } from "@slopmax/wire"

import { Account } from "../account.ts"
import type { Config } from "../config.ts"
import { chain } from "../error.ts"
import { type Limits, Window } from "../limits.ts"
import { pollOne } from "../polls.ts"
import { AccountState, Inner } from "../pool.ts"
import type { Credit } from "../provider/credits.ts"
import { ProviderId, Spec } from "../provider/mod.ts"
import { type App, authorized, bodyOf, constantTimeEq, headersOf, jsonReply, splitUrl } from "./app.ts"
import { header } from "./headers.ts"
import * as rawjson from "./rawjson.ts"

const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage"
const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage"
const CODEX_CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
const CODEX_CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
/**
 * How long a credit list is reused. Tools read it on every refresh, and it
 * changes only when a credit is granted or spent.
 */
const CREDITS_FRESH = SignedDuration.fromMins(5)

type Response = HttpServerResponse.HttpServerResponse
type Request = HttpServerRequest.HttpServerRequest

/** A provider's error: the status `api-call` relays, and its message. */
interface Refusal {
  readonly status: number
  readonly message: string
}

/** A provider's status and body, as `api-call` relays them. */
type Answer = Result.Result<json.Json, Refusal>

const refuse = (status: number, message: string): Answer => Result.fail({ status, message })

const utf8 = new TextEncoder()

/** Answers a request under `/v0/management/`. */
export const handle = Effect.fn("hub.handle")(function* (app: App, request: Request): Effect.fn.Return<Response> {
  const config = yield* app.config
  const headers = headersOf(request)
  if (!authorized(config, headers) && !hasManagementKey(config, headers)) {
    return fail(401, "missing or invalid management key; use slopmax's api_key")
  }
  let path = splitUrl(request.url)[0]
  // `trim_start_matches`: the prefix, as often as it repeats.
  while (path.startsWith("/v0/management/")) path = path.slice("/v0/management/".length)
  switch (`${request.method} ${path}`) {
    case "GET auth-files":
      return yield* authFiles(app)
    case "POST api-call": {
      const call = Result.flatMap(yield* readBody(request), decodeCall)
      if (Result.isFailure(call)) return fail(400, "invalid body")
      return yield* apiCall(app, call.success)
    }
    case "POST reset-quota": {
      const index = Result.flatMap(yield* readBody(request), decodeIndex)
      if (Result.isFailure(index)) return fail(400, "auth_index is required")
      return yield* resetQuota(app, index.success)
    }
    default:
      return fail(404, "slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API")
  }
})

/** CLIProxyAPI also takes its key in `x-management-key`. */
const hasManagementKey = (config: Config, headers: Headers): boolean => {
  const key = header(headers, "x-management-key")
  return key !== undefined && constantTimeEq(Buffer.from(text.trim(key), "utf8"), config.apiKey)
}

/** The body, read up to 64 KiB. */
const readBody = (request: Request): Effect.Effect<Result.Result<Uint8Array, void>> =>
  Effect.map(
    Effect.result(bodies.read(bodyOf(request), 64 * 1024)),
    Result.mapError(() => undefined),
  )

/** An error in CLIProxyAPI's shape. */
const fail = (status: number, message: string): Response => jsonReply(status, { error: message })

/**
 * The fields of a struct serde reads from the JSON in `bytes`: an object
 * (unknown keys ignored, a field given twice, under one name or two,
 * refused) or an array of them in order. Each is a string; `required` ones
 * must be there.
 */
const strings = (
  bytes: Uint8Array,
  fields: ReadonlyArray<{ readonly names: ReadonlyArray<string>; readonly required: boolean }>,
): Result.Result<ReadonlyArray<string>, void> => {
  const read = json.read(bytes)
  if (Result.isFailure(read)) return Result.failVoid
  const value = read.success
  const found: Array<string> = []
  if (Array.isArray(value)) {
    if (value.length > fields.length) return Result.failVoid
    for (const [i, f] of fields.entries()) {
      const item = value[i]
      if (item === undefined) {
        if (f.required) return Result.failVoid
        found.push("")
      } else if (typeof item === "string") found.push(item)
      else return Result.failVoid
    }
    return Result.succeed(found)
  }
  if (!json.isObject(value)) return Result.failVoid
  // JSON.parse keeps a repeated key's last value, so the keys are counted
  // in the text.
  const named = topKeys(bytes)
  for (const f of fields) {
    if (named.filter((key) => f.names.includes(key)).length > 1) return Result.failVoid
    const name = f.names.find((key) => Object.hasOwn(value, key))
    const item = name === undefined ? undefined : value[name]
    if (item === undefined) {
      if (f.required) return Result.failVoid
      found.push("")
    } else if (typeof item === "string") found.push(item)
    else return Result.failVoid
  }
  return Result.succeed(found)
}

/** The keys of the object `bytes` holds, decoded, repeats included. */
const topKeys = (bytes: Uint8Array): Array<string> => {
  const keys: Array<string> = []
  for (const range of rawjson.keys(bytes) ?? []) {
    const key = json.parse(bytes.subarray(range.start, range.end))
    if (typeof key === "string") keys.push(key)
  }
  return keys
}

const AUTH_INDEX = ["auth_index", "authIndex", "AuthIndex"]

/**
 * An `api-call` request. The headers it asks for are ignored: slopmax
 * answers from its own state and sends with its own credentials.
 */
interface Call {
  readonly authIndex: string
  readonly method: string
  readonly url: string
  readonly data: string
}

const decodeCall = (bytes: Uint8Array): Result.Result<Call, void> =>
  Result.map(
    strings(bytes, [
      { names: AUTH_INDEX, required: false },
      { names: ["method"], required: false },
      { names: ["url"], required: false },
      { names: ["data"], required: false },
    ]),
    ([authIndex = "", method = "", url = "", data = ""]) => ({ authIndex, method, url, data }),
  )

const decodeIndex = (bytes: Uint8Array): Result.Result<string, void> =>
  Result.map(strings(bytes, [{ names: AUTH_INDEX, required: true }]), ([index = ""]) => index)

/** The subscription account an `auth_index` names: slopmax's account id. */
const find = (app: App, index: string): Effect.Effect<Account | undefined> =>
  Effect.map(app.pool.accounts, (accounts) => {
    const id = text.trim(index)
    return accounts.find((a) => a.id === id && Spec.isSubscription(ProviderId.spec(a.provider)))
  })

/** The subscription accounts, listed as CLIProxyAPI lists its auth files. */
const authFiles = Effect.fn("hub.authFiles")(function* (app: App) {
  const now = yield* Timestamp.now
  const inner = yield* app.pool.get
  const files: Array<json.Json> = []
  for (const account of inner.accounts) {
    if (!Spec.isSubscription(ProviderId.spec(account.provider))) continue
    const status = account.authError !== undefined ? "error" : account.disabled ? "disabled" : "active"
    const state = Inner.state(inner, account.id)
    const file: json.JsonObject = {
      id: account.id,
      auth_index: account.id,
      name: `${account.id}.json`,
      type: account.provider,
      provider: account.provider,
      label: Account.name(account),
      status,
      disabled: account.disabled,
      unavailable: account.authError !== undefined || AccountState.isBlocked(state, now),
      priority: account.priority,
    }
    // Clients read these as strings when present, so absent values are
    // left out rather than sent as null.
    if (account.email !== undefined) file["email"] = account.email
    if (account.authError !== undefined) file["status_message"] = account.authError
    if (account.provider === "codex") {
      const token: json.JsonObject = {}
      if (account.accountId !== undefined) token["chatgpt_account_id"] = account.accountId
      if (account.plan !== undefined) token["chatgpt_plan_type"] = account.plan
      file["id_token"] = token
    }
    files.push(file)
  }
  return jsonReply(200, { files })
})

const apiCall = Effect.fn("hub.apiCall")(function* (app: App, call: Call) {
  const account = yield* find(app, call.authIndex)
  if (account === undefined) return fail(400, "no account has this auth_index")
  const now = yield* Timestamp.now
  const method = asciiUppercase(text.trim(call.method))
  const url = text.trim(call.url)
  let answer: Answer
  if (method === "GET" && url === CLAUDE_USAGE && account.provider === "claude") {
    answer = Result.map(yield* reading(app, account), (limits) => claudeUsage(limits, now))
  } else if (method === "GET" && url === CODEX_USAGE && account.provider === "codex") {
    answer = Result.map(yield* reading(app, account), (limits) => codexUsage(account, limits, now))
  } else if (method === "GET" && url === CODEX_CREDITS && account.provider === "codex") {
    answer = yield* creditList(app, account)
  } else if (method === "POST" && url === CODEX_CONSUME && account.provider === "codex") {
    answer = yield* consume(app, account, call.data)
  } else {
    return fail(
      403,
      "slopmax answers only the usage and reset-credit calls of its accounts; " +
        "it does not send their tokens elsewhere",
    )
  }
  const [status, body]: readonly [number, json.Json] = Result.isSuccess(answer)
    ? [200, answer.success]
    : [answer.failure.status, { error: { message: answer.failure.message } }]
  return jsonReply(200, {
    status_code: status,
    header: { "Content-Type": ["application/json"] },
    body: json.stringify(body),
  })
})

/** `str::to_ascii_uppercase`. */
const asciiUppercase = (s: string): string => s.replace(/[a-z]+/g, (m) => m.toUpperCase())

const signedOut = (): Result.Result<never, Refusal> =>
  Result.fail({ status: 401, message: "the account needs signing in again" })

/**
 * The account's usage windows as slopmax last read them, from its usage
 * polls and the headers of every response.
 */
const reading = (app: App, account: Account): Effect.Effect<Result.Result<Limits, Refusal>> =>
  Effect.map(app.pool.state(account.id), (state) => {
    if (account.authError !== undefined) return signedOut()
    if (state.limits.observedAt === undefined) {
      return Result.fail({ status: 503, message: "slopmax has not read this account's usage yet" })
    }
    return Result.succeed(state.limits)
  })

/** @internal A reading in the shape of Anthropic's `GET /api/oauth/usage`; exported for tests. */
export const claudeUsage = (limits: Limits, now: Timestamp): json.JsonObject => {
  const shared = (span: string): json.Json => {
    const w = limits.windows.find((x) => x.span === span && x.model === undefined)
    return w === undefined ? null : { utilization: json.f64Value(Window.usedAt(w, now)), resets_at: reset(w, now) }
  }
  const scoped: Array<json.Json> = []
  for (const w of limits.windows) {
    if (w.model === undefined) continue
    scoped.push({
      kind: "weekly_scoped",
      percent: json.f64Value(Window.usedAt(w, now)),
      resets_at: reset(w, now),
      scope: { model: { display_name: w.model } },
    })
  }
  return { five_hour: shared("5h"), seven_day: shared("7d"), limits: scoped }
}

const reset = (window: Window, now: Timestamp): string | null => {
  const at = Window.upcomingReset(window, now)
  return at === undefined ? null : Timestamp.display(at)
}

/**
 * @internal A reading in the shape of ChatGPT's `GET /wham/usage`, the
 * shortest window first; exported for tests.
 */
export const codexUsage = (account: Account, limits: Limits, now: Timestamp): json.JsonObject => {
  // A stable sort, as `sort_by_key`.
  const shared = limits.windows
    .filter((w) => w.model === undefined)
    .toSorted((a, b) => spanSeconds(a.span) - spanSeconds(b.span))
  const window = (w: Window | undefined): json.Json => {
    if (w === undefined) return null
    const at = Window.upcomingReset(w, now)
    return {
      used_percent: json.f64Value(Window.usedAt(w, now)),
      reset_at: at === undefined ? null : Timestamp.asSecond(at),
      limit_window_seconds: spanSeconds(w.span),
    }
  }
  const usage: json.JsonObject = {
    rate_limit: { primary_window: window(shared[0]), secondary_window: window(shared[1]) },
  }
  if (account.plan !== undefined) usage["plan_type"] = account.plan
  if (limits.resetCredits !== undefined) usage["rate_limit_reset_credits"] = { available_count: limits.resetCredits }
  return usage
}

const spanSeconds = (span: string): number => {
  switch (span) {
    case "5h":
      return 5 * 3600
    case "30d":
      return 30 * 86_400
    default:
      return 7 * 86_400
  }
}

/** The account's unspent reset credits, in ChatGPT's list shape. */
const creditList = Effect.fn("hub.creditList")(function* (app: App, account: Account): Effect.fn.Return<Answer> {
  const listed = yield* credits(app, account)
  if (Result.isFailure(listed)) return Result.fail(listed.failure)
  const out: Array<json.Json> = []
  for (const c of listed.success) {
    if (c.expiresAt === undefined) continue
    const credit: json.JsonObject = {
      id: c.id,
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: Timestamp.display(c.expiresAt),
    }
    if (c.grantedAt !== undefined) credit["granted_at"] = Timestamp.display(c.grantedAt)
    out.push(credit)
  }
  return Result.succeed({ credits: out })
})

const credits = Effect.fn("hub.credits")(function* (
  app: App,
  account: Account,
): Effect.fn.Return<Result.Result<ReadonlyArray<Credit>, Refusal>> {
  const lister = ProviderId.get(account.provider).credits()
  if (lister === undefined) return Result.succeed([])
  const now = yield* Timestamp.now
  const state = yield* app.pool.state(account.id)
  // The usage reading counts them, which saves asking when there are none.
  if (state.limits.resetCredits === 0) return Result.succeed([])
  if (state.credits !== undefined && Timestamp.durationSince(now, state.credits.listedAt) < CREDITS_FRESH) {
    return Result.succeed(AccountState.unexpiredCredits(state, now))
  }
  const ready = yield* app.ready(account)
  if (ready === undefined) return signedOut()
  const agent = yield* app.pool.agent(account.provider)
  const listed = yield* Effect.result(lister.list(app.authHttp, ready, agent))
  if (Result.isFailure(listed)) return Result.fail({ status: 502, message: chain(listed.failure) })
  yield* app.pool.recordCredits(account.id, listed.success, now)
  return Result.succeed(listed.success)
})

/**
 * Redeems the credit `data` names (`{"credit_id": …}`), answering in
 * ChatGPT's shape.
 */
const consume = Effect.fn("hub.consume")(function* (app: App, account: Account, data: string) {
  const creditId = Result.getOrUndefined(
    Result.map(strings(utf8.encode(data), [{ names: ["credit_id"], required: true }]), ([id]) => id),
  )
  if (creditId === undefined) return refuse(400, "no credit_id to redeem")
  const lister = ProviderId.get(account.provider).credits()
  if (lister === undefined) return refuse(400, "this account has no limit resets")
  return yield* app.redeeming.withPermit(
    Effect.gen(function* () {
      const ready = yield* app.ready(account)
      if (ready === undefined) return signedOut()
      const agent = yield* app.pool.agent(account.provider)
      const redeemed = yield* Effect.result(lister.redeem(app.authHttp, ready, agent, creditId))
      if (Result.isFailure(redeemed)) return refuse(502, chain(redeemed.failure))
      const outcome = redeemed.success
      if (outcome === "reset") {
        log.info(`${account.id}: redeemed a limit reset for a hub client`)
        yield* app.pool.recordReset(account.id, yield* Timestamp.now, creditId)
      }
      return Result.succeed<json.Json>({ code: outcome })
    }),
  )
})

/**
 * Lifts slopmax's blocks on the account, as CLIProxyAPI clears its
 * cooldown, and reads its usage again to learn what the windows hold now.
 */
const resetQuota = Effect.fn("hub.resetQuota")(function* (app: App, index: string) {
  const account = yield* find(app, index)
  if (account === undefined) return fail(404, "no account has this auth_index")
  const models = yield* app.pool.clearBlocks(account.id)
  if ((yield* app.config).pollMins > 0 && account.authError === undefined) {
    yield* Effect.forkIn(pollOne(app, account), app.scope)
  }
  return jsonReply(200, { status: "ok", auth_index: account.id, models: [...models] })
})
