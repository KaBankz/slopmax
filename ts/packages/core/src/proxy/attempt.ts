// One account's try at a request.
//
// The account's credential is made ready (refreshed when due), the request
// is built for it (the client's own bytes when its API speaks the client's
// format, else translated), and sent. A success streams back through a
// relay. A refusal is read whole and judged by the provider: a rejected
// token is refreshed and the account tried once more, state another account
// minted is dropped and tried once more, a passing server error is retried
// once after 400 ms, a spent or throttled account sits out, and anything
// else is the request's own problem, which goes back to the client.
//
// An attempt never fails: every outcome is a value the failover loop acts on.
import { type AccountId, type Dialect, type PoolWindow, type ProviderId, slopmaxVersion } from "@slopmax/domain"
import {
  canTranslate,
  collect,
  common,
  decodeRequest,
  encodeRequest,
  holdsStart,
  isDocument,
  Opening,
  pairStates,
  paths,
  readAnswer,
  ReportingTap,
  restoreReasoning,
  scan,
  Tap,
  transcoder as transcoderFor,
  type UpstreamDialect,
  wholeReply,
} from "@slopmax/wire"
import { Clock, Data, DateTime, Duration, Effect, Option, Result } from "effect"
import type { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import {
  block,
  defaultBlock,
  defaultThrottle,
  failed,
  observe,
  Pool,
  type PoolModel,
  serving,
  throttle,
} from "../pool.ts"
import type { Provider } from "../providers/provider.ts"
import { providers } from "../providers/registry.ts"
import type { Step } from "../router.ts"
import { SettingsService } from "../settings.ts"
import { Upstream, type UpstreamRequest } from "../upstream.ts"
import { Held, holdStart, type Reader } from "./hold.ts"
import { type Inbound, maxBody } from "./inbound.ts"
import { LiveStreams, stallAfter, stallMessage } from "./live.ts"
import { relay } from "./relay.ts"
import { error, json } from "./replies.ts"
import { Replay, Settlement, Settler } from "./settle.ts"

/** How a request reaches an account: as the client sent it, or translated into the account's format. */
export type Lane = Data.TaggedEnum<{
  Native: {}
  Translate: { readonly from: Dialect; readonly to: UpstreamDialect }
}>
export const Lane = Data.taggedEnum<Lane>()

const native: Lane = Lane.Native()

/**
 * The lane for an account whose API speaks `speaks`: as sent when it speaks
 * the client's format (or says nothing), else the first format the client's
 * translates into; as sent when there is none.
 */
export const laneOf = (speaks: ReadonlyArray<Dialect>, client: Dialect): Lane => {
  if (speaks.length === 0 || speaks.includes(client)) return native
  for (const dialect of speaks) if (canTranslate(client, dialect)) return Lane.Translate({ from: client, to: dialect })
  return native
}

/** An upstream answer that was not a success, read whole. */
export interface Failure {
  readonly provider: ProviderId
  readonly account: AccountId
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly lane: Lane
  /** The account's quota was spent: when every account is, the client hears the limit, not this refusal. */
  readonly exhausted: boolean
}

/** What one account's try came to. */
export type Attempt = Data.TaggedEnum<{
  /** The answer streams to the client from here: failover is over. */
  Served: { readonly response: Response }
  /** The account could not serve; its health is already recorded. Try the next. */
  Next: { readonly failure: Failure | undefined }
  /** The request's own problem: pass the provider's answer back. */
  Answer: { readonly failure: Failure }
  /** slopmax's own answer, such as a request it cannot translate. */
  Reply: { readonly response: Response }
  /** The account is not ready (signed out, its refresh failed): skipped with nothing recorded against the request. */
  Skip: {}
}>
export const Attempt = Data.taggedEnum<Attempt>()

const skip: Attempt = Attempt.Skip()

/** How long an account sits out after its token or its access was refused. */
export const refusedBlock: Duration.Duration = Duration.minutes(30)

/** How long to wait before trying an account again after a passing server error. */
export const transientWait: Duration.Duration = Duration.millis(400)

/** The most of a refusal's body read: enough for any error, never streamed to the client. */
export const maxRefusal = 64 * 1024 * 1024

/** Statuses that say the provider failed this once: the same request may well succeed on a second try. */
export const isTransient = (status: number): boolean =>
  status === 500 || status === 502 || status === 503 || status === 504 || status === 529

/** Headers a client never gets from a provider: hop-by-hop ones, `content-length` (the body is relayed) and cookies. */
const notReturned = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "set-cookie",
]

