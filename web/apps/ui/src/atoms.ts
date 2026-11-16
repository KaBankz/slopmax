// The app's state, as atoms. The report arrives on the event stream (and in
// the answer to every change); settings, keys, agents, the doctor and the
// history are queries the API answers; every action is a function atom that
// calls the API, takes the report it answers, and says what it did. Nothing
// is polled: the stream pushes the report, and an answered request
// invalidates the history a little later.
import {
  type AgentId,
  agentFacts,
  type Event,
  type HistoryRange,
  type LivePatch,
  type LoginEvent,
  type NewKey,
  providerFacts,
  type RedeemOutcome,
  type Report,
  type RequestRow,
  type SubscriptionId,
  Unauthorized,
} from "@slopmax/client"
import { AccountId, Health, KeyName, LoginId, reaches, tailnetToken } from "@slopmax/client"
import {
  type AddAccount,
  AccountPatch,
  ImportRequest,
  type ImportResult,
  type ImportSource,
  MakeKey,
  PasteAddress,
  RedeemRequest,
  SlopmaxApi,
  StartLogin,
} from "@slopmax/client/api"
import { clock, noticeBody, noticeTitle } from "@slopmax/client/format"
import { Cause, Data, DateTime, Duration, Effect, Exit, FiberHandle, Option, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { AsyncResult, Atom, AtomRegistry, Reactivity } from "effect/reactivity"
import { accessAtom, Api, appRuntime, hostAtom, keyCheckRuntime, machineAtom, ownerKeyAtom } from "./api.ts"
import { Host, UiPrefs } from "./host.ts"
import { attention, type Attention } from "./view/attention.ts"
import { type Group, groups } from "./view/groups.ts"
import {
  type FeedEntry,
  type ProxyState,
  pushFeed,
  shownProxy,
  type SignIn,
  signInDone,
  startSignIn,
  stepSignIn,
  tell,
} from "./view/live.ts"
import { type Page, pageHash, parsePage, toggleSidebar as toggled } from "./view/pages.ts"
import { maskEmails, maskReport } from "./view/privacy.ts"
import { tailnetAccess } from "./view/tailnet.ts"
import { allRequests, csv, csvName, pageSize, type RequestFilter } from "./view/requests.ts"
import { addToast, type Toast } from "./view/toasts.ts"
import { count, defaultRange, failureText, sentenceCase, settingChanged } from "./view/words.ts"

// --- Time ------------------------------------------------------------------------

/** Now, ticking every second for countdowns, pace and toasts. */
export const nowAtom: Atom.Atom<DateTime.Utc> = Atom.map(
  Atom.make(Stream.tick("1 second").pipe(Stream.mapEffect(() => DateTime.now))),
  (result) => AsyncResult.getOrElse(result, () => DateTime.nowUnsafe()),
)

/** The zone times are shown in: this machine's. */
export const zone: DateTime.TimeZone = DateTime.zoneMakeLocal()

/** Ticks once a minute, so the history shown is read again while it is shown. */
const minuteAtom = Atom.make(Stream.tick("60 seconds").pipe(Stream.mapEffect(() => DateTime.now)))

// --- What the stream and the actions keep ----------------------------------------------

/** Whether the event stream is up, as the live indicator shows it. */
export type Live =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Running"; readonly version: string }
  | { readonly _tag: "Reconnecting" }

export const liveAtom = Atom.make<Live>({ _tag: "Connecting" }).pipe(Atom.keepAlive)

/** The latest report from the proxy. */
export const reportAtom = Atom.make<Option.Option<Report>>(Option.none()).pipe(Atom.keepAlive)

/** The requests answered since the page opened, newest first. */
export const feedAtom = Atom.make<ReadonlyArray<FeedEntry>>([]).pipe(Atom.keepAlive)

/** A sign-in in progress. */
export const signInAtom = Atom.make<Option.Option<SignIn>>(Option.none()).pipe(Atom.keepAlive)

/** A client key just made: the only time its secret is shown. */
export const newKeyAtom = Atom.make<Option.Option<NewKey>>(Option.none()).pipe(Atom.keepAlive)

/** The account whose limit reset is being redeemed. */
export const redeemingAtom = Atom.make<Option.Option<string>>(Option.none()).pipe(Atom.keepAlive)

/** What the app just did or failed to do; errors stay until dismissed. */
export const toastsAtom = Atom.make<ReadonlyArray<Toast>>([]).pipe(Atom.keepAlive)

/** The account whose limit resets are open on its provider page. */
export const openCreditsAtom = Atom.make<Option.Option<string>>(Option.none()).pipe(Atom.keepAlive)

/** The last request's place in the feed, so each row keeps its own key. */
const feedSeqAtom = Atom.make(0).pipe(Atom.keepAlive)

/** Whether the owner key the dashboard last tried was refused, so the gate says so. */
export const keyRefusedAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * The tailnet's side of the gate: `asked` once a refused tailnet token sent
 * the page back to `/healthz`, until the event stream next says Hello;
 * `refused` when it was refused again before that, so the gate asks for a
 * key rather than asking `/healthz` round and round.
 */
export const tailnetRetryAtom = Atom.make<"none" | "asked" | "refused">("none").pipe(Atom.keepAlive)

/**
 * Reading and writing atoms from inside the stream's handler or an action.
 * Reads never subscribe: the event stream would otherwise start over each
 * time an atom it looked at changed.
 */
interface Store {
  readonly read: <A>(atom: Atom.Atom<A>) => A
  readonly set: <R, W>(atom: Atom.Writable<R, W>, value: W) => void
  readonly refresh: <A>(atom: Atom.Atom<A>) => void
}

/** The event stream's store: it reads each atom once, without watching it. */
const streamStore = (get: Atom.AtomContext): Store => ({
  read: (atom) => get.once(atom),
  set: (atom, value) => get.set(atom, value),
  refresh: (atom) => get.refresh(atom),
})

/**
 * An action's store: the registry itself, so an action that is still running
 * when the same action starts again writes what it came to all the same.
 */
const actionStore: Effect.Effect<Store, never, AtomRegistry.AtomRegistry> = Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry
  return {
    read: (atom) => registry.get(atom),
    set: (atom, value) => registry.set(atom, value),
    refresh: (atom) => registry.refresh(atom),
  }
})

