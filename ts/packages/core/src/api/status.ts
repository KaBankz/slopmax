// Status events: the report pushed to every front end when it changes, so
// none of them polls. A change to the pool, the accounts or the settings
// builds the report again (at most once a quarter second: the first change
// opens a short window and everything inside it is taken together, so a busy
// proxy, whose every request changes the pool, still sends fresh reports),
// and so does a tick every 15 seconds, for conditions that
// change with time alone, such as a block running out. A report is sent
// only when it differs from the last one sent, and none is built while
// nobody watches.
import { type AccountId, type AccountView, Event, Report } from "@slopmax/domain"
import { Duration, Effect, Ref, Schedule, type Scope, Schema, Semaphore, Sink, Stream } from "effect"
import { Accounts } from "../accounts.ts"
import { Events } from "../events.ts"
import { Pool, sync } from "../pool.ts"
import { report } from "../report.ts"
import { SettingsService } from "../settings.ts"

/**
 * The live report after a change, with the pool brought in step with the
 * accounts first, so an answer always shows what the change did.
 */
export const freshReport: Effect.Effect<Report, never, Pool | Accounts | SettingsService> = Effect.gen(function* () {
  const list = yield* (yield* Accounts).list
  yield* (yield* Pool).update((m) => (m.accounts === list ? m : sync(m, list)))
  return yield* report(true)
})

/** One account as the report shows it. */
export const viewIn = (built: Report, id: AccountId): AccountView | undefined =>
  built.accounts.find((account) => account.id === id)

/** How long changes gather before the report is built; at most one build per this. */
export const statusSettle: Duration.Duration = Duration.millis(250)

/** How often the report is built anyway, for conditions that change with time. */
export const statusEvery: Duration.Duration = Duration.seconds(15)

const encodeReport = Schema.encodeSync(Report)

/** What tells two reports apart: everything but when each was built. */
export const reportKey = (built: Report): string => {
  const { generatedAt: _built, ...rest } = encodeReport(built)
  return JSON.stringify(rest)
}

/** Publishes `Status` events for the life of the scope. */
export const publishStatus: Effect.Effect<void, never, Pool | Accounts | SettingsService | Events | Scope.Scope> =
  Effect.gen(function* () {
    const pool = yield* Pool
    const accounts = yield* Accounts
    const settings = yield* SettingsService
    const events = yield* Events
    const last = yield* Ref.make<string | undefined>(undefined)
    // One look at a time, so a tick and a change never send the same report twice.
    const one = yield* Semaphore.make(1)
    const services = Effect.provideService(Effect.provideService(report(true), Pool, pool), SettingsService, settings)

    const look = one.withPermit(
      Effect.gen(function* () {
        if (!(yield* events.watching)) return yield* Ref.set(last, undefined)
        const built = yield* services
        const key = reportKey(built)
        if (key === (yield* Ref.get(last))) return
        yield* Ref.set(last, key)
        yield* events.publish(Event.cases.Status.make({ report: built }))
      }),
    )

    const changed = Stream.mergeAll(
      [pool.changes, accounts.changes, settings.changes.pipe(Stream.map((): void => undefined))],
      { concurrency: "unbounded" },
    ).pipe(
      // Not a debounce: one waits for a pause, and a busy pool never pauses.
      Stream.aggregateWithin(Sink.last(), Schedule.spaced(statusSettle)),
    )
    yield* Stream.merge(changed, Stream.tick(statusEvery)).pipe(
      Stream.runForEach(() => look),
      Effect.forkScoped,
    )
    // Someone arriving while nobody watched hears the report at once; once
    // everyone has gone, the next arrival is sent one even if nothing changed.
    yield* events.watchers.pipe(
      Stream.runForEach((count) => (count === 0 ? one.withPermit(Ref.set(last, undefined)) : look)),
      Effect.forkScoped,
    )
  })