/**
 * The provider's answer headers a client gets. Copying them whole and
 * dropping the few that never pass is several times cheaper than rebuilding
 * them one by one, and it runs on every answer.
 */
export const returnable = (upstream: Headers): Headers => {
  const out = new Headers(upstream)
  for (const name of notReturned) out.delete(name)
  return out
}

/**
 * The headers a client gets for a provider's answer, with the pool's
 * windows shown in place of the account's when the pool reads as one. The
 * provider's rewrite already makes a copy, so the headers that never pass
 * are dropped from that copy rather than copying twice.
 */
export const shownHeaders = (provider: Provider, upstream: Headers, pooled: ReadonlyArray<PoolWindow>): Headers => {
  if (pooled.length === 0) return returnable(upstream)
  const out = provider.showPool(upstream, pooled)
  if (out === upstream) return returnable(upstream)
  for (const name of notReturned) out.delete(name)
  return out
}

/** Stops an upstream body nobody will read; one already handed to a reader is that reader's to stop. */
const cancelUnread = (response: Response): Effect.Effect<void> =>
  Effect.sync(() => {
    const body = response.body
    if (body !== null && !body.locked) body.cancel().catch(() => undefined)
  })

const noBytes = new Uint8Array(0)

/** The request decoded into the common form, the first time a step needs it translated. */
export class Translation {
  private decoded: Result.Result<common.Request, common.RequestInvalid> | undefined

  constructor(readonly inbound: Inbound) {}

  request(): Result.Result<common.Request, common.RequestInvalid> {
    this.decoded ??= decodeRequest(this.inbound.route.dialect, this.inbound.body)
    return this.decoded
  }
}

const trimSlashes = (url: string): string => {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--
  return url.slice(0, end)
}

/** Bytes `fetch` can send: the same bytes, when they already sit in a plain buffer. */
const sendable = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice()

/**
 * The client's body for `step`: byte for byte as sent, except the model
 * when routing renamed it, and without state bound to another account when
 * `stripped`.
 */
export const nativeBody = (
  inbound: Inbound,
  step: Step,
  provider: Provider,
  stripped: boolean,
): Uint8Array<ArrayBuffer> => {
  if (!inbound.json) return inbound.body
  let body: Uint8Array = inbound.body
  if (step.model !== "" && inbound.model !== undefined && inbound.model !== step.model) {
    const range = scan.find(body, "model")
    if (range !== undefined) body = scan.splice(body, range, JSON.stringify(step.model))
  }
  if (stripped) {
    const rebound = provider.rebind(body)
    if (rebound._tag === "Some") body = rebound.value
  }
  return sendable(body)
}

const bodiless = (method: string) => method === "GET" || method === "HEAD"

/** Lets a step inside an uninterruptible region be interrupted again. */
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const utf8 = new TextEncoder()