const say = (store: Store, text: string, error = false): void => {
  store.set(toastsAtom, addToast(store.read(toastsAtom), text, error, DateTime.toEpochMillis(store.read(nowAtom))))
}

/** Dismisses a toast. */
export const dismissToast = Atom.writable(
  (get) => get(toastsAtom),
  (ctx, id: number) =>
    ctx.set(
      toastsAtom,
      ctx.get(toastsAtom).filter((toast) => toast.id !== id),
    ),
)

/** Clears the live feed. */
export const clearFeed = Atom.writable<ReadonlyArray<FeedEntry>, void>(
  (get) => get(feedAtom),
  (ctx) => ctx.set(feedAtom, []),
)

// --- Errors ----------------------------------------------------------------------------

const isUnauthorized = (cause: Cause.Cause<unknown>): boolean => Cause.squash(cause) instanceof Unauthorized

/**
 * The key was refused: forget it, so the web dashboard asks again and says
 * why. A page that held the tailnet token asks `/healthz` again first: the
 * hub may still take this machine, perhaps for less than before, and asks
 * for a key only when it does not.
 */
const signOut = (store: Store) =>
  Effect.gen(function* () {
    const host = yield* Host
    const held = store.read(ownerKeyAtom)
    // Already signed out: a call that was on its way without a key says nothing new.
    if (Option.isNone(held)) return
    if (Option.contains(held, tailnetToken)) {
      store.set(accessAtom, "admin")
      store.set(machineAtom, Option.none())
      if (store.read(tailnetRetryAtom) === "none") {
        store.set(tailnetRetryAtom, "asked")
        store.refresh(tailnetProbeAtom)
      } else store.set(tailnetRetryAtom, "refused")
      store.set(ownerKeyAtom, Option.none())
      return
    }
    yield* host.forgetKey
    store.set(keyRefusedAtom, true)
    store.set(ownerKeyAtom, Option.none())
  })

// --- The event stream ----------------------------------------------------------------------

/** How the stream is retried once it drops: after 1 s, doubling up to 15 s. */
const reconnect = { first: Duration.seconds(1), most: Duration.seconds(15) } as const

/** How long the history waits after a request before it is read again, so a burst reads it once. */
const historyDebounce = Duration.seconds(8)

/**
 * Sign-in steps, by sign-in, for the moments between asking for a sign-in
 * and hearing its id: the stream may tell the first step before the answer.
 * The few latest sign-ins are kept.
 */
const loginBacklogAtom = Atom.make<ReadonlyMap<string, ReadonlyArray<LoginEvent>>>(new Map()).pipe(Atom.keepAlive)
const backlogSize = 8

/** Takes the steps told of a sign-in before its id was known. */
const takeBacklog = (store: Store, id: string): ReadonlyArray<LoginEvent> => {
  const backlog = store.read(loginBacklogAtom)
  const told = backlog.get(id) ?? []
  store.set(loginBacklogAtom, new Map([...backlog].filter(([other]) => other !== id)))
  return told
}

/** Moves the sign-in this page started along with a step it reported. */
const onLogin = (store: Store, id: string, event: LoginEvent) =>
  Effect.gen(function* () {
    const current = store.read(signInAtom)
    if (Option.isNone(current) || current.value.id !== id) {
      const backlog = store.read(loginBacklogAtom)
      const kept = [...backlog].filter(([other]) => other !== id).slice(-(backlogSize - 1))
      store.set(loginBacklogAtom, new Map([...kept, [id, [...(backlog.get(id) ?? []), event]]]))
      return
    }
    const done = signInDone(event)
    if (done !== undefined) {
      store.set(signInAtom, Option.none())
      say(store, done.text, done.error)
      return
    }
    const next = stepSignIn(current.value, event)
    // The page opens the address itself, so a sign-in started here works from another machine too.
    if (next.step._tag === "Authorize" && !next.step.opened && current.value.step._tag !== "Authorize") {
      const host = yield* Host
      const opened = yield* host.openExternal(next.step.url)
      store.set(signInAtom, Option.some({ ...next, step: { ...next.step, opened } }))
      return
    }
    store.set(signInAtom, Option.some(next))
  })

/** The queries read again once the stream is back after a drop. */
const rereadOnReconnect: ReadonlyArray<string> = ["settings", "keys", "agents", "doctor", "history", "tailnet"]

