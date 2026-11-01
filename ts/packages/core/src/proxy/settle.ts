// What happens once an answer is over: its tokens are added to the account,
// a spent quota found inside the stream sits the account out, and the
// ledger records the request.
//
// A relayed answer ends inside a native stream callback, where no Effect
// can run. So each end is pushed onto one queue (`Queue.offerUnsafe`, which
// never blocks), and one fiber, for the life of the proxy, applies them in
// order. A stream's end costs one push: no fiber per stream, and nothing
// run synchronously that could go async. Reasoning state seen inside a
// translated answer is kept the same way.
import { type AccountId, LedgerRecord, type ProviderId, type RequestRecord, type RequestSender } from "@slopmax/domain"
import { ReplayBook, type TapReport } from "@slopmax/wire"
import { Cause, Context, Data, DateTime, Deferred, Duration, Effect, Layer, Queue, Ref } from "effect"
import { causeText } from "../home.ts"
import { Ledger } from "../ledger.ts"
import { addUsage, block, defaultBlock, Pool, type PoolModel, sawCodex } from "../pool.ts"

/** Something to apply once an answer, or part of one, has passed. */
export type Settlement = Data.TaggedEnum<{
  /** A relayed answer ended: it ran out, broke off, the client hung up, or it stalled. */
  Served: {
    readonly account: AccountId
    readonly provider: ProviderId
    /** The model asked of the provider, else the one the client named. */
    readonly model: string | undefined
    readonly status: number
    readonly report: TapReport
    /** When the request's body was in, and when the answer ended (clock milliseconds). */
    readonly startedAt: number
    readonly endedAt: number
    readonly attempts: number
    readonly agent: RequestSender | undefined
    readonly session: string | undefined
    readonly via: "http" | "socket"
  }
  /** A Responses upstream handed back reasoning state with a tool call: keep it for the next turn. */
  Remember: { readonly callId: string; readonly account: AccountId; readonly state: string; readonly at: number }
  /** A change to the pool seen outside an Effect (the socket relay's frames). */
  Pool: { readonly change: (m: PoolModel, now: DateTime.Utc) => PoolModel }
}>
export const Settlement = Data.taggedEnum<Settlement>()

/** An answer that ended. */
export type Served = Data.TaggedEnum.Value<Settlement, "Served">

type Queued = Settlement | { readonly _tag: "Flush"; readonly done: Deferred.Deferred<void> }

/** Why a stream that said its quota ran out partway has its account sit out. */
export const spentMidStream = "usage limit reached mid-stream"

// ---------------------------------------------------------------------------
// Reasoning replay

export interface ReplayShape {
  /** The book as it is now, to restore state from for one request. */
  readonly book: Effect.Effect<ReplayBook>
  readonly remember: (callId: string, account: AccountId, state: string, at: DateTime.Utc) => Effect.Effect<void>
}

/** Reasoning state a Responses upstream issued, kept per call and account for the next turn. */
export class Replay extends Context.Service<Replay, ReplayShape>()("@slopmax/core/proxy/Replay", {
  make: Effect.map(Ref.make(ReplayBook.empty), (ref) => ({
    book: Ref.get(ref),
    remember: (callId: string, account: AccountId, state: string, at: DateTime.Utc) =>
      Ref.update(ref, (book) => book.remember(callId, account, state, at)),
  })),
}) {
  static readonly layer: Layer.Layer<Replay> = Layer.effect(Replay, Replay.make)
}

// ---------------------------------------------------------------------------
// Recording requests

/** How long the newest Codex request is looked back for, to know the model to warm windows with. */
export const lastModelWithin: Duration.Duration = Duration.days(30)

/**
 * Records a request in the ledger, and notes the model a Codex request
 * asked for: the window warmup asks for the same one.
 */
export const recordRequest = (
  pool: Pool["Service"],
  ledger: Ledger["Service"],
  record: RequestRecord,
): Effect.Effect<void> => {
  const lastModel = record.provider === "codex" ? record.model : undefined
  return lastModel === undefined
    ? ledger.record(record)
    : Effect.andThen(
        ledger.record(record),
        pool.update((m) => sawCodex(m, { lastModel })),
      )
}

