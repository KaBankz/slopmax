// slopmax's own API, served in process by stub handlers over fixtures. It is
// the real SlopmaxApi (the same definition the daemon serves), so the app is
// built and tested against the contract itself before the daemon's handlers
// exist. Changes behave as the daemon's do (a pin pins, a removed account is
// gone) and each one sends a Status event, as the daemon does, so the app can
// be driven end to end: in tests, and by `bun dev.ts` for a browser or Electron.
import {
  AccountId,
  AccountView,
  BadRequest,
  Conflict,
  Condition,
  defaultSettings,
  Event,
  type HistoryRange,
  KeyInfo,
  LoginId,
  NewKey,
  Note,
  NotFound,
  NextView,
  providerFacts,
  RedeemResult,
  Report,
  Settings,
  settingsView,
  Summary,
  Totals,
  UpstreamFailed,
  Usage,
  Window,
  type AgentWiring,
  type Section,
} from "@slopmax/domain"
import {
  AccountAdded,
  AgentConnected,
  AgentDisconnected,
  ImportOutcome,
  ImportResult,
  InputErrors,
  LoginStarted,
  OwnerKey,
  SlopmaxApi,
  Stopping,
} from "@slopmax/domain/api"
import { MemoryFileSystem } from "@slopmax/test"
import { DateTime, Duration, Effect, Layer, PubSub, Redacted, Stream } from "effect"
import { Etag, FetchHttpClient, HttpClient, HttpPlatform, HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import {
  emptyReport,
  fixtureAgents,
  fixtureDoctor,
  fixtureHistory,
  fixtureKeys,
  fixtureReport,
  ownerKey,
  quietHistory,
  version,
} from "./fixtures.ts"

export interface StubOptions {
  /** The clock the fixtures are drawn against. */
  readonly now?: () => DateTime.Utc
  /** A busy slopmax, or one before any account was added. */
  readonly scenario?: "full" | "empty"
  /** The owner key the API asks for; none accepts any call, as the desktop's main process adds the key. */
  readonly key?: string | undefined
  /** How long each answer takes, so loading states can be seen. */
  readonly latency?: Duration.Input
}

/** One call the stub answered. */
export interface Call {
  readonly endpoint: string
  readonly payload?: unknown
}

export interface Stub {
  /** Answers a request as the daemon would, with no socket. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Sends an event to everyone watching the stream. */
  readonly publish: (event: Event) => void
  /** Every call answered, in order. */
  readonly calls: ReadonlyArray<Call>
  readonly report: () => Report
  /** Replaces the report, telling watchers. */
  readonly setReport: (report: Report) => void
  /** Makes the next call to an endpoint fail with this error, as the daemon would send it. */
  readonly failNext: (endpoint: string, error: Refusal) => void
  readonly dispose: () => Promise<void>
}

/** An error the API answers with, and its status. */
export type Refusal = BadRequest | UpstreamFailed | NotFound | Conflict

const statuses: { readonly [K in Refusal["_tag"]]: number } = {
  BadRequest: 400,
  NotFound: 404,
  Conflict: 409,
  UpstreamFailed: 502,
}

/** An account's notes with its priority's note set to `priority`. */
const withNotes = (account: AccountView, priority: number): ReadonlyArray<Note> => [
  ...account.notes.filter((note) => note._tag !== "Priority"),
  ...(priority === 0 ? [] : [Note.cases.Priority.make({ value: priority })]),
]

const keyNames = (keys: ReadonlyArray<KeyInfo>) => keys.map((key) => key.name)

export const makeStub = (options: StubOptions = {}): Stub => {
  const now = options.now ?? DateTime.nowUnsafe
  const scenario = options.scenario ?? "full"
  const latency = Effect.sleep(options.latency ?? Duration.zero)
  let report = scenario === "full" ? fixtureReport(now()) : emptyReport(now())
  let settings: Settings = defaultSettings(ownerKey)
  let keys: ReadonlyArray<KeyInfo> = scenario === "full" ? fixtureKeys() : []
  let agents: ReadonlyArray<AgentWiring> = fixtureAgents()
  const doctor: ReadonlyArray<Section> = fixtureDoctor()
  const calls: Array<Call> = []
  const failures = new Map<string, Refusal>()
  let logins = 0
  let accounts = 0
  const events = Effect.runSync(PubSub.unbounded<Event>())

  const publish = (event: Event) => {
    Effect.runSync(PubSub.publish(events, event))
  }
  const change = (next: Report): Report => {
    report = new Report({ ...next, generatedAt: now() })
    publish(Event.cases.Status.make({ report }))
    return report
  }
  const mapAccounts = (f: (account: AccountView) => AccountView): Report =>
    change(new Report({ ...report, accounts: report.accounts.map(f) }))
  const find = (id: string) => report.accounts.find((account) => account.id === id)

  /** Records a call, waits out the latency, and fails it if a test asked. */
  const answer = <A, E>(endpoint: string, payload: unknown, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      calls.push(payload === undefined ? { endpoint } : { endpoint, payload })
      yield* latency
      const failure = failures.get(endpoint)
      if (failure === undefined) return yield* effect
      failures.delete(endpoint)
      // Sent as the daemon encodes it, so the client decodes it into the endpoint's own error.
      return HttpServerResponse.jsonUnsafe(
        { _tag: failure._tag, message: failure.message, ...("what" in failure ? { what: failure.what } : {}) },
        { status: statuses[failure._tag] },
      )
    })

  const known = (id: string) => {
    const account = find(id)
    return account === undefined ? Effect.fail(NotFound.of({ what: `account ${id}` })) : Effect.succeed(account)
  }

  const System = HttpApiBuilder.group(SlopmaxApi, "system", (handlers) =>
    handlers
      .handle("status", () =>
        answer(
          "status",
          undefined,
          Effect.sync(() => report),
        ),
      )
      .handle("refresh", () =>
        answer(
          "refresh",
          undefined,
          Effect.sync(() => change(report)),
        ),
      )
      .handle("sync", () =>
        answer(
          "sync",
          undefined,
          Effect.sync(() => report),
        ),
      )
      .handle("shutdown", () => answer("shutdown", undefined, Effect.succeed(new Stopping({ status: "stopping" }))))
      .handle("doctor", () => answer("doctor", undefined, Effect.succeed(doctor))),
  )

  const Accounts = HttpApiBuilder.group(SlopmaxApi, "accounts", (handlers) =>
    handlers
      .handle("add", ({ payload }) =>
        answer(
          "add",
          payload,
          Effect.sync(() => {
            accounts += 1
            const provider = payload._tag === "Key" ? payload.provider : "compat"
            const added = new AccountView({
              id: AccountId.make(`${provider}-${String(accounts).padStart(8, "0")}`),
              provider,
              name: payload.label ?? (payload._tag === "Key" ? providerFacts[provider].title : payload.url),
              disabled: false,
              priority: 0,
              pinned: false,
              ...(payload._tag === "Endpoint" ? { endpoint: payload.url } : {}),
              models: payload._tag === "Endpoint" ? payload.models : [],
              sessions: 0,
              condition: Condition.cases.Ready.make({}),
              notes: [],
              windows: [],
              resets: [],
              served: Usage.zero,
            })
            return new AccountAdded({
              account: added,
              report: change(new Report({ ...report, accounts: [...report.accounts, added] })),
            })
          }),
        ),
      )
      .handle("update", ({ params, payload }) =>
        answer(
          "update",
          payload,
          Effect.map(known(params.id), () =>
            mapAccounts((account) => {
              if (account.id !== params.id) return account
              const disabled = payload.disabled ?? account.disabled
              const priority = payload.priority ?? account.priority
              const label = payload.label
              return new AccountView({
                ...account,
                disabled,
                priority,
                notes: withNotes(account, priority),
                name: label === undefined ? account.name : (label ?? account.email ?? account.id),
                condition: disabled
                  ? Condition.cases.Disabled.make({})
                  : account.condition._tag === "Disabled"
                    ? Condition.cases.Ready.make({})
                    : account.condition,
              })
            }),
          ),
        ),
      )
      .handle("pin", ({ params }) =>
        answer(
          "pin",
          params,
          Effect.map(known(params.id), (pinned) =>
            change(
              new Report({
                ...report,
                accounts: report.accounts.map((account) =>
                  account.provider === pinned.provider
                    ? new AccountView({ ...account, pinned: account.id === pinned.id })
                    : account,
                ),
                pools: report.pools.map((pool) =>
                  pool.provider === pinned.provider
                    ? {
                        ...pool,
                        next: new NextView({ account: pinned.id, reason: "pinned", why: "pinned for new sessions" }),
                      }
                    : pool,
                ),
              }),
            ),
          ),
        ),
      )
      .handle("unpinAll", () =>
        answer(
          "unpinAll",
          undefined,
          Effect.sync(() => mapAccounts((account) => new AccountView({ ...account, pinned: false }))),
        ),
      )
      .handle("own", ({ params }) =>
        answer(
          "own",
          params,
          Effect.map(known(params.id), () =>
            mapAccounts((account) => {
              if (account.id !== params.id) return account
              const { follows: _follows, ...rest } = account
              return new AccountView({ ...rest, notes: account.notes.filter((note) => note._tag !== "Follows") })
            }),
          ),
        ),
      )
      .handle("remove", ({ params }) =>
        answer(
          "remove",
          params,
          Effect.map(known(params.id), () =>
            change(new Report({ ...report, accounts: report.accounts.filter((account) => account.id !== params.id) })),
          ),
        ),
      )
      .handle("redeem", ({ params, payload }) =>
        answer(
          "redeem",
          payload,
          Effect.map(known(params.id), (account) => {
            if (account.resets.length === 0) return new RedeemResult({ outcome: "no-credit", report })
            const spent = payload.reset ?? account.resets[0]?.id
            const next = mapAccounts((a) =>
              a.id !== account.id
                ? a
                : new AccountView({
                    ...a,
                    resets: a.resets.filter((reset) => reset.id !== spent),
                    windows: a.windows.map((w) => Window.of(w.span, 0, undefined, w.model)),
                    notes: a.notes.flatMap((note): ReadonlyArray<Note> =>
                      note._tag !== "Resets"
                        ? [note]
                        : note.count > 1
                          ? [Note.cases.Resets.make({ count: note.count - 1 })]
                          : [],
                    ),
                  }),
            )
            return new RedeemResult({ outcome: "reset", report: next })
          }),
        ),
      )
      .handle("import", ({ payload }) =>
        answer(
          "import",
          payload,
          Effect.sync(() => {
            const first = report.accounts.find((account) => account.provider === "claude")
            const outcomes: Array<ImportOutcome> = [
              ...(first === undefined
                ? []
                : [
                    ImportOutcome.cases.Saved.make({
                      source: "claude-code",
                      origin: "~/.claude/.credentials.json",
                      account: first,
                      isNew: false,
                    }),
                  ]),
              ImportOutcome.cases.Failed.make({
                source: "cliproxyapi",
                origin: "~/.cli-proxy-api",
                message: "no logins there",
              }),
            ]
            return new ImportResult({ outcomes, report })
          }),
        ),
      ),
  )

  const Logins = HttpApiBuilder.group(SlopmaxApi, "logins", (handlers) =>
    handlers
      .handle("start", ({ payload }) =>
        answer(
          "login",
          payload,
          Effect.gen(function* () {
            logins += 1
            const id = LoginId.make(`login-${logins}`)
            const title = providerFacts[payload.provider].title
            // The daemon tells the steps as they happen, after it answers.
            yield* Effect.forkDetach(
              Effect.sleep("20 millis").pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    publish(
                      Event.cases.Login.make({
                        id,
                        event: payload.device
                          ? { _tag: "DeviceCode", url: "https://auth.openai.com/codex/device", code: "QX7F-29KD" }
                          : {
                              _tag: "Authorize",
                              title,
                              url: `https://${payload.provider === "claude" ? "claude.ai" : "auth.openai.com"}/oauth/authorize?client_id=slopmax&state=${id}`,
                              port: 54_545,
                              opened: false,
                            },
                      }),
                    ),
                  ),
                ),
              ),
            )
            return new LoginStarted({ id })
          }),
        ),
      )
      .handle("paste", ({ params, payload }) =>
        answer(
          "paste",
          payload,
          Effect.sync(() => {
            accounts += 1
            const added = new AccountView({
              id: AccountId.make(`claude-${String(accounts).padStart(8, "0")}`),
              provider: "claude",
              name: "new@studio.dev",
              email: "new@studio.dev",
              plan: "pro",
              disabled: false,
              priority: 0,
              pinned: false,
              models: [],
              sessions: 0,
              condition: Condition.cases.Ready.make({}),
              notes: [],
              windows: [],
              resets: [],
              served: Usage.zero,
            })
            change(new Report({ ...report, accounts: [...report.accounts, added] }))
            publish(Event.cases.Login.make({ id: params.id, event: { _tag: "Done", account: added, isNew: true } }))
          }),
        ),
      )
      .handle("cancel", ({ params }) => answer("cancel", params, Effect.void)),
  )

  const Config = HttpApiBuilder.group(SlopmaxApi, "config", (handlers) =>
    handlers
      .handle("settings", () =>
        answer(
          "settings",
          undefined,
          Effect.sync(() => settingsView(settings)),
        ),
      )
      .handle("change", ({ payload }) =>
        answer(
          "change",
          payload,
          Effect.sync(() => {
            settings = new Settings({ ...settings, ...payload })
            if (payload.strategy !== undefined) change(new Report({ ...report, strategy: payload.strategy }))
            return settingsView(settings)
          }),
        ),
      )
      .handle("keys", () =>
        answer(
          "keys",
          undefined,
          Effect.sync(() => keys),
        ),
      )
      .handle("makeKey", ({ payload }) =>
        answer(
          "makeKey",
          payload,
          keyNames(keys).includes(payload.name)
            ? Effect.fail(new Conflict({ message: `there is already a key named ${payload.name}` }))
            : Effect.sync(() => {
                keys = [...keys, new KeyInfo({ name: payload.name, models: payload.models })]
                return new NewKey({
                  name: payload.name,
                  key: `sm-${payload.name}-4fJ0c2Qe9bT1kZ8wXyL3mN5pR7sV6uA0dH2gK4jW`,
                  models: payload.models,
                })
              }),
        ),
      )
      .handle("removeKey", ({ params }) =>
        answer(
          "removeKey",
          params,
          keyNames(keys).includes(params.name)
            ? Effect.sync(() => {
                keys = keys.filter((key) => key.name !== params.name)
                return keys
              })
            : Effect.fail(NotFound.of({ what: `key ${JSON.stringify(params.name)}` })),
        ),
      ),
  )

  const Agents = HttpApiBuilder.group(SlopmaxApi, "agents", (handlers) =>
    handlers
      .handle("list", () =>
        answer(
          "agents",
          undefined,
          Effect.sync(() => agents),
        ),
      )
      .handle("connect", ({ params }) =>
        answer(
          "connect",
          params,
          Effect.sync(() => {
            agents = agents.map((agent) =>
              agent.id === params.id ? { ...agent, wired: true, wiredTo: "http://127.0.0.1:7567" } : agent,
            )
            const path = agents.find((agent) => agent.id === params.id)?.configPath ?? ""
            return new AgentConnected({ path, note: "Restart it to pick up the change." })
          }),
        ),
      )
      .handle("disconnect", ({ params }) =>
        answer(
          "disconnect",
          params,
          Effect.sync(() => {
            agents = agents.map((agent) => {
              if (agent.id !== params.id) return agent
              const { wiredTo: _wiredTo, ...rest } = agent
              return { ...rest, wired: false }
            })
            return new AgentDisconnected({ path: agents.find((agent) => agent.id === params.id)?.configPath ?? "" })
          }),
        ),
      ),
  )

  const history = (range: HistoryRange) => (scenario === "full" ? fixtureHistory(range, now()) : quietHistory(range))

  const UsageGroup = HttpApiBuilder.group(SlopmaxApi, "usage", (handlers) =>
    handlers
      .handle("summary", ({ query }) =>
        answer(
          "summary",
          query,
          Effect.sync(
            () => new Summary({ range: query.range, by: query.by, since: now(), rows: [], total: Totals.zero }),
          ),
        ),
      )
      .handle("history", ({ query }) =>
        answer(
          "history",
          query,
          Effect.sync(() => history(query.range)),
        ),
      ),
  )

  const Events = HttpApiBuilder.group(SlopmaxApi, "events", (handlers) =>
    handlers.handle("watch", () =>
      answer(
        "events",
        undefined,
        Effect.sync(() =>
          Stream.concat(
            Stream.make(Event.cases.Hello.make({ version }), Event.cases.Status.make({ report })),
            Stream.fromPubSub(events),
          ),
        ),
      ),
    ),
  )

  const Notify = HttpApiBuilder.group(SlopmaxApi, "notify", (handlers) =>
    handlers.handle("test", () => answer("notifyTest", undefined, Effect.void)),
  )

  const owner =
    options.key === undefined
      ? Layer.succeed(OwnerKey, { bearer: (effect) => effect, header: (effect) => effect })
      : OwnerKey.layer(Effect.succeed(Redacted.make(options.key)))
  const platform = Layer.mergeAll(HttpPlatform.layer, Etag.layer).pipe(Layer.provideMerge(MemoryFileSystem.layer))
  const live = HttpApiBuilder.layer(SlopmaxApi).pipe(
    Layer.provide(Layer.mergeAll(System, Accounts, Logins, Config, Agents, UsageGroup, Events, Notify)),
    Layer.provide([owner, InputErrors.layer]),
    Layer.provide(platform),
  )
  const { handler, dispose } = HttpRouter.toWebHandler(live, { disableLogger: true })

  return {
    fetch: (request) => handler(request),
    publish,
    calls,
    report: () => report,
    setReport: (next) => {
      change(next)
    },
    failNext: (endpoint, error) => {
      failures.set(endpoint, error)
    },
    dispose,
  }
}

/** The page's way out to the stub: `fetch` answered in process. */
export const stubTransport = (stub: Stub): Layer.Layer<HttpClient.HttpClient> => {
  const answer = (input: string | URL | Request, init?: RequestInit) => stub.fetch(new Request(input, init))
  return FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, Object.assign(answer, { preconnect: fetch.preconnect }))),
  )
}