const onEvent = (event: Event, store: Store, later: FiberHandle.FiberHandle) =>
  Effect.gen(function* () {
    switch (event._tag) {
      case "Hello": {
        const back = store.read(liveAtom)._tag === "Reconnecting"
        if (store.read(tailnetRetryAtom) !== "none") store.set(tailnetRetryAtom, "none")
        store.set(liveAtom, { _tag: "Running", version: event.version })
        // Back after a drop: what was read while slopmax did not answer (or failed to be read) is read again.
        if (back) yield* Reactivity.invalidate(rereadOnReconnect)
        return
      }
      case "Status":
        store.set(reportAtom, Option.some(event.report))
        if (event.report.nudges.length > 0) yield* notifyOnce(event.report.nudges, store.read(prefsAtom).hideEmails)
        return
      case "Request": {
        const seq = store.read(feedSeqAtom) + 1
        store.set(feedSeqAtom, seq)
        store.set(feedAtom, pushFeed(store.read(feedAtom), event.record, seq))
        yield* FiberHandle.run(
          later,
          Effect.sleep(historyDebounce).pipe(Effect.andThen(Reactivity.invalidate(["history"]))),
        )
        return
      }
      case "Notice":
        yield* notifyOnce([event.notice], store.read(prefsAtom).hideEmails)
        return
      case "Login":
        yield* onLogin(store, event.id, event.event)
        return
      case "Ping":
        return
    }
  })

/** Posts each notice this browser has not shown yet, once. */
const notifyOnce = (notices: Report["nudges"], hide: boolean) =>
  Effect.gen(function* () {
    const host = yield* Host
    if ((yield* host.permission) !== "granted") return
    const { fresh, told } = tell(yield* host.told, notices)
    for (const notice of fresh) {
      const body = noticeBody(notice)
      yield* host.notify(noticeTitle(notice.kind), hide ? maskEmails(body) : body, notice.key)
    }
    if (fresh.length > 0) yield* host.saveTold(told)
  })

/** A connection to the event stream ended: `up` when it had said Hello first. */
class Dropped extends Data.TaggedError("Dropped")<{ readonly up: boolean }> {}

/** The proxy refused the key the dashboard holds. */
class Refused extends Data.TaggedError("Refused")<{}> {}

/** Waits between tries to reach a proxy that does not answer: 1 s, doubling up to 15 s. */
const backoff = Schedule.min([Schedule.exponential(reconnect.first), Schedule.spaced(reconnect.most)])

/**
 * The event stream, kept open while the app is: `Hello`, the report, then
 * live events. When it drops it says so and tries again after 1 s; while the
 * proxy does not answer, the wait doubles up to 15 s, and starts at 1 s again
 * once a connection is up. A refused key ends it, and the dashboard asks for the key.
 */
export const eventsAtom = appRuntime.atom((get) =>
  Effect.gen(function* () {
    const store = streamStore(get)
    const client = yield* Api
    const later = yield* FiberHandle.make()
    const connection = Effect.suspend(() => {
      let up = false
      return client.events.watch().pipe(
        Effect.flatMap((stream) =>
          Stream.runForEach(stream, (event) =>
            Effect.andThen(
              Effect.sync(() => {
                if (event._tag === "Hello") up = true
              }),
              onEvent(event, store, later),
            ),
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit): Effect.Effect<never, Dropped | Refused> =>
          Exit.isFailure(exit) && isUnauthorized(exit.cause)
            ? Effect.fail(new Refused())
            : Effect.fail(new Dropped({ up })),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error._tag === "Dropped") store.set(liveAtom, { _tag: "Reconnecting" })
          }),
        ),
      )
    })
    yield* connection.pipe(
      // Not reached at all: back off.
      Effect.retry({ schedule: backoff, while: (error) => error._tag === "Dropped" && !error.up }),
      // It was up and dropped: try again in a second, backing off afresh.
      Effect.retry({ schedule: Schedule.spaced(reconnect.first), while: (error) => error._tag === "Dropped" }),
      Effect.catch(() => signOut(store)),
    )
  }),
)

// --- The proxy --------------------------------------------------------------------------

/**
 * Where the proxy stands, as far as the dashboard knows: whether its stream
 * is up. The proxy serves the page, so while the stream is down the
 * dashboard is waiting for it, never sure it stopped.
 */
export const proxyAtom = Atom.make((get): ProxyState => {
  const live = get(liveAtom)
  return live._tag === "Running" ? { _tag: "Running", version: live.version } : { _tag: "Checking" }
})

/** The proxy's state in a label, the same in the sidebar's foot and in Settings. */
export const proxyStatusAtom = Atom.make((get) => shownProxy(get(proxyAtom), get(liveAtom)._tag))

/** Whether the dashboard lost slopmax and is trying to reach it again. */
export const unansweredAtom = Atom.make((get): boolean => get(liveAtom)._tag === "Reconnecting")

/** The report to show, its email addresses masked when the preferences say so. */
export const shownReportAtom = Atom.make((get): Option.Option<Report> =>
  get(prefsAtom).hideEmails ? Option.map(get(reportAtom), maskReport) : get(reportAtom),
)

/**
 * Whether this page may only look: it was opened over the tailnet, from a
 * machine the hub lets see its status but not change it.
 */
export const readOnlyAtom = Atom.make((get): boolean => !reaches(get(accessAtom), "admin"))

/** Whether changes can be made: only a running proxy takes them, and only from a page that may make them. */
export const canChangeAtom = Atom.make((get): boolean => get(proxyAtom)._tag === "Running" && !get(readOnlyAtom))

/** The shown report's accounts by provider, worked out once a second for every part of the window that shows them. */
export const groupsAtom = Atom.make((get): ReadonlyArray<Group> =>
  Option.match(get(shownReportAtom), { onNone: () => [], onSome: (report) => groups(report, get(nowAtom), zone) }),
)