/** The ledger record of an answer that ended. */
export const servedRecord = (served: Served): RequestRecord => {
  const { report } = served
  return LedgerRecord.cases.Request.make(
    {
      at: DateTime.makeUnsafe(served.endedAt),
      account: served.account,
      provider: served.provider,
      ...(served.model === undefined ? {} : { model: served.model }),
      status: served.status,
      usage: report.outcome.usage,
      ms: Math.max(0, Math.round(served.endedAt - served.startedAt)),
      ...(report.firstByteAt === undefined
        ? {}
        : { firstByteMs: Math.max(0, Math.round(report.firstByteAt - served.startedAt)) }),
      attempts: served.attempts,
      ...(served.agent === undefined ? {} : { agent: served.agent }),
      ...(served.session === undefined ? {} : { session: served.session }),
      via: served.via,
      // Built from values already checked (counts, statuses, clock times): every answer that ends makes one.
    },
    unchecked,
  )
}

const unchecked = { disableChecks: true } as const

// ---------------------------------------------------------------------------
// The settler

export interface Shape {
  /** Queues a settlement. Synchronous and never blocking, for native stream callbacks. */
  readonly offer: (settlement: Settlement) => void
  /** Waits until everything queued before it has been applied. */
  readonly flush: Effect.Effect<void>
}

const make = Effect.gen(function* () {
  const pool = yield* Pool
  const ledger = yield* Ledger
  const replay = yield* Replay
  const queue = yield* Queue.unbounded<Queued>()

  const apply = (settlement: Settlement): Effect.Effect<void> => {
    switch (settlement._tag) {
      case "Served": {
        const { account, report } = settlement
        const exhausted = report.outcome.exhausted
        return Effect.andThen(
          pool.update((m, now) => {
            const counted = addUsage(m, account, report.outcome.usage)
            return exhausted
              ? block(counted, account, DateTime.addDuration(now, defaultBlock), undefined, spentMidStream)
              : counted
          }),
          recordRequest(pool, ledger, servedRecord(settlement)),
        )
      }
      case "Remember":
        return replay.remember(
          settlement.callId,
          settlement.account,
          settlement.state,
          DateTime.makeUnsafe(settlement.at),
        )
      case "Pool":
        return pool.update(settlement.change)
    }
  }

  const drain = Effect.gen(function* () {
    for (const item of yield* Queue.takeAll(queue)) {
      if (item._tag === "Flush") {
        yield* Deferred.succeed(item.done, undefined)
        continue
      }
      // One settlement that fails must not stop the rest, or later answers would never count.
      yield* apply(item).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`settling a finished answer: ${causeText(Cause.squash(cause))}`),
        ),
      )
    }
  })
  yield* Effect.forkScoped(Effect.forever(drain))

  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    Queue.offerUnsafe(queue, { _tag: "Flush", done })
    yield* Deferred.await(done)
  })
  // Runs before the drain fiber is interrupted: what is queued at shutdown is still applied.
  yield* Effect.addFinalizer(() => flush)

  // The model Codex asked for last outlives a restart through the ledger.
  yield* Effect.gen(function* () {
    const m = yield* pool.model
    if (m.codex.lastModel !== undefined) return
    const since = DateTime.subtractDuration(yield* DateTime.now, lastModelWithin)
    const records = yield* ledger.load(since)
    const newest = records.findLast(
      (record) => record._tag === "Request" && record.provider === "codex" && record.model !== undefined,
    )
    if (newest?._tag === "Request" && newest.model !== undefined) {
      const lastModel = newest.model
      yield* pool.update((model) => (model.codex.lastModel === undefined ? sawCodex(model, { lastModel }) : model))
    }
  }).pipe(Effect.ignore, Effect.forkScoped)

  return {
    offer: (settlement) => void Queue.offerUnsafe(queue, settlement),
    flush,
  } satisfies Shape
})

/** Applies what finished answers left behind, one at a time, for the life of the layer. */
export class Settler extends Context.Service<Settler, Shape>()("@slopmax/core/proxy/Settler", { make }) {
  static readonly layer: Layer.Layer<Settler, never, Pool | Ledger | Replay> = Layer.effect(Settler, Settler.make)
}
