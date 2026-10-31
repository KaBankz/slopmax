// Forwarding with failover.
//
// Routing turns the request's model into steps: providers and the accounts
// that may serve it, in order. Every account gets at most one attempt per
// request (plus one retry after a forced token refresh, and for Codex one
// retry without account-bound state). Failover only happens before any
// response byte reaches the agent; once a stream starts it is passed
// through untouched.
//
// An account whose API speaks the client's format gets the request as the
// client sent it. One that speaks another format gets it translated, and
// its answer is translated back as it streams.
import { Clock, Effect, Result, type Scope, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import { HttpServerResponse } from "effect/http"

import { human, log, SignedDuration, Timestamp } from "@slopmax/common"
import { body as bodies, client as net } from "@slopmax/net"
import { Dialect, ir, json, translate } from "@slopmax/wire"

import type { Account } from "../account.ts"
import { find as findAgent, detect } from "../agent/registry.ts"
import { type Agent, session as sessionOf } from "../agent/mod.ts"
import { ensureFresh } from "../auth/connect.ts"
import { ClientKey } from "../config.ts"
import { chain } from "../error.ts"
import { Limits } from "../limits.ts"
import { AccountState, type Choice, DEFAULT_BLOCK, DEFAULT_THROTTLE, Unavailable } from "../pool.ts"
import { ProviderId, type Verdict } from "../provider/mod.ts"
import { type NoRoute, plan as planRoute, type Step, type Table } from "../route.ts"
import { USER_AGENT } from "../version.ts"
import { affinity, header, insert, returnable } from "./headers.ts"
import { type App, entry, error, jsonReply, outcomeDebug, splitUrl, type Target } from "./app.ts"
import * as rawjson from "./rawjson.ts"
import { dataOf, Tap, tapped } from "./sse.ts"
import { hold } from "./start.ts"
import { events, transcode, type Watch } from "./transcode.ts"

/** Largest request body accepted (images make Messages bodies big). */
const MAX_BODY = 256 * 1024 * 1024
/** How long to sit out an account the provider refused for other reasons. */
const ACCOUNT_BLOCK: SignedDuration = SignedDuration.fromMins(30)
/** How long to wait before trying an account again after a passing server error. */
const TRANSIENT_WAIT = "400 millis"

/**
 * Whether a status says the provider failed this once, so the same
 * request may well succeed on a second try: an internal error, a bad or
 * timed-out gateway, or an overloaded service (Anthropic's 529).
 */
const transient = (status: number): boolean =>
  status === 500 || status === 502 || status === 503 || status === 504 || status === 529

const utf8 = new TextEncoder()
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

type Response = HttpServerResponse.HttpServerResponse
type Body = bodies.Body<bodies.ReadError | bodies.Stalled>

/** The agent's request, buffered so it can be replayed on another account. */
class Inbound {
  /** Whether the body is plain JSON slopmax may inspect and edit. */
  readonly json: boolean
  readonly agent: Agent | undefined
  readonly session: string | undefined
  /** Its own say on session affinity, over the config's. */
  readonly affinity: boolean | undefined
  readonly model: string | undefined
  // The request in common form, decoded the first time a step needs
  // translation.
  private decodedOnce: Result.Result<ir.Request, string> | undefined

  constructor(
    /** When the request's body was in (the clock's milliseconds), for the usage ledger's timings. */
    readonly started: number,
    readonly target: Target,
    readonly method: string,
    readonly headers: Headers,
    readonly body: Uint8Array,
  ) {
    const encoding = header(headers, "content-encoding")
    const encoded = headers.has("content-encoding") && encoding !== "identity"
    this.json = !encoded && rawjson.isValid(body)
    const inspectable = this.json ? body : new Uint8Array(0)
    this.agent = detect(headers)
    this.session = sessionOf(this.agent, headers, inspectable)
    this.affinity = affinity(headers)
    this.model = this.json ? rawjson.findStr(body, ["model"]) : undefined
  }

  decoded(): Result.Result<ir.Request, string> {
    this.decodedOnce ??= Result.mapError(translate.decode(this.target.dialect, this.body), (e) => e.message)
    return this.decodedOnce
  }

  /** Whether the request lists the models, as agents do before work. */
  listsModels(): boolean {
    return this.method === "GET" && splitUrl(this.target.path)[0].endsWith("/models")
  }

  /**
   * Whether the request is an agent's housekeeping, such as listing
   * models or counting tokens, rather than work for a model to do.
   */
  housekeeping(): boolean {
    return this.method !== "POST" || this.target.path.includes("/count_tokens")
  }

  /** Whether a Chat client asked for a usage chunk at the end. */
  wantsUsage(): boolean {
    if (!this.json) return false
    const range = rawjson.find(this.body, ["stream_options", "include_usage"])
    return range !== undefined && lossy.decode(this.body.subarray(range.start, range.end)) === "true"
  }

  /**
   * The body to send for `step`: as the agent sent it, except for asking
   * for the step's model when routing renamed it, and dropping state bound
   * to another account when the session moved.
   */
  bodyFor(step: Step, stripState: boolean): Uint8Array {
    if (!this.json) return this.body
    let body = this.body
    if (this.model !== undefined && this.model !== step.model) {
      const range = rawjson.find(body, ["model"])
      if (range !== undefined) body = rawjson.splice(body, range, JSON.stringify(step.model))
    }
    if (stripState) {
      const rebound = ProviderId.get(step.provider).rebind(body)
      if (rebound !== undefined) body = rebound
    }
    return body
  }

  /** The steps that may serve this request. */
  plan(table: Table): Result.Result<ReadonlyArray<Step>, NoRoute> {
    if (this.model !== undefined && this.target.byModel) {
      return planRoute(table, {
        model: this.model,
        dialect: this.target.dialect,
        agent: this.agent?.id,
        default: this.target.provider,
      })
    }
    // Anything else goes to the API its path belongs to.
    if (this.target.provider !== undefined) return nativeStep(table, this.target.provider, this.model, this.agent)
    return Result.fail({ _tag: "NoModel" })
  }
}

const QUOTE = 0x22
const BACKSLASH = 0x5c

/** How many times the body's top level names a `model`. */
export const modelsNamed = (body: Uint8Array): number => {
  const keys = rawjson.keys(body)
  if (keys === undefined) return 0
  let n = 0
  for (const range of keys) {
    const raw = body.subarray(range.start, range.end)
    // An escaped key names the same thing its text does, as serde reads it.
    const key = raw.includes(BACKSLASH) ? decodeKey(raw) : raw.length === 7 ? lossy.decode(raw.subarray(1, 6)) : ""
    if (key === "model") n++
  }
  return n
}

const decodeKey = (raw: Uint8Array): string | undefined => {
  if (raw[0] !== QUOTE) return undefined
  try {
    const value: unknown = JSON.parse(strict.decode(raw))
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

/** The one step for a request routed by its path. */
const nativeStep = (
  table: Table,
  provider: ProviderId,
  model: string | undefined,
  agent: Agent | undefined,
): Result.Result<ReadonlyArray<Step>, NoRoute> => {
  const only = ProviderId.spec(provider).agentOnly
  if (only !== undefined && agent?.id !== only) {
    return Result.fail({ _tag: "Refused", provider, agent: findAgent(only)?.title ?? only })
  }
  const accounts = table.accounts.filter((a) => a.provider === provider).map((a) => a.id)
  return Result.succeed([{ provider, model: model ?? "", accounts }])
}

/** The reply when routing finds no way to serve a request. */
const refusal = (dialect: Dialect, headers: Headers, no: NoRoute): Response => {
  switch (no._tag) {
    case "Refused": {
      const client = header(headers, "user-agent") ?? "an unidentified client"
      const message = `slopmax serves ${ProviderId.spec(no.provider).title} accounts to ${no.agent} only; this request came from ${client}`
      return error(dialect, 403, message)
    }
    case "NoModel":
      return error(dialect, 400, "the request names no model")
    case "Unserved": {
      const message = `no connected account serves ${JSON.stringify(no.model)} in the ${Dialect.asStr(dialect)} format (\`slopmax status\` lists accounts)`
      return error(dialect, 404, message)
    }
  }
}

/** An upstream error response, read fully so it can be classified. */
interface Failure {
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  /** Whether the account's quota was spent (as opposed to other errors). */
  exhausted: boolean
  /** For a translated request, the client's format to retell it in. */
  client: Dialect | undefined
  /** The provider that answered. */
  readonly provider: ProviderId
}

const readFailure = (response: net.Response, provider: ProviderId): Effect.Effect<Failure> =>
  Effect.map(
    Effect.orElseSucceed(response.bytes(), () => new Uint8Array(0)),
    (body): Failure => ({
      status: response.status,
      headers: response.headers,
      body,
      exhausted: false,
      client: undefined,
      provider,
    }),
  )

const failureResponse = (app: App, failure: Failure): Effect.Effect<Response> => {
  if (failure.client !== undefined) return Effect.succeed(retold(failure.client, failure.status, failure.body))
  const headers = returnable(failure.headers)
  return Effect.map(app.showPool(failure.provider, headers), () =>
    HttpServerResponse.uint8Array(failure.body, { status: failure.status, headers }).pipe(
      withoutDefaultType(failure.headers),
    ),
  )
}

// A body given no content type here goes without one, as the upstream sent it.
const withoutDefaultType =
  (upstream: Headers) =>
  (response: Response): Response =>
    upstream.has("content-type") ? response : HttpServerResponse.removeHeader(response, "content-type")

const POINTERS: ReadonlyArray<ReadonlyArray<string>> = [
  ["error", "message"],
  ["response", "error", "message"],
  ["error"],
  ["detail"],
  ["message"],
]

const pointer = (value: json.Json, path: ReadonlyArray<string>): string | undefined => {
  let at: json.Json | undefined = value
  for (const key of path) at = json.get(at, key)
  return json.str(at)
}

/** The message of an error body: its JSON, or the failure event a stream opened with. */
const messageOf = (body: Uint8Array): string | undefined => {
  const documents: Array<Uint8Array> = [body]
  let start = 0
  for (;;) {
    const newline = body.indexOf(0x0a, start)
    const line = body.subarray(start, newline < 0 ? body.length : newline)
    const data = dataOf(line)
    if (data !== undefined) documents.push(data)
    if (newline < 0) break
    start = newline + 1
  }
  for (const doc of documents) {
    const value = json.parse(json.trimAscii(doc))
    if (value === undefined) continue
    for (const path of POINTERS) {
      const found = pointer(value, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * An upstream error in the client's format, keeping its status and
 * message. Claude Code retries an overloaded API, so server errors reach
 * it as that.
 */
export const retold = (client: Dialect, status: number, body: Uint8Array): Response => {
  const message = messageOf(body) ?? lossy.decode(body.subarray(0, Math.min(body.length, 500)))
  return error(client, client === "messages" && status >= 500 && status < 600 ? 529 : status, message)
}

type Attempt =
  /** A final response for the agent. */
  | { readonly _tag: "Done"; readonly response: Response }
  /** The account failed; try another. */
  | { readonly _tag: "Failed"; readonly failure: Failure | undefined }

const done = (response: Response): Attempt => ({ _tag: "Done", response })
const failed = (failure: Failure | undefined): Attempt => ({ _tag: "Failed", failure })

/** Serves a request; `client` is the client key it came with, if not the owner's. */
export const forward = Effect.fn("forward.forward")(function* (
  app: App,
  target: Target,
  request: HttpServerRequest.HttpServerRequest,
  headers: Headers,
  client: ClientKey | undefined,
): Effect.fn.Return<Response, never, Scope.Scope> {
  const dialect = target.dialect
  // A request without a body has none to read (the web's `Request` has
  // `body === null`, which `request.stream` refuses).
  const source = request.source
  const incoming = source instanceof Request && source.body === null ? Stream.empty : request.stream
  const read = yield* Effect.result(bodies.read(incoming, MAX_BODY))
  if (read._tag === "Failure") {
    const e = read.failure
    if (e._tag === "LengthLimitError") return error(dialect, 413, "request body is too large")
    return error(dialect, 400, `could not read the request body: ${e.message}`)
  }
  // The ledger's timings start once the body is in.
  const inbound = new Inbound(yield* Clock.currentTimeMillis, target, request.method, headers, read.success)
  const held = client !== undefined && client.models.length > 0 ? client : undefined
  if (held !== undefined) {
    const name = JSON.stringify(held.name)
    let refused = ""
    if (inbound.model !== undefined && !ClientKey.allows(held, inbound.model)) {
      refused = `the key ${name} may not use ${inbound.model}`
    } else if (inbound.model !== undefined && modelsNamed(inbound.body) > 1) {
      // A body naming its model twice could mean the other one to the
      // provider.
      refused = `the key ${name} may not send a request that names two models`
    } else if (inbound.model === undefined && !inbound.listsModels()) {
      // Listing models spends nothing, and agents need it; a compressed or
      // unreadable body could name any model.
      refused = `the key ${name} may use only some models, and this request names none slopmax can read`
    }
    if (refused !== "") return error(dialect, 403, refused)
  }
  const config = yield* app.config
  const accounts = yield* app.pool.accounts
  const planned = inbound.plan({
    accounts,
    aliases: config.aliases,
    fallbacks: config.fallbacks,
    paidOverflow: config.paidOverflow,
  })
  if (planned._tag === "Failure") return refusal(dialect, headers, planned.failure)
  let steps = planned.success
  // Aliases and fallbacks may name other models than the one asked for;
  // a key held to some models reaches those alone.
  if (held !== undefined) {
    steps = steps.filter((step) => step.model === "" || ClientKey.allows(held, step.model))
    if (steps.length === 0) {
      return error(
        dialect,
        403,
        `the key ${JSON.stringify(held.name)} may not use the models this request is routed to`,
      )
    }
  }
  const first = steps[0]
  if (first === undefined) return error(dialect, 503, "no account could take the request")
  // Only an API that speaks Messages can count Messages tokens.
  if (inbound.target.path.startsWith("/v1/messages/count_tokens") && !speaks(accounts, first, dialect)) {
    return countTokens(inbound)
  }
  const tried: Array<string> = []
  let last: Failure | undefined
  let unavailable: Unavailable | undefined
  for (const step of steps) {
    let rescued = false
    for (;;) {
      const model = step.model === "" ? undefined : step.model
      const picked = yield* Effect.result(
        app.pool.pick(
          {
            provider: step.provider,
            session: inbound.session,
            affinity: inbound.affinity,
            housekeeping: inbound.housekeeping(),
            model,
            candidates: step.accounts,
            exclude: tried,
          },
          yield* Timestamp.now,
        ),
      )
      if (picked._tag === "Failure") {
        const none = picked.failure
        const spent = none.until !== undefined
        if (spent && (yield* app.config).redeemWhenExhausted && !rescued) {
          rescued = true
          const id = yield* rescue(app, step.provider)
          if (id !== undefined) {
            const at = tried.indexOf(id)
            if (at >= 0) tried.splice(at, 1)
            continue
          }
        }
        unavailable = sooner(unavailable, none)
        break
      }
      const choice = picked.success
      tried.push(choice.account.id)
      const attempted = yield* attempt(app, inbound, step, choice, tried.length)
      if (attempted._tag === "Done") {
        const response = attempted.response
        // An error passed back is no answer: the ledger counts it as a failure.
        if (!net.isSuccess(response.status)) {
          yield* recordFailed(app, inbound, step.provider, tried.at(-1), response.status, tried.length)
        }
        return response
      }
      last = attempted.failure ?? last
    }
  }
  const provider = last?.provider ?? first.provider
  const response = yield* giveUp(app, dialect, first.provider, unavailable, last)
  yield* recordFailed(app, inbound, provider, tried.at(-1), response.status, tried.length)
  return response
})

/**
 * Records a request that ended without an answer, with the last account
 * tried (if any was), so the ledger counts failures beside answers.
 */
const recordFailed = (
  app: App,
  inbound: Inbound,
  provider: ProviderId,
  account: string | undefined,
  status: number,
  attempts: number,
): Effect.Effect<void> =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    app.record(
      entry({
        at: now,
        account: account ?? "",
        provider,
        model: inbound.model,
        status,
        ms: now - inbound.started,
        firstByteMs: undefined,
        attempts,
        agent: inbound.agent?.id,
        session: inbound.session,
      }),
    ),
  )

/** Combines why two steps could not serve: the earliest return wins. */
export const sooner = (earlier: Unavailable | undefined, next: Unavailable): Unavailable => {
  if (earlier === undefined) return next
  const until =
    earlier.until !== undefined && next.until !== undefined
      ? Math.min(earlier.until, next.until)
      : (earlier.until ?? next.until)
  return new Unavailable({ until, reason: earlier.reason })
}

const attempt = Effect.fn("forward.attempt")(function* (
  app: App,
  inbound: Inbound,
  step: Step,
  choice: Choice,
  attempts: number,
): Effect.fn.Return<Attempt, never, Scope.Scope> {
  const id = choice.account.id
  const moved = choice.movedFrom !== undefined
  if (choice.movedFrom !== undefined) log.info(`${id}: takes over a session from ${choice.movedFrom}`)
  const ready = yield* app.ready(choice.account)
  if (ready === undefined) return failed(undefined)
  let account: Account = ready
  const provider = ProviderId.get(step.provider)
  const dialect = inbound.target.dialect
  const model = step.model === "" ? undefined : step.model
  // The format to translate into, when the account's API speaks another.
  const lane = laneOf(provider.dialects(account), dialect)
  // Keys cannot be refreshed; a rejected one is simply set aside.
  const refreshable = account.tokens.refreshToken !== undefined || account.link !== undefined
  let stripped = moved
  let refreshed = false
  let retried = false
  for (;;) {
    const built = outbound(app, inbound, step, account, lane, stripped, moved, yield* Clock.currentTimeMillis)
    if (built._tag === "Failure") return done(error(dialect, 400, built.failure))
    const sent = yield* Effect.result(
      app.http
        .request(inbound.method, built.success.url)
        .headers(built.success.headers)
        .body(built.success.body)
        .send(),
    )
    if (sent._tag === "Failure") {
      log.warn(`${id}: upstream unreachable: ${sent.failure.message}`)
      yield* app.pool.recordError(id, `network error: ${sent.failure.message}`)
      return failed(undefined)
    }
    const response = sent.success
    const now = yield* Timestamp.now
    const limits = provider.limits(response.headers, now)
    if (limits !== undefined) yield* app.pool.observe(id, limits, now)
    // The format of the upstream's answer.
    const wire = lane ?? dialect
    if (net.isSuccess(response.status)) {
      const status = response.status
      const headers = response.headers
      let body: Body = response.intoBody()
      if (Dialect.holdsStart(wire)) {
        const start = yield* hold(body, wire)
        if (start._tag === "Refused") {
          if (start.exhausted) {
            yield* app.pool.block(id, Timestamp.add(now, DEFAULT_BLOCK), undefined, "usage limit reached")
            log.info(`${id}: limited inside the stream; switching accounts`)
          } else {
            yield* app.pool.throttle(id, Timestamp.add(now, DEFAULT_THROTTLE))
          }
          return failed({
            status,
            headers,
            body: start.held,
            exhausted: start.exhausted,
            client: lane === undefined ? undefined : dialect,
            provider: step.provider,
          })
        }
        body = start.body
      }
      yield* app.pool.recordSuccess(id, now)
      const path = splitUrl(inbound.target.path)[0]
      log.info(
        `${id} ${inbound.method} ${path} ${model ?? "-"} → ${status}${lane === undefined ? "" : ` (as ${Dialect.asStr(lane)})`}`,
      )
      const served: Served = {
        id,
        provider: step.provider,
        model: model ?? inbound.model,
        status,
        started: inbound.started,
        attempts,
        agent: inbound.agent?.id,
        session: inbound.session,
      }
      const answer =
        lane === undefined
          ? yield* streamBack(app, wire, served, headers, body)
          : yield* translateBack(app, inbound, served, lane, headers, body)
      return done(answer)
    }

    const failure = yield* readFailure(response, step.provider)
    failure.client = lane === undefined ? undefined : dialect
    log.info(`${id}: upstream returned ${failure.status}`)
    const verdict: Verdict = provider.verdict(failure.status, failure.headers, failure.body, model, now)
    switch (verdict._tag) {
      case "Unauthorized":
        if (!refreshed && refreshable && (yield* app.config).refreshTokens) {
          refreshed = true
          const fresh = yield* Effect.result(ensureFresh(app.authHttp, app.store, account, true))
          if (fresh._tag === "Success") {
            account = fresh.success
            continue
          }
          yield* app.pool.recordError(id, fresh.failure.message)
          return failed(failure)
        }
        yield* app.pool.block(id, Timestamp.add(now, ACCOUNT_BLOCK), undefined, "unauthorized")
        return failed(failure)
      case "Forbidden":
        yield* app.pool.block(id, Timestamp.add(now, ACCOUNT_BLOCK), undefined, "forbidden")
        return failed(failure)
      case "StaleState":
        if (!stripped) {
          stripped = true
          continue
        }
        return done(yield* failureResponse(app, failure))
      case "Exhausted": {
        failure.exhausted = true
        const until = verdict.until ?? Timestamp.add(now, DEFAULT_BLOCK)
        yield* app.pool.block(id, until, verdict.model, "usage limit reached")
        log.info(`${id}: limited until ${Timestamp.display(until)}; switching accounts`)
        return failed(failure)
      }
      case "Throttled":
        yield* app.pool.throttle(id, verdict.until ?? Timestamp.add(now, DEFAULT_THROTTLE))
        return failed(failure)
      case "Final":
        // Tried once more on the same account, which keeps the session's
        // cache, then on the next account. The account is not set aside: an
        // outage of the whole provider would otherwise turn into slopmax
        // refusing every request.
        if (transient(failure.status) && !retried) {
          retried = true
          log.info(`${id}: retrying after a passing server error`)
          yield* Effect.sleep(TRANSIENT_WAIT)
          continue
        }
        if (transient(failure.status)) {
          log.info(`${id}: answered ${failure.status} twice; trying another account`)
          yield* app.pool.recordError(id, `server error ${failure.status}`)
          return failed(failure)
        }
        return done(yield* failureResponse(app, failure))
    }
  }
})

/**
 * The format to translate a `client` request into for an API speaking
 * `speaks`, or undefined to send it as is.
 */
const laneOf = (speaks: ReadonlyArray<Dialect>, client: Dialect): translate.Target | undefined => {
  if (speaks.includes(client) || speaks.length === 0) return undefined
  return speaks.find((d): d is translate.Target => translate.canTranslate(client, d))
}

/** A request ready to go upstream. */
interface Outbound {
  readonly url: string
  readonly headers: Headers
  readonly body: Uint8Array
}

/**
 * The request for `account`: the client's own, or translated into `lane`.
 * `stripped` drops state bound to another account.
 */
const outbound = (
  app: App,
  inbound: Inbound,
  step: Step,
  account: Account,
  lane: translate.Target | undefined,
  stripped: boolean,
  moved: boolean,
  now: number,
): Result.Result<Outbound, string> => {
  const provider = ProviderId.get(step.provider)
  const base = trimSlashes(provider.api(account))
  if (lane === undefined) {
    return Result.succeed({
      url: `${base}${inbound.target.path}`,
      headers: provider.headers(inbound.headers, account, moved),
      body: inbound.bodyFor(step, stripped),
    })
  }
  const decoded = inbound.decoded()
  if (decoded._tag === "Failure") return Result.fail(decoded.failure)
  let request: ir.Request = ir.Request.make({
    ...decoded.success,
    model: step.model,
    cacheKey: decoded.success.cacheKey ?? inbound.session,
  })
  if (lane === "responses" && !stripped) {
    request = restoreReasoning(request, (call) => app.replay.recall(call, account.id, now))
  }
  const body = translate.encode(lane, request)
  provider.shape(lane, body)
  // A translated request carries no client headers: they describe the
  // client's format, not this one. slopmax names itself instead.
  const own = new Headers()
  insert(own, "content-type", "application/json")
  insert(own, "accept", "text/event-stream")
  insert(own, "user-agent", USER_AGENT)
  return Result.succeed({
    url: `${base}${translate.path(lane)}`,
    headers: provider.headers(own, account, moved),
    body: utf8.encode(json.stringify(body)),
  })
}

const trimSlashes = (url: string): string => {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--
  return url.slice(0, end)
}

/**
 * Puts reasoning state the upstream issued on an earlier turn back before
 * the calls it led to, when `recall` still has it.
 */
export const restoreReasoning = (request: ir.Request, recall: (call: string) => string | undefined): ir.Request => {
  let changed = false
  const messages = request.messages.map((message): ir.Message => {
    const at = message.parts.findIndex((p) => p._tag === "Call")
    const call = message.parts[at]
    if (call === undefined || call._tag !== "Call") return message
    const state = recall(call.call.id)
    if (state === undefined) return message
    changed = true
    const parts = [...message.parts]
    parts.splice(at, 0, ir.Part.Reasoning({ text: "", opaque: state }))
    return { ...message, parts }
  })
  return changed ? { ...request, messages } : request
}

/** Whether one of the step's accounts takes `dialect` as is. */
const speaks = (accounts: ReadonlyArray<Account>, step: Step, dialect: Dialect): boolean => {
  const provider = ProviderId.get(step.provider)
  return accounts.some((a) => step.accounts.includes(a.id) && provider.dialects(a).includes(dialect))
}

/**
 * Counts tokens for a model Anthropic does not serve: an estimate, since
 * only the model's own API could say exactly.
 */
const countTokens = (inbound: Inbound): Response => jsonReply(200, { input_tokens: Math.ceil(inbound.body.length / 4) })

/**
 * Redeems a banked reset credit on a spent account of `provider`, if it
 * grants them. Returns the account that can serve again, if any.
 */
const rescue = Effect.fn("forward.rescue")(function* (
  app: App,
  provider: ProviderId,
): Effect.fn.Return<string | undefined> {
  const credits = ProviderId.get(provider).credits()
  if (credits === undefined) return undefined
  const agent = yield* app.pool.agent(provider)
  if (credits.needsAgent && agent === undefined) return undefined
  return yield* app.redeeming.withPermit(
    Effect.gen(function* () {
      const now = yield* Timestamp.now
      const inner = yield* app.pool.get
      const state = (id: string): AccountState => inner.states.get(id) ?? AccountState.empty()
      const accounts = inner.accounts.filter((a) => a.provider === provider && !a.disabled && a.authError === undefined)
      // Another request may have redeemed while this one waited for the lock.
      const free = accounts.find((a) => !AccountState.isBlocked(state(a.id), now))
      if (free !== undefined) return free.id
      const spent: Array<readonly [Account, Timestamp]> = []
      for (const a of accounts) {
        const s = state(a.id)
        const exhausted = Limits.exhaustedUntil(s.limits, now)
        const until =
          s.blockedUntil === undefined
            ? exhausted
            : exhausted === undefined
              ? s.blockedUntil
              : Math.max(s.blockedUntil, exhausted)
        if (until !== undefined && AccountState.creditsLeft(s, now) > 0) spent.push([a, until])
      }
      // Free the account that would otherwise stay blocked the longest.
      spent.sort((x, y) => y[1] - x[1])
      for (const [picked] of spent) {
        const account = yield* app.ready(picked)
        if (account === undefined) continue
        // The soonest to expire, if the list is known; else the provider
        // chooses, as listing now would hold up the request.
        const credit = AccountState.unexpiredCredits(yield* app.pool.state(account.id), now)[0]?.id
        const redeemed = yield* Effect.result(credits.redeem(app.authHttp, account, agent, credit))
        if (redeemed._tag === "Failure") {
          log.warn(`${account.id}: redeeming a limit reset: ${chain(redeemed.failure)}`)
          continue
        }
        if (redeemed.success === "reset") {
          log.info(`${account.id}: redeemed a limit reset`)
          yield* app.pool.recordReset(account.id, yield* Timestamp.now, credit)
          return account.id
        }
        log.info(`${account.id}: limit reset not used (${outcomeDebug(redeemed.success)})`)
      }
      return undefined
    }),
  )
})

/** A response being streamed back, for the usage ledger. */
interface Served {
  readonly id: string
  readonly provider: ProviderId
  readonly model: string | undefined
  readonly status: number
  /** When the request arrived, in the clock's milliseconds. */
  readonly started: number
  readonly attempts: number
  readonly agent: string | undefined
  readonly session: string | undefined
}

/** Streams a successful response to the agent as it came. */
const streamBack = Effect.fn("forward.streamBack")(function* (
  app: App,
  wire: Dialect,
  served: Served,
  headers: Headers,
  body: Body,
): Effect.fn.Return<Response, never, Scope.Scope> {
  const returned = returnable(headers)
  yield* app.showPool(served.provider, returned)
  const tappedBody = yield* recorded(app, wire, served, headers, body)
  return HttpServerResponse.stream(tappedBody, { status: served.status, headers: returned }).pipe(
    withoutDefaultType(headers),
  )
})

/**
 * Tells a translated answer to the agent in its own format: streamed, or
 * collected into one reply when it did not ask for a stream.
 */
const translateBack = Effect.fn("forward.translateBack")(function* (
  app: App,
  inbound: Inbound,
  served: Served,
  upstream: Dialect,
  headers: Headers,
  body: Body,
): Effect.fn.Return<Response, never, Scope.Scope> {
  const client = inbound.target.dialect
  const decoded = inbound.decoded()
  // Translated requests were decoded first.
  if (decoded._tag === "Failure") return error(client, 400, decoded.failure)
  const request = decoded.success
  // Answer under the name the client asked for.
  const model = inbound.model ?? request.model
  const isJson = header(headers, "content-type")?.includes("json") === true
  const clock = yield* Clock.Clock
  const watch = remembering(app, served.id, upstream, () => clock.currentTimeMillisUnsafe())
  const tappedBody = yield* recorded(app, upstream, served, headers, body)
  const decoder = translate.Decoder.make(upstream, request)
  const now = yield* Timestamp.now
  if (request.stream) {
    const encoder = translate.Encoder.forRequest(client, request, model, inbound.wantsUsage(), now)
    return HttpServerResponse.stream(transcode(tappedBody, isJson, decoder, encoder, watch), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }
  const bytes = yield* Effect.result(bodies.readAll(tappedBody, MAX_BODY))
  if (bytes._tag === "Failure") {
    return error(client, 502, `reading the upstream answer failed: ${bytes.failure.message}`)
  }
  const answer = ir.Answer.collect(events(decoder, isJson, bytes.success, watch))
  const failure = answer.error
  if (failure !== undefined && answer.text === "" && answer.calls.length === 0) {
    const status = failure.status >= 100 && failure.status <= 999 ? failure.status : 502
    return error(client, status, failure.message)
  }
  return jsonReply(200, translate.whole(client, request, answer, model, now))
})

/**
 * Watches a translated answer for reasoning state, to restore it before
 * the calls it led to on the next turn.
 */
const remembering = (app: App, account: string, upstream: Dialect, now: () => number): Watch => {
  if (upstream !== "responses") return () => {}
  let pending: string | undefined
  return (event) => {
    if (event._tag === "State") {
      pending = event.state
    } else if (event._tag === "Call" && pending !== undefined) {
      app.replay.remember(event.call.id, account, pending, now())
      pending = undefined
    }
  }
}

/**
 * The upstream body, recording token usage (and any quota refusal inside
 * the stream) when it ends. `wire` is the format it is in.
 */
const recorded = (
  app: App,
  wire: Dialect,
  served: Served,
  headers: Headers,
  body: Body,
): Effect.Effect<Body, never, Scope.Scope> =>
  tapped(body, Tap.forResponse(wire, headers), (outcome, firstByte) =>
    Effect.gen(function* () {
      const id = served.id
      yield* app.pool.addUsage(id, outcome.usage)
      const now = yield* Timestamp.now
      if (outcome.exhausted) {
        yield* app.pool.block(id, Timestamp.add(now, DEFAULT_BLOCK), undefined, "usage limit reached mid-stream")
      }
      const usage = outcome.usage
      app.record(
        entry({
          at: now,
          account: id,
          provider: served.provider,
          model: served.model,
          status: served.status,
          usage: {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheReadTokens,
            cacheWrite: usage.cacheWriteTokens,
          },
          ms: now - served.started,
          firstByteMs: firstByte === undefined ? undefined : firstByte - served.started,
          attempts: served.attempts,
          agent: served.agent,
          session: served.session,
        }),
      )
    }),
  )

/** The response when no account can take the request. */
const giveUp = (
  app: App,
  dialect: Dialect,
  provider: ProviderId,
  unavailable: Unavailable | undefined,
  last: Failure | undefined,
): Effect.Effect<Response> => {
  const until = unavailable?.until
  // Every account is spent: report the earliest reset, in the shape the
  // agent shows as its own usage-limit message.
  if (last !== undefined && until !== undefined && last.exhausted) return limitReached(dialect, provider, until)
  if (last !== undefined) return failureResponse(app, last)
  if (until !== undefined) return limitReached(dialect, provider, until)
  return Effect.succeed(error(dialect, 503, unavailable?.reason ?? "no account could take the request"))
}

const limitReached = (dialect: Dialect, provider: ProviderId, until: Timestamp): Effect.Effect<Response> =>
  Effect.map(Timestamp.now, (now) => {
    const left = Timestamp.durationSince(until, now)
    const message = `slopmax: every ${ProviderId.spec(provider).title} account is rate limited; the next one frees up in ${human.duration(left)} (\`slopmax status\` for details)`
    const [body, extra] = Dialect.limitReached(dialect, message, until, now)
    const headers = new Headers({ "content-type": "application/json" })
    headers.set("retry-after", String(Math.max(SignedDuration.asSecs(left), 1)))
    for (const [name, value] of extra) insert(headers, name, value)
    return HttpServerResponse.uint8Array(utf8.encode(json.stringify(body)), { status: 429, headers })
  })