/** What wants a look in the shown report, likewise once a second. */
export const attentionAtom = Atom.make((get): ReadonlyArray<Attention> =>
  Option.match(get(shownReportAtom), { onNone: () => [], onSome: (report) => attention(report, get(nowAtom), zone) }),
)

// --- Queries ------------------------------------------------------------------------------

/**
 * A query only an admin may make, left unasked while the page may only look
 * (the hub would refuse it): it stays as if not yet read, and the page says
 * why instead. Retrying it retries the query itself.
 */
const adminOnly = <A, E>(query: Atom.Atom<AsyncResult.AsyncResult<A, E>>): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  Atom.readable(
    (get) => (get(readOnlyAtom) ? AsyncResult.initial<A, E>() : get(query)),
    (refresh) => refresh(query),
  )

export const settingsAtom = adminOnly(Api.query("config", "settings", { reactivityKeys: ["settings"] }))
export const keysAtom = adminOnly(Api.query("config", "keys", { reactivityKeys: ["keys"] }))
export const agentsAtom = adminOnly(Api.query("agents", "list", { reactivityKeys: ["agents"] }))
export const doctorAtom = adminOnly(Api.query("system", "doctor", { reactivityKeys: ["doctor"] }))

/** slopmax on the tailnet, as the hub sees it; an older proxy answers 404, and the page then leaves it out. */
export const tailnetAtom = Api.query("tailnet", "view", { reactivityKeys: ["tailnet"] })

/** Whether usage polling is off, so windows are read only by requests and Refresh; false until the settings are read. */
export const pollOffAtom = Atom.make((get): boolean =>
  Option.exists(AsyncResult.value(get(settingsAtom)), (view) => view.settings.pollMinutes === 0),
)

/** A range's history, read again a little after requests are answered and once a minute while shown. */
export const historyAtom = Atom.family((range: HistoryRange) =>
  Api.runtime
    .atom((get) => {
      get(minuteAtom)
      return Effect.gen(function* () {
        const client = yield* Api
        return yield* client.usage.history({ query: { range } })
      })
    })
    .pipe(Api.runtime.factory.withReactivity(["history"])),
)

/** A range's usage by the machine that sent it, read again with the history. */
export const machinesAtom = Atom.family((range: HistoryRange) =>
  Api.runtime
    .atom((get) => {
      get(minuteAtom)
      return Effect.gen(function* () {
        const client = yield* Api
        return yield* client.usage.summary({ query: { range, by: "machine" } })
      })
    })
    .pipe(Api.runtime.factory.withReactivity(["history"])),
)

/**
 * A subscription pool over time: its windows recorded and projected, what
 * each account's windows have served, and its last day of requests. Read
 * again with the history: a little after requests, and once a minute.
 */
export const poolDetailAtom = Atom.family((provider: SubscriptionId) =>
  Api.runtime
    .atom((get) => {
      get(minuteAtom)
      return Effect.gen(function* () {
        const client = yield* Api
        return yield* client.usage.pool({ params: { provider } })
      })
    })
    .pipe(Api.runtime.factory.withReactivity(["history"])),
)

/** What the Requests page lists, kept while the app runs. */
export const requestFilterAtom = Atom.make<RequestFilter>(allRequests).pipe(Atom.keepAlive)

/** How many of the ledger's requests the Requests page shows: a page more with each "Show more". */
export const requestLimitAtom = Atom.make(pageSize).pipe(Atom.keepAlive)

/** The query a filter and a row count ask of `GET /requests`. */
const requestQuery = (filter: RequestFilter, range: HistoryRange, limit: number, offset = 0) => ({
  range,
  outcome: filter.outcome,
  ...(filter.account === undefined ? {} : { account: AccountId.make(filter.account) }),
  ...(filter.model === undefined ? {} : { model: filter.model }),
  ...(filter.agent === undefined ? {} : { agent: filter.agent }),
  offset,
  limit,
})

/**
 * The first rows of a range of the ledger that a filter takes, newest first,
 * keyed by the filter and the row count as JSON. Read again with the history:
 * a little after requests, and once a minute.
 */
export const requestPageAtom = Atom.family((key: string) =>
  Api.runtime
    .atom((get) => {
      get(minuteAtom)
      const { filter, range, limit } = requestQueries.get(key) ?? {
        filter: allRequests,
        range: "today" as const,
        limit: pageSize,
      }
      return Effect.gen(function* () {
        const client = yield* Api
        return yield* client.usage.requests({ query: requestQuery(filter, range, limit) })
      })
    })
    .pipe(Api.runtime.factory.withReactivity(["history"])),
)

/** What each key of `requestPageAtom` asks for. */
const requestQueries = new Map<
  string,
  { readonly filter: RequestFilter; readonly range: HistoryRange; readonly limit: number }
>()

/** The key of `requestPageAtom` for a filter over a range and a row count. */
export const requestPageKey = (filter: RequestFilter, range: HistoryRange, limit: number): string => {
  const key = JSON.stringify({ filter, range, limit })
  requestQueries.set(key, { filter, range, limit })
  return key
}

/** The range the Usage and Performance pages show. */
export const rangeAtom = Atom.make<HistoryRange>(defaultRange).pipe(Atom.keepAlive)

// --- Actions --------------------------------------------------------------------------------

/** What an action came to: the report it answered, and what to say. */
interface Outcome {
  readonly report?: Report
  readonly text?: string
  readonly error?: boolean
}