/** Builds the function that runs one account's try, over the proxy's services. */
export const makeAttempt = Effect.gen(function* () {
  const settings = yield* SettingsService
  const accounts = yield* Accounts
  const upstream = yield* Upstream
  const pool = yield* Pool
  const settler = yield* Settler
  const live = yield* LiveStreams
  const replay = yield* Replay
  const clock = yield* Clock.Clock
  const now = () => clock.currentTimeMillisUnsafe()

  /** The request as the account's API is to get it, or why it cannot be translated. */
  const build = Effect.fnUntraced(function* (
    translation: Translation,
    step: Step,
    account: Account,
    lane: Lane,
    stripped: boolean,
    moved: boolean,
  ) {
    const inbound = translation.inbound
    const provider = providers[step.provider]
    const base = trimSlashes(provider.apiOf(account))
    const m = yield* pool.model
    const context = { account, moved, agents: m.agents, codex: m.codex }
    if (lane._tag === "Native") {
      const method = inbound.route.method
      const request: UpstreamRequest = {
        url: `${base}${inbound.route.path}`,
        method,
        headers: provider.headers({ client: inbound.headers, ...context }),
        body: bodiless(method) ? undefined : nativeBody(inbound, step, provider, stripped),
      }
      return Result.succeed(request)
    }
    const decoded = translation.request()
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
    const asked = decoded.success
    let request: common.Request = {
      ...asked,
      model: step.model === "" ? asked.model : step.model,
      cacheKey: asked.cacheKey ?? inbound.session,
    }
    if (lane.to === "responses" && !stripped) {
      const book = yield* replay.book
      const at = DateTime.makeUnsafe(now())
      request = restoreReasoning(request, (callId) => book.recall(callId, account.id, at))
    }
    // A translated request carries none of the client's headers: they describe its format, not this one.
    const own = new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": `slopmax/${slopmaxVersion}`,
    })
    const built: UpstreamRequest = {
      url: `${base}${paths[lane.to]}`,
      method: "POST",
      headers: provider.headers({ client: own, ...context }),
      body: utf8.encode(JSON.stringify(provider.shape(encodeRequest(lane.to, request)))),
    }
    return Result.succeed(built)
  })

  /** What a served answer settles as, once its relay ends. */
  const reportingTap = (
    inbound: Inbound,
    step: Step,
    account: AccountId,
    status: number,
    attempts: number,
    tap: Tap,
  ): ReportingTap =>
    new ReportingTap(tap, now, (report) =>
      settler.offer(
        Settlement.Served({
          account,
          provider: step.provider,
          model: step.model === "" ? inbound.model : step.model,
          status,
          report,
          startedAt: inbound.startedAt,
          endedAt: now(),
          attempts,
          agent: inbound.agent?.id,
          session: inbound.session,
          via: "http",
        }),
      ),
    )

  /** The success streamed back as it came, with the pool's windows in place of the account's. */
  const serveNative = Effect.fnUntraced(function* (
    response: Response,
    started: Held | undefined,
    tap: ReportingTap,
    provider: Provider,
  ) {
    const shown = shownHeaders(provider, response.headers, yield* pool.pooled(provider.id))
    const body = relayOf(response, started, tap, undefined)
    return new Response(body, { status: response.status, headers: shown })
  })

  const relayOf = (
    response: Response,
    started: Held | undefined,
    tap: ReportingTap,
    retell: ReturnType<typeof transcoderFor> | undefined,
  ): ReadableStream<Uint8Array> | null => {
    if (started?._tag === "Streaming") {
      return relay(
        { reader: started.reader, held: started.held, pending: started.pending, tap, transcoder: retell, clock },
        live,
      )
    }
    if (response.body === null) {
      tap.end("ended")
      return null
    }
    const reader: Reader = response.body.getReader()
    return relay({ reader, held: [], pending: undefined, tap, transcoder: retell, clock }, live)
  }

  /** A translated success, told in the client's format: streamed, or as one answer when it asked for one. */
  const serveTranslated = Effect.fnUntraced(function* (
    translation: Translation,
    lane: Data.TaggedEnum.Value<Lane, "Translate">,
    account: AccountId,
    response: Response,
    started: Held | undefined,
    tap: ReportingTap,
    restore: Restore,
  ) {
    const inbound = translation.inbound
    const client = inbound.route.dialect
    const decoded = translation.request()
    // Translated requests were decoded to be built.
    if (Result.isFailure(decoded)) return error(client, 400, decoded.failure.message)
    const request = decoded.success
    const context: common.ReplyContext = {
      model: inbound.model ?? request.model,
      now: DateTime.makeUnsafe(now()),
      token: common.randomToken,
    }
    const watch =
      lane.to === "responses"
        ? pairStates((callId, state) => settler.offer(Settlement.Remember({ callId, account, state, at: now() })))
        : undefined
    const document = isDocument(response.headers)
    const options = { request, context, document, ...(watch === undefined ? {} : { watch }) }
    if (request.stream) {
      const body = relayOf(response, started, tap, transcoderFor(lane.to, client, options))
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    // The relay still runs (it taps the answer and settles it); here it is read whole rather than by the client.
    const stream = relayOf(response, started, tap, undefined)
    const read = yield* Effect.result(restore(upstream.readAll(new Response(stream), maxBody)))
    if (Result.isFailure(read)) return error(client, 502, `reading the upstream answer failed: ${read.failure.message}`)
    const events = readAnswer(lane.to, read.success, { ...options, token: common.randomToken })
    const reply = wholeReply(client, request, collect(events), context)
    // A response can carry only a status from 200 to 599; anything else the provider meant is a bad gateway.
    return json(reply.status >= 200 && reply.status <= 599 ? reply.status : 502, reply.body)
  })

  /**
   * A refusal's body, read whole. A provider that sends the headers and then
   * goes quiet is given the same 600 s as a stalled stream; the refusal is
   * then judged by its status alone, as is one whose body cannot be read.
   */
  const readRefusal = (id: AccountId, response: Response): Effect.Effect<Uint8Array> =>
    upstream.readAll(response, maxRefusal).pipe(
      Effect.timeoutOrElse({
        duration: stallAfter,
        orElse: () => Effect.as(Effect.logWarning(`${id}: the refusal's body stalled (${stallMessage})`), noBytes),
      }),
      Effect.orElseSucceed(() => noBytes),
    )

  /**
   * One account's try. It runs uninterruptibly, and only its waits (the
   * credential, the provider, the held start, a refusal's body, the retry's
   * pause) let a client that hung up interrupt it. So once an upstream body
   * is in hand it is always either handed to a relay or cancelled; it is
   * never left open with nobody reading it.
   */
  const tryAccount = Effect.fnUntraced(function* (
    restore: Restore,
    picked: Account,
    movedFrom: AccountId | undefined,
    step: Step,
    translation: Translation,
    attempts: number,
  ) {
    const inbound = translation.inbound
    const id = picked.id
    const moved = movedFrom !== undefined
    if (moved) yield* Effect.logInfo(`${id}: takes over a session from ${movedFrom}`)
    const readied = yield* Effect.result(restore(accounts.ready(picked)))
    if (Result.isFailure(readied)) {
      yield* Effect.logWarning(`${id}: ${readied.failure.message}`)
      yield* pool.update((m) => failed(m, id, readied.failure.message))
      return skip
    }
    let account = readied.success
    const provider = providers[step.provider]
    const client = inbound.route.dialect
    const lane = laneOf(provider.dialectsOf(account), client)
    const wire: Dialect = lane._tag === "Translate" ? lane.to : client
    const model = step.model === "" ? undefined : step.model
    const credential = account.credential
    // Keys cannot be refreshed; a rejected one is simply set aside.
    const refreshable =
      credential._tag === "OAuth" && (credential.tokens.refresh !== undefined || credential.follows !== undefined)
    let stripped = moved
    let refreshed = false
    let retried = false
    for (;;) {
      const built = yield* build(translation, step, account, lane, stripped, moved)
      if (Result.isFailure(built)) return Attempt.Reply({ response: error(client, 400, built.failure.message) })
      const sent = yield* Effect.result(restore(upstream.send(built.success)))
      if (Result.isFailure(sent)) {
        const why = sent.failure.message
        yield* Effect.logWarning(`${id}: upstream unreachable: ${why}`)
        yield* pool.update((m) => failed(m, id, `network error: ${why}`))
        return Attempt.Next({ failure: undefined })
      }
      const response = sent.success
      const at = DateTime.makeUnsafe(now())
      // Every answer's rate-limit headers are the account's latest reading, success or not. On a
      // success the reading is applied together with what the answer turns out to be, in one change.
      const limits = provider.limitsFrom(response.headers, at)
      const observed = (m: PoolModel, time: DateTime.Utc): PoolModel =>
        limits._tag === "Some" ? observe(m, id, limits.value, time) : m

      if (response.status >= 200 && response.status < 300) {
        let started: Held | undefined
        if (holdsStart(wire) && response.body !== null) {
          started = yield* restore(holdStart(response.body, new Opening(wire))).pipe(
            Effect.onInterrupt(() => cancelUnread(response)),
          )
          if (started._tag === "Refused") {
            const { exhausted, bytes } = started
            if (exhausted) {
              yield* pool.update((m, time) =>
                block(
                  observed(m, time),
                  id,
                  DateTime.addDuration(time, defaultBlock),
                  undefined,
                  "usage limit reached",
                ),
              )
              yield* Effect.logInfo(`${id}: limited inside the stream; switching accounts`)
            } else {
              yield* pool.update((m, time) =>
                throttle(observed(m, time), id, DateTime.addDuration(time, defaultThrottle)),
              )
            }
            const failure: Failure = {
              provider: step.provider,
              account: id,
              status: response.status,
              headers: response.headers,
              body: bytes,
              lane,
              exhausted,
            }
            return Attempt.Next({ failure })
          }
        }
        const path = inbound.route.path.split("?")[0] ?? ""
        const as = lane._tag === "Translate" ? ` (as ${lane.to})` : ""
        const tap = reportingTap(inbound, step, id, response.status, attempts, Tap.forResponse(wire, response.headers))
        // From here the upstream body belongs to the relay: a client gone meanwhile is seen by the
        // relay (Bun cancels the response), not by interrupting the steps that build it.
        yield* pool.update((m, time) => serving(m, id, Option.getOrUndefined(limits), time))
        yield* Effect.logInfo(`${id} ${inbound.route.method} ${path} ${model ?? "-"} → ${response.status}${as}`)
        const served =
          lane._tag === "Translate"
            ? yield* serveTranslated(translation, lane, id, response, started, tap, restore)
            : yield* serveNative(response, started, tap, provider)
        return Attempt.Served({ response: served })
      }

      if (limits._tag === "Some") yield* pool.update(observed)
      const body = yield* restore(readRefusal(id, response)).pipe(Effect.onInterrupt(() => cancelUnread(response)))
      yield* Effect.logInfo(`${id}: upstream returned ${response.status}`)
      const failure: Failure = {
        provider: step.provider,
        account: id,
        status: response.status,
        headers: response.headers,
        body,
        lane,
        exhausted: false,
      }
      const verdict = provider.verdict({ status: response.status, headers: response.headers, body, model, now: at })
      switch (verdict._tag) {
        case "Unauthorized": {
          if (!refreshed && refreshable && (yield* settings.get).refreshTokens) {
            refreshed = true
            const fresh = yield* Effect.result(restore(accounts.ready(account, { force: true })))
            if (Result.isSuccess(fresh)) {
              account = fresh.success
              continue
            }
            yield* pool.update((m) => failed(m, id, fresh.failure.message))
            return Attempt.Next({ failure })
          }
          yield* pool.update((m, time) =>
            block(m, id, DateTime.addDuration(time, refusedBlock), undefined, "unauthorized"),
          )
          return Attempt.Next({ failure })
        }
        case "Forbidden":
          yield* pool.update((m, time) =>
            block(m, id, DateTime.addDuration(time, refusedBlock), undefined, "forbidden"),
          )
          return Attempt.Next({ failure })
        case "StaleState":
          if (!stripped) {
            stripped = true
            continue
          }
          return Attempt.Answer({ failure })
        case "Exhausted": {
          const until = verdict.until ?? DateTime.addDuration(at, defaultBlock)
          yield* pool.update((m) => block(m, id, until, verdict.model, "usage limit reached"))
          yield* Effect.logInfo(`${id}: limited until ${DateTime.formatIso(until)}; switching accounts`)
          return Attempt.Next({ failure: { ...failure, exhausted: true } })
        }
        case "Throttled": {
          const until = verdict.until ?? DateTime.addDuration(at, defaultThrottle)
          yield* pool.update((m) => throttle(m, id, until))
          return Attempt.Next({ failure })
        }
        case "Final": {
          if (!isTransient(response.status)) return Attempt.Answer({ failure })
          if (!retried) {
            // Once more on the same account, which keeps the session's cache. The account is
            // never set aside for this: an outage of the whole provider would otherwise turn
            // into slopmax refusing every request.
            retried = true
            yield* Effect.logInfo(`${id}: retrying after a passing server error`)
            yield* restore(Effect.sleep(transientWait))
            continue
          }
          yield* Effect.logInfo(`${id}: answered ${response.status} twice; trying another account`)
          yield* pool.update((m) => failed(m, id, `server error ${response.status}`))
          return Attempt.Next({ failure })
        }
      }
    }
  })

  return (
    picked: Account,
    movedFrom: AccountId | undefined,
    step: Step,
    translation: Translation,
    attempts: number,
  ): Effect.Effect<Attempt> =>
    Effect.uninterruptibleMask((restore) => tryAccount(restore, picked, movedFrom, step, translation, attempts))
})