type Action<Arg, E> = (arg: Arg, store: Store) => Effect.Effect<Outcome, E, Api | Host | Reactivity.Reactivity>

/**
 * Every action runs to its end, even when another (or the same one again)
 * starts before it is answered: two quick changes are two changes, each
 * answered and told.
 */
const concurrent = { concurrent: true } as const

/** What an action that failed says before why: which action it was, so a toast read later still makes sense. */
type Failed<Arg> = string | ((arg: Arg, store: Store) => string)

/**
 * Runs an action: on success takes its report and says its text; on failure
 * says what went wrong (after `failed`, when given). A refused key signs the
 * dashboard out.
 */
const act = <Arg, E>(run: Action<Arg, E>, failed?: Failed<Arg>) =>
  appRuntime.fn<Arg>()(
    (arg) =>
      Effect.flatMap(actionStore, (store) =>
        run(arg, store).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (outcome.report !== undefined) store.set(reportAtom, Option.some(outcome.report))
              if (outcome.text !== undefined) say(store, outcome.text, outcome.error ?? false)
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) return
              if (isUnauthorized(cause)) {
                yield* signOut(store)
                return
              }
              const before = typeof failed === "function" ? failed(arg, store) : failed
              say(
                store,
                before === undefined ? sentenceCase(failureText(cause)) : `${before}${failureText(cause)}`,
                true,
              )
            }),
          ),
          Effect.asVoid,
        ),
      ),
    concurrent,
  )

/** An action that takes nothing. */
const task = <E>(run: (store: Store) => ReturnType<Action<void, E>>, failed?: Failed<void>) =>
  act((_: void, store) => run(store), failed)

const accountOf = (store: Store, id: string) =>
  store
    .read(reportAtom)
    .pipe(Option.flatMap((report) => Option.fromUndefinedOr(report.accounts.find((a) => a.id === id))))

/** An account's name for a toast, masked while addresses are hidden. */
const nameOf = (store: Store, id: string): string => {
  const name = Option.match(accountOf(store, id), { onNone: () => id, onSome: (account) => account.name })
  return store.read(prefsAtom).hideEmails ? maskEmails(name) : name
}

const providerOf = (store: Store, id: string): string =>
  Option.match(accountOf(store, id), {
    onNone: () => "Its provider",
    onSome: (account) => providerFacts[account.provider].title,
  })

export const refresh = task(
  () =>
    Effect.gen(function* () {
      const client = yield* Api
      const report = yield* client.system.refresh()
      yield* Reactivity.invalidate(["history"])
      return { report, text: "Usage and limit resets read again." }
    }),
  "Could not read usage again: ",
)

/** Whether usage is being read again, so Refresh spins and is not pressed twice. */
export const refreshingAtom = Atom.make((get): boolean => AsyncResult.isWaiting(get(refresh)))

/** Starts a browser (or device code) sign-in; its steps arrive on the event stream. */
export const signIn = act(
  (input: { readonly provider: SubscriptionId; readonly device?: boolean }, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      const current = store.read(signInAtom)
      if (Option.isSome(current) && current.value.id !== undefined) {
        yield* client.logins.cancel({ params: { id: LoginId.make(current.value.id) } }).pipe(Effect.ignore)
      }
      store.set(signInAtom, Option.some(startSignIn(input.provider)))
      const started = yield* client.logins
        .start({
          payload: new StartLogin({ provider: input.provider, device: input.device ?? false, noBrowser: false }),
        })
        .pipe(Effect.tapCause(() => Effect.sync(() => store.set(signInAtom, Option.none()))))
      const now = store.read(signInAtom)
      if (Option.isSome(now) && now.value.id === undefined) {
        store.set(signInAtom, Option.some({ ...now.value, id: started.id }))
        for (const event of takeBacklog(store, started.id)) yield* onLogin(store, started.id, event)
      }
      return {}
    }),
  "Sign-in failed: ",
)

export const cancelSignIn = task((store) =>
  Effect.gen(function* () {
    const client = yield* Api
    const current = store.read(signInAtom)
    store.set(signInAtom, Option.none())
    if (Option.isSome(current) && current.value.id !== undefined) {
      yield* client.logins.cancel({ params: { id: LoginId.make(current.value.id) } }).pipe(Effect.ignore)
    }
    return {}
  }),
)

/** Hands the address a browser on another machine ended on (or the code its page shows) to the sign-in in progress. */
export const pasteAddress = act(
  (address: string, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      const current = store.read(signInAtom)
      if (Option.isNone(current) || current.value.id === undefined || address.trim() === "") return {}
      yield* client.logins.paste({
        params: { id: LoginId.make(current.value.id) },
        payload: new PasteAddress({ address: address.trim() }),
      })
      return {}
    }),
  (_, store) => {
    const step = Option.map(store.read(signInAtom), (current) => current.step)
    const code = Option.exists(step, (s) => s._tag === "Authorize" && s.port === 0)
    return code ? "That code was not accepted: " : "That address was not accepted: "
  },
)

/** What an account added through the API is called in the toast: its label, else its provider. */
const addedName = (account: AddAccount): string =>
  account.label !== undefined && account.label.trim() !== ""
    ? account.label.trim()
    : account._tag === "Key"
      ? providerFacts[account.provider].title
      : "Compatible endpoint"

/**
 * Adds an API key or a compatible endpoint. Its failure stays with the form
 * that asked (the key is checked first, and why it was refused belongs
 * beside it), so this answers its error rather than toasting it.
 */
export const addAccount = appRuntime.fn<AddAccount>()(
  (account) =>
    Effect.gen(function* () {
      const store = yield* actionStore
      const client = yield* Api
      const added = yield* client.accounts.add({ payload: account })
      store.set(reportAtom, Option.some(added.report))
      const notices = added.notices ?? []
      // Saved, but not answering: said as a warning, so it is not missed.
      if (notices.length > 0) say(store, notices.join(" "), true)
      else say(store, `${addedName(account)} added.`)
      return added.account
    }),
  concurrent,
)

/** Where an import found a login, as people call it. */
const importSources: { readonly [K in ImportSource]: string } = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cliproxyapi: "CLIProxyAPI",
}

/** What importing logins says it did, and whether it reads as a failure. */
export const importText = (result: ImportResult): { readonly text: string; readonly error: boolean } => {
  const saved = result.outcomes.filter((outcome) => outcome._tag === "Saved").length
  const found = result.outcomes.length
  if (found === 0) {
    return { text: "No logins found. Sign in with Claude Code or Codex first, or use Sign in above.", error: false }
  }
  const accounts = saved === 1 ? "1 account" : `${saved} accounts`
  if (saved === found) return { text: `Imported ${accounts}.`, error: false }
  const failed = result.outcomes.find((outcome) => outcome._tag === "Failed")
  const why = failed === undefined ? "" : ` ${importSources[failed.source]}: ${failed.message}`
  return {
    text: `Imported ${accounts} of ${count(found, "login")} found.${why}`,
    error: saved === 0,
  }
}

export const importLogins = task(
  () =>
    Effect.gen(function* () {
      const client = yield* Api
      const result = yield* client.accounts.import({ payload: new ImportRequest({ own: false }) })
      return { report: result.report, ...importText(result) }
    }),
  "Could not import: ",
)

/** Changes to one account. */
export type AccountChange =
  | { readonly _tag: "Pin"; readonly id: string }
  | { readonly _tag: "UnpinAll" }
  | { readonly _tag: "Enable"; readonly id: string; readonly on: boolean }
  | { readonly _tag: "Priority"; readonly id: string; readonly priority: number }
  | { readonly _tag: "Rename"; readonly id: string; readonly label: string }
  | { readonly _tag: "Remove"; readonly id: string }
  | { readonly _tag: "Own"; readonly id: string }

export const changeAccount = act(
  (change: AccountChange, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      switch (change._tag) {
        case "Pin": {
          const report = yield* client.accounts.pin({ params: { id: AccountId.make(change.id) } })
          return { report, text: `New ${providerOf(store, change.id)} sessions go to ${nameOf(store, change.id)}.` }
        }
        case "UnpinAll":
          return { report: yield* client.accounts.unpinAll(), text: "slopmax chooses accounts again." }
        case "Enable": {
          const name = nameOf(store, change.id)
          const report = yield* client.accounts.update({
            params: { id: AccountId.make(change.id) },
            payload: new AccountPatch({ disabled: !change.on }),
          })
          return { report, text: `${name} ${change.on ? "enabled" : "disabled"}.` }
        }
        case "Priority": {
          const report = yield* client.accounts.update({
            params: { id: AccountId.make(change.id) },
            payload: new AccountPatch({ priority: change.priority }),
          })
          return { report, text: `${nameOf(store, change.id)} is at priority ${change.priority}.` }
        }
        case "Rename": {
          const report = yield* client.accounts.update({
            params: { id: AccountId.make(change.id) },
            payload: new AccountPatch({ label: change.label.trim() === "" ? null : change.label.trim() }),
          })
          return { report, text: "Renamed." }
        }
        case "Remove": {
          const name = nameOf(store, change.id)
          const report = yield* client.accounts.remove({ params: { id: AccountId.make(change.id) } })
          return { report, text: `${name} removed.` }
        }
        case "Own": {
          const name = nameOf(store, change.id)
          const report = yield* client.accounts.own({ params: { id: AccountId.make(change.id) } })
          return { report, text: `slopmax refreshes ${name} itself now.` }
        }
      }
    }),
  (change, store) => {
    if (change._tag === "UnpinAll") return "Could not stop pinning: "
    const name = nameOf(store, change.id)
    switch (change._tag) {
      case "Pin":
        return `Could not send new sessions to ${name}: `
      case "Enable":
        return `Could not ${change.on ? "enable" : "disable"} ${name}: `
      case "Priority":
        return `Could not change ${name}'s priority: `
      case "Rename":
        return `Could not rename ${name}: `
      case "Remove":
        return `Could not remove ${name}: `
      case "Own":
        return `Could not refresh ${name} here: `
    }
  },
)

/** What a redeemed limit reset came to, and whether it reads as a failure. */
const redeemText = (
  outcome: RedeemOutcome,
  name: string,
  provider: string,
): { readonly text: string; readonly error: boolean } => {
  switch (outcome) {
    case "reset":
      return { text: `Redeemed. ${name}'s windows are reset.`, error: false }
    case "nothing-to-reset":
      return { text: `${name} had nothing to reset yet, so the limit reset was kept.`, error: false }
    case "no-credit":
      return { text: `${name} has no limit reset left.`, error: true }
    case "already-redeemed":
      return { text: "That limit reset was already redeemed.", error: true }
    case "declined":
      return { text: `${provider} would not spend it on ${name} now; the limit reset was kept.`, error: true }
  }
}

export const redeem = act(
  (input: { readonly id: string; readonly reset?: string }, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      const name = nameOf(store, input.id)
      const provider = providerOf(store, input.id)
      store.set(redeemingAtom, Option.some(input.id))
      const result = yield* client.accounts
        .redeem({
          params: { id: AccountId.make(input.id) },
          payload: new RedeemRequest(input.reset === undefined ? {} : { reset: input.reset }),
        })
        .pipe(Effect.ensuring(Effect.sync(() => store.set(redeemingAtom, Option.none()))))
      return { report: result.report, ...redeemText(result.outcome, name, provider) }
    }),
  "Could not redeem a limit reset: ",
)

/**
 * Lifts slopmax's hold on a limited or throttled account and reads its
 * usage again, then says whether it is back.
 */
export const checkAccount = act(
  (id: string, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      const name = nameOf(store, id)
      const report = yield* client.accounts.check({ params: { id: AccountId.make(id) } })
      const now = yield* DateTime.now
      const condition = report.accounts.find((account) => account.id === id)?.condition
      const text =
        condition?._tag === "Limited"
          ? `${name} is still limited: its provider's usage says it is back ${clock(condition.until, now, zone)}.`
          : `${name} is back in rotation.`
      return { report, text }
    }),
  (id, store) => `Could not check ${nameOf(store, id)}: `,
)

/** The most rows an export writes. */
const exportMost = 100_000

/** Saves every request a filter takes over a range as CSV, a thousand at a time. */
export const exportRequests = act(
  (input: { readonly filter: RequestFilter; readonly range: HistoryRange }, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      const host = yield* Host
      const rows: Array<RequestRow> = []
      for (;;) {
        const page = yield* client.usage.requests({
          query: requestQuery(input.filter, input.range, 1_000, rows.length),
        })
        rows.push(...page.rows)
        if (page.rows.length === 0 || rows.length >= page.matched || rows.length >= exportMost) break
      }
      const now = yield* DateTime.now
      const name = csvName(now, zone)
      const saved = yield* host.save(
        name,
        csv(rows, (id) => nameOf(store, id)),
        "text/csv",
      )
      return saved
        ? { text: `Saved ${count(rows.length, "request")} to ${name}.` }
        : { text: "Could not save the export.", error: true }
    }),
  "Could not export the requests: ",
)

export const connectAgent = act(
  (id: AgentId) =>
    Effect.gen(function* () {
      const client = yield* Api
      const connected = yield* client.agents.connect({ params: { id } })
      yield* Reactivity.invalidate(["agents"])
      return { text: `${agentFacts[id].title} now uses slopmax. ${connected.note}`.trim() }
    }),
  (id) => `Could not connect ${agentFacts[id].title}: `,
)

export const disconnectAgent = act(
  (id: AgentId) =>
    Effect.gen(function* () {
      const client = yield* Api
      yield* client.agents.disconnect({ params: { id } })
      yield* Reactivity.invalidate(["agents"])
      return { text: `${agentFacts[id].title} is back to its own setup.` }
    }),
  (id) => `Could not disconnect ${agentFacts[id].title}: `,
)

/**
 * Changes live settings; the whole change is checked before anything is
 * written. A refused change reads the settings again, so every control
 * shows what is really in force.
 */
export const changeSettings = act(
  (patch: LivePatch) =>
    Effect.gen(function* () {
      const client = yield* Api
      yield* client.config
        .change({ payload: patch })
        .pipe(Effect.ensuring(Reactivity.invalidate(["settings"]).pipe(Effect.ignore)))
      const text = settingChanged(patch)
      return text === undefined ? {} : { text }
    }),
  "The setting was not changed: ",
)

/**
 * Makes a client key. Like adding an account, its failure stays with the
 * form that asked (a taken name belongs beside the name), so this answers its
 * error rather than toasting it.
 */
export const makeKey = appRuntime.fn<{ readonly name: string; readonly models: ReadonlyArray<string> }>()(
  (input) =>
    Effect.gen(function* () {
      const store = yield* actionStore
      const client = yield* Api
      const name = yield* Schema.decodeUnknownEffect(KeyName)(input.name.trim())
      const made = yield* client.config.makeKey({ payload: new MakeKey({ name, models: input.models }) })
      store.set(newKeyAtom, Option.some(made))
      yield* Reactivity.invalidate(["keys"])
      say(store, `Made the key ${made.name}.`)
      return made
    }),
  concurrent,
)

export const revokeKey = act(
  (name: string, store) =>
    Effect.gen(function* () {
      const client = yield* Api
      yield* client.config.removeKey({ params: { name: KeyName.make(name) } })
      const shown = store.read(newKeyAtom)
      if (Option.isSome(shown) && shown.value.name === name) store.set(newKeyAtom, Option.none())
      yield* Reactivity.invalidate(["keys"])
      return { text: `${name} revoked.` }
    }),
  (name) => `Could not revoke ${name}: `,
)

export const dismissNewKey = Atom.writable<Option.Option<NewKey>, void>(
  (get) => get(newKeyAtom),
  (ctx) => ctx.set(newKeyAtom, Option.none()),
)

export const testNotifications = task(
  () =>
    Effect.gen(function* () {
      const client = yield* Api
      yield* client.notify.test()
      return { text: "Sent a test notice." }
    }),
  "The test notice did not go out: ",
)

/** Copies text, saying whether it worked. */
export const copy = act((input: { readonly text: string; readonly said?: string }) =>
  Effect.gen(function* () {
    const host = yield* Host
    const ok = yield* host.copy(input.text)
    return ok ? { text: input.said ?? "Copied." } : { text: "Copy did not work; select it instead.", error: true }
  }),
)

export const openExternal = act((url: string) =>
  Effect.gen(function* () {
    const host = yield* Host
    return (yield* host.openExternal(url)) ? {} : { text: "Could not open a browser.", error: true }
  }),
)

/** The browser's notification permission, read again after asking. */
export const permissionAtom = appRuntime.atom(
  Effect.gen(function* () {
    const host = yield* Host
    return yield* host.permission
  }),
)

/** Asks the browser to show notices as notifications. */
export const askNotifications = task((store) =>
  Effect.gen(function* () {
    const host = yield* Host
    const answer = yield* host.askPermission
    store.refresh(permissionAtom)
    return answer === "granted"
      ? { text: "This browser will notify you when something needs doing." }
      : answer === "denied"
        ? { text: "This browser will not show notifications from slopmax.", error: true }
        : {}
  }),
)

/** How the page looks, where its sidebar stands, and whether it posts notifications; loaded from the host at startup. */
export const prefsAtom = Atom.make<UiPrefs>(UiPrefs.defaults).pipe(Atom.keepAlive)

/** Whether the last show or hide of the sidebar was instant (the keyboard) rather than a slide. */
export const sidebarInstantAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * The owner key, typed into the web dashboard's gate: kept for this tab, and
 * every call carries it from now on. It is a plain write rather than an
 * action on the API's runtime, because the runtime is rebuilt around the new
 * key, and an action on it would run again each time it is.
 */
export const enterKey = Atom.writable<Option.Option<string>, string>(
  (get) => get(ownerKeyAtom),
  (ctx, key) => {
    const host = ctx.get(hostAtom)
    if (Option.isSome(host)) Effect.runSync(host.value.saveKey(key))
    ctx.set(keyRefusedAtom, false)
    ctx.set(tailnetRetryAtom, "none")
    ctx.set(accessAtom, "admin")
    ctx.set(machineAtom, Option.none())
    ctx.set(ownerKeyAtom, Option.some(key))
  },
)

/** What `/healthz` says of a request carrying the tailnet token; none when it did not answer, or not with JSON. */
const askHealth = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.get("/healthz").pipe(HttpClientRequest.bearerToken(tailnetToken)),
  )
  if (response.status !== 200) return Option.none<Health>()
  return Schema.decodeUnknownOption(Health)(yield* response.json)
}).pipe(Effect.orElseSucceed(() => Option.none<Health>()))

/**
 * Asks slopmax whether this machine's tailnet identity opens the web
 * dashboard without a key, for a page that holds none. When `/healthz` says
 * the request came over the tailnet and may view or administer, the page
 * holds the tailnet token for this tab (never in its storage) and keeps what
 * it may do; otherwise it answers false and the gate asks for the key.
 */
export const tailnetProbeAtom = keyCheckRuntime.atom((get) =>
  Effect.gen(function* () {
    const health = yield* askHealth
    const access = tailnetAccess(health)
    if (Option.isNone(access)) return false
    get.set(accessAtom, access.value)
    get.set(
      machineAtom,
      Option.flatMap(health, (h) => Option.fromUndefinedOr(h.machine)),
    )
    get.set(keyRefusedAtom, false)
    get.set(ownerKeyAtom, Option.some(tailnetToken))
    return true
  }),
)

/**
 * Asks slopmax whether it takes an owner key, with a cheap call carrying it,
 * before the gate keeps it. Fails with Unauthorized when it is refused.
 */
export const checkKey = keyCheckRuntime.fn<string>()((key) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(SlopmaxApi, {
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
    })
    yield* client.system.status()
  }),
)

/** Whether a failure is slopmax refusing the key. */
export const refusedKey = isUnauthorized

/** Shows or hides the sidebar: the button slides it, the keyboard moves it at once. */
export const toggleSidebar = appRuntime.fn<"button" | "keyboard">()(
  (via) =>
    Effect.gen(function* () {
      const store = yield* actionStore
      const host = yield* Host
      const prefs = store.read(prefsAtom)
      const sidebar = toggled(
        { hidden: prefs.sidebarHidden, width: prefs.sidebarWidth, instant: store.read(sidebarInstantAtom) },
        via,
      )
      store.set(sidebarInstantAtom, sidebar.instant)
      const next = new UiPrefs({ ...prefs, sidebarHidden: sidebar.hidden })
      store.set(prefsAtom, next)
      yield* host.savePrefs(next)
    }),
  concurrent,
)

/** Changes the preferences now and keeps them for next time. */
export const savePrefs = appRuntime.fn<Partial<UiPrefs>>()(
  (change) =>
    Effect.gen(function* () {
      const store = yield* actionStore
      const host = yield* Host
      const next = new UiPrefs({ ...store.read(prefsAtom), ...change })
      store.set(prefsAtom, next)
      yield* host.savePrefs(next)
    }),
  concurrent,
)

// --- Where the app is ---------------------------------------------------------------------

const readPage = (): Page => parsePage(location.hash)

/** The page the app is on, from the address's fragment. */
export const pageAtom = Atom.make((get): Page => {
  const onChange = () => get.setSelf(readPage())
  window.addEventListener("hashchange", onChange)
  get.addFinalizer(() => window.removeEventListener("hashchange", onChange))
  return readPage()
}).pipe(Atom.keepAlive)

/** Goes to a page. */
export const go = (page: Page): void => {
  location.hash = pageHash(page)
}
