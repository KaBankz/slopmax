// The desktop app apart from any UI toolkit: what it shows and what it can
// do. Like the CLI, it asks `@slopmax/core` and shows the answer, so the
// app, the CLI, and the dashboard behave alike. This module adds what a
// window needs on top: a live `Snapshot` to draw, and actions that run in
// the background and report back through it.
//
// A UI draws the latest snapshot (`view` works out the rows, gauges, and
// menu bar line, `history` the charts of past use) and calls `App`'s
// methods, none of which block: each starts its work in the app's scope and
// hands back the fiber, which a UI may await or leave.
import { dirname } from "node:path"
import process from "node:process"

import {
  Cause,
  Clock,
  Config as EffectConfig,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Result,
  type Scope,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from "effect"

import {
  Account,
  account as accounts,
  agent,
  auth,
  background,
  type Config,
  config as configs,
  Config as Configs,
  doctor,
  error,
  fsx,
  history,
  Home,
  import_,
  log,
  net,
  paths,
  type provider,
  type ProviderId,
  ProviderId as Providers,
  report,
  service,
  Store,
  text as texts,
  time,
} from "@slopmax/core"

import { Alert, nudges, Told } from "./alerts.ts"
import * as view from "./view.ts"

type Timestamp = time.Timestamp
const { Timestamp } = time
type Failure = error.Failure
const { Failure } = error

/** How often the app asks how things stand. */
const POLL = "2 seconds"
/** How often it rereads what changes rarely: the agents' configs and the login service. */
const SLOW_POLL_MS = 15_000
/** How long a notice that something worked stays; errors stay until dismissed. */
const NOTICE_FOR_MS = 6_000

/** Everything a window shows, as of the last look. */
export interface Snapshot {
  readonly proxy: Proxy
  /** Where agents reach the proxy. */
  readonly address: string
  /** The accounts and pools: from the running proxy, or from disk while none runs. */
  readonly report: report.Report | undefined
  readonly agents: ReadonlyArray<AgentStatus>
  /** The login service, where this system has one. */
  readonly service: service.Status | undefined
  /** The sign-in in progress. */
  readonly signIn: SignIn | undefined
  /** How the last action went. */
  readonly notice: Notice | undefined
  /** What went through slopmax, once a UI asks with `App.loadHistory`. */
  readonly history: history.History | undefined
  /**
   * Today's, apart from that, once a UI asks with `App.loadToday`: for
   * summaries that show today whatever range the charts show.
   */
  readonly today: history.History | undefined
  /** The account a reset credit is being redeemed on. */
  readonly redeeming: string | undefined
  /** The configuration as config.toml has it now, which the Settings page changes with `App.set`. */
  readonly config: Config
  /** Whether nudges are posted as notifications. */
  readonly notifications: boolean
  /** A client key just made, shown once. */
  readonly newKey: NewKey | undefined
  /** What the doctor found, once asked with `App.checkSetup`. */
  readonly doctor: Doctor
}

/** A client key just made: its name and the key, which is not shown again. */
export interface NewKey {
  readonly name: string
  readonly key: string
}

/** The setup checks, as far as they have gone. */
export type Doctor =
  | { readonly _tag: "NotRun" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Done"; readonly sections: ReadonlyArray<doctor.Section> }
  | { readonly _tag: "Failed"; readonly message: string }

export const Doctor = {
  NotRun: { _tag: "NotRun" } satisfies Doctor,
  Running: { _tag: "Running" } satisfies Doctor,
  Done: (sections: ReadonlyArray<doctor.Section>): Doctor => ({ _tag: "Done", sections }),
  Failed: (message: string): Doctor => ({ _tag: "Failed", message }),
} as const

/** A compatible endpoint to add: an API that speaks one of the formats slopmax does, at `url`. */
export interface NewEndpoint {
  readonly url: string
  readonly dialect: accounts.Endpoint["dialect"]
  /** The models it serves, as patterns; empty, any. */
  readonly models: ReadonlyArray<string>
  readonly key: string
  /** What to call it; else its address. */
  readonly label: string | undefined
}

/** A setting the app changes while the proxy runs, which it applies at once. */
export type Setting =
  /** How a new session picks its account. */
  | { readonly _tag: "Strategy"; readonly value: configs.Strategy }
  /** Whether a session keeps the account it started on. */
  | { readonly _tag: "SessionAffinity"; readonly value: boolean }
  /** Whether a reset credit is redeemed before it would expire unused. */
  | { readonly _tag: "RedeemExpiringCredits"; readonly value: boolean }
  /** Whether one is redeemed once every account is spent. */
  | { readonly _tag: "RedeemWhenExhausted"; readonly value: boolean }
  /** Idle minutes before a session's account is forgotten. */
  | { readonly _tag: "SessionTtlMins"; readonly value: number }
  /** Whether idle ChatGPT accounts' windows are started as they reset. */
  | { readonly _tag: "WarmWindows"; readonly value: boolean }
  /** Whether API keys take over once subscriptions are limited. */
  | { readonly _tag: "PaidOverflow"; readonly value: boolean }
  /** Minutes between usage polls; 0 turns them off. */
  | { readonly _tag: "PollMins"; readonly value: number }

export const Setting = {
  Strategy: (value: configs.Strategy): Setting => ({ _tag: "Strategy", value }),
  SessionAffinity: (value: boolean): Setting => ({ _tag: "SessionAffinity", value }),
  RedeemExpiringCredits: (value: boolean): Setting => ({ _tag: "RedeemExpiringCredits", value }),
  RedeemWhenExhausted: (value: boolean): Setting => ({ _tag: "RedeemWhenExhausted", value }),
  SessionTtlMins: (value: number): Setting => ({ _tag: "SessionTtlMins", value }),
  WarmWindows: (value: boolean): Setting => ({ _tag: "WarmWindows", value }),
  PaidOverflow: (value: boolean): Setting => ({ _tag: "PaidOverflow", value }),
  PollMins: (value: number): Setting => ({ _tag: "PollMins", value }),

  /** Its key in config.toml. */
  key: (self: Setting): string => {
    switch (self._tag) {
      case "Strategy":
        return "strategy"
      case "SessionAffinity":
        return "session_affinity"
      case "RedeemExpiringCredits":
        return "redeem_expiring_credits"
      case "RedeemWhenExhausted":
        return "redeem_when_exhausted"
      case "SessionTtlMins":
        return "session_ttl_mins"
      case "WarmWindows":
        return "warm_windows"
      case "PaidOverflow":
        return "paid_overflow"
      case "PollMins":
        return "poll_mins"
    }
  },

  /** Its value as `slopmax config` takes it. */
  value: (self: Setting): string => String(self.value),

  /**
   * Writes it into the config at `path`, keeping the file's comments, and
   * returns the config that makes. It is checked as `slopmax config`
   * checks it.
   */
  write: (self: Setting, path: string): Effect.Effect<Config, Failure> => {
    const checked = configs.liveValue(Setting.key(self), Setting.value(self))
    if (checked._tag === "Failure") return Effect.fail(new Failure({ message: checked.failure }))
    return Configs.set(path, [checked.success])
  },
} as const

/** The background proxy, as the app last saw it. */
export type Proxy =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Running"; readonly version: string }
  | { readonly _tag: "Stopped" }

export const Proxy = {
  Checking: { _tag: "Checking" } satisfies Proxy,
  Starting: { _tag: "Starting" } satisfies Proxy,
  Running: (version: string): Proxy => ({ _tag: "Running", version }),
  Stopped: { _tag: "Stopped" } satisfies Proxy,
} as const

export interface AgentStatus {
  readonly id: string
  readonly title: string
  readonly wiring: agent.Wiring
}

/** A sign-in in progress. */
export interface SignIn {
  readonly provider: ProviderId
  readonly step: Step
  /** Notes while waiting, such as a rejected paste. */
  readonly notes: ReadonlyArray<string>
}

export type Step =
  | { readonly _tag: "Starting" }
  /** Authorize in the browser at `url`, which was `opened` if it could be. */
  | { readonly _tag: "Authorize"; readonly url: string; readonly opened: boolean }
  /** Enter `code` at `url`. */
  | { readonly _tag: "DeviceCode"; readonly url: string; readonly code: string }

export const Step = {
  Starting: { _tag: "Starting" } satisfies Step,
  Authorize: (url: string, opened: boolean): Step => ({ _tag: "Authorize", url, opened }),
  DeviceCode: (url: string, code: string): Step => ({ _tag: "DeviceCode", url, code }),
} as const

export interface Notice {
  readonly text: string
  readonly error: boolean
  /** When it was shown, on the `Clock`. */
  readonly shown: number
}

/** Work an action started in the app's scope; awaiting it waits for the action to finish. */
export type Task = Fiber.Fiber<void>

/** How the app starts. */
export interface Options {
  /**
   * Whether nudges are handed to the UI (see `App.alerts`) and marked as
   * told; off, as while drawing the pages to images, neither happens.
   */
  readonly notify: boolean
  /** Finds the slopmax CLI that runs the proxy, or none; run once, as the app starts. */
  readonly cli: Effect.Effect<string | undefined>
}

/** The app's state and actions. */
export interface AppShape {
  /** The configuration the app started with, which says where the proxy listens. The snapshot's `config` follows changes to config.toml. */
  readonly config: Config
  /** Changes to the snapshot, which a UI redraws on: the current one, then each change. */
  readonly changes: Stream.Stream<Snapshot>
  readonly snapshot: Effect.Effect<Snapshot>
  /** The scope the app's background work runs in, for a UI's own tasks; it closes with the app. */
  readonly scope: Scope.Scope

  /** Signs in to a subscription in the browser. */
  readonly signIn: (provider: ProviderId) => Effect.Effect<Task>
  /** Connects an API key. */
  readonly addKey: (provider: ProviderId, key: string) => Effect.Effect<Task>
  /** Connects a compatible endpoint; its key is checked before it is saved. */
  readonly addEndpoint: (endpoint: NewEndpoint) => Effect.Effect<Task>
  /** Makes a client key named `name`, held to `models` (patterns) if any are given, and shows it once. */
  readonly addClientKey: (name: string, models: ReadonlyArray<string>) => Effect.Effect<Task>
  /** Revokes the client key named `name`; whatever used it is refused from now on. */
  readonly revokeKey: (name: string) => Effect.Effect<Task>
  /** Forgets the key just made, once it has been copied. */
  readonly dismissNewKey: Effect.Effect<Task>
  /** Runs the setup checks `slopmax doctor` runs. */
  readonly checkSetup: Effect.Effect<Task>
  /** Has slopmax refresh an imported login itself, rather than follow the tool it came from. */
  readonly own: (id: string) => Effect.Effect<Task>
  /** Hands a redirect address pasted by hand to the sign-in in progress, for a browser on another machine. */
  readonly paste: (address: string) => Effect.Effect<Task>
  readonly cancelSignIn: Effect.Effect<Task>
  /** Imports the logins Claude Code, Codex, and CLIProxyAPI already have. */
  readonly import: Effect.Effect<Task>
  /** Prefers an account for its provider's new sessions. */
  readonly pin: (id: string) => Effect.Effect<Task>
  /** Lets slopmax choose every provider's accounts again. */
  readonly unpinAll: Effect.Effect<Task>
  readonly setDisabled: (id: string, disabled: boolean) => Effect.Effect<Task>
  readonly setPriority: (id: string, priority: number) => Effect.Effect<Task>
  /** Renames an account; undefined goes back to its email or key. */
  readonly rename: (id: string, label: string | undefined) => Effect.Effect<Task>
  readonly remove: (id: string) => Effect.Effect<Task>
  /** Points an agent's own config at slopmax. */
  readonly connectAgent: (id: string) => Effect.Effect<Task>
  /** Restores what connecting an agent replaced. */
  readonly disconnectAgent: (id: string) => Effect.Effect<Task>
  readonly startProxy: Effect.Effect<Task>
  readonly stopProxy: Effect.Effect<Task>
  /** Runs the proxy as a service that starts at login. */
  readonly installService: Effect.Effect<Task>
  /** Stops running the proxy as a login service, then runs it as the app does, since removing the service stops it. */
  readonly uninstallService: Effect.Effect<Task>
  /**
   * Redeems a reset credit on account `id`, the soonest to expire, which
   * clears its usage windows at once. The running proxy redeems it, so it
   * knows at once.
   */
  readonly redeem: (id: string) => Effect.Effect<Task>
  /** Changes a setting in config.toml and has the proxy apply it at once. */
  readonly set: (setting: Setting) => Effect.Effect<Task>
  /**
   * The nudges to post as notifications, as they come, while they are on;
   * once, for the UI that posts them.
   */
  readonly alerts: Effect.Effect<Queue.Dequeue<Alert> | undefined>
  /** Turns notifications on or off, for this and later runs. */
  readonly setNotifications: (on: boolean) => Effect.Effect<Task>
  /** Polls every account's usage now. */
  readonly refresh: Effect.Effect<Task>
  /** Reads the ledger over `range` into the snapshot's `history`. Accounts take the names the last report gave them. */
  readonly loadHistory: (range: history.Range) => Effect.Effect<Task>
  /** Reads today's ledger into the snapshot's `today`. */
  readonly loadToday: Effect.Effect<Task>
  /** Opens the web dashboard in the browser. */
  readonly openDashboard: Effect.Effect<Task>
  readonly dismissNotice: Effect.Effect<Task>
}

/**
 * Loads the configuration, starts the proxy if none is running, and begins
 * watching it, handing nudges to the UI to post (see `alerts`). Its
 * background work stops when the scope closes.
 */
export const start = Effect.fn("App.start")(function* (options: Options) {
  const config = yield* Configs.load()
  yield* Configs.apply(config)
  const scope = yield* Effect.scope
  const home = yield* Home.current
  const told = yield* Told.load(Told.path(home))
  const store = yield* Store.open
  const daemon = yield* background.Daemon.make(config)
  // Found once, as the app starts, as the Rust's `bundled_cli()` is.
  const cliPath = yield* options.cli
  const alerts = yield* Queue.unbounded<Alert>()
  const state = yield* SubscriptionRef.make<Snapshot>({
    proxy: Proxy.Checking,
    address: Configs.baseUrl(config),
    report: undefined,
    agents: [],
    service: undefined,
    signIn: undefined,
    notice: undefined,
    history: undefined,
    today: undefined,
    redeeming: undefined,
    config,
    notifications: told.enabled,
    newKey: undefined,
    doctor: Doctor.NotRun,
  })
  // Wakes the watcher for a fresh look, holding one wake at most; `full`
  // rereads the slow parts too.
  const look = yield* Queue.dropping<void>(1)
  const shared: Shared = {
    config,
    // The nudges told, and whether to tell them; none while the app posts nothing.
    told: options.notify ? told : undefined,
    telling: yield* Semaphore.make(1),
    alerts,
    heard: false,
    home,
    store,
    daemon,
    cli: cliPath,
    state,
    paste: undefined,
    signIn: undefined,
    look,
    full: true,
  }
  const idle = yield* Effect.forkIn(Effect.void, scope)
  const spawn = (work: Effect.Effect<void>): Effect.Effect<Task> => Effect.forkIn(work, scope)
  // Runs `run` now, in the caller, for the parts of an action that are only
  // a change to the snapshot.
  const now = (run: Effect.Effect<void>): Effect.Effect<Task> => Effect.as(run, idle)

  yield* spawn(watchOver(shared))
  yield* spawn(startProxy(shared))

  const act = (action: Effect.Effect<string, Failure>): Effect.Effect<Task> => spawn(actOn(shared, action))
  const change = (id: string, f: (account: Account) => Effect.Effect<string, Failure>): Effect.Effect<Task> =>
    act(
      Effect.gen(function* () {
        const account = yield* store.get(id)
        if (account === undefined) return yield* error.fail(`account ${id} is gone`)
        return yield* f(account)
      }),
    )

  const cancelSignIn = Effect.gen(function* () {
    const task = shared.signIn
    shared.signIn = undefined
    if (task !== undefined) yield* Fiber.interrupt(task)
    const paste = shared.paste
    shared.paste = undefined
    if (paste !== undefined) yield* Queue.end(paste)
    yield* update(shared, (s) => ({ ...s, signIn: undefined }))
  })

  const connect = (provider: ProviderId, label: string | undefined, login: auth.LoginOptions): Effect.Effect<Task> =>
    Effect.gen(function* () {
      yield* cancelSignIn
      const pasted = yield* Queue.unbounded<string, Cause.Done>()
      shared.paste = pasted
      // The core tells a sign-in's events as they happen; they move the
      // snapshot along in order, from a queue.
      const events = yield* Queue.unbounded<auth.LoginEvent>()
      const prompt = auth.Prompt.make((event) => {
        Queue.offerUnsafe(events, event)
      }).withPasted(pasted)
      yield* update(shared, (s) => ({ ...s, notice: undefined, signIn: { provider, step: Step.Starting, notes: [] } }))
      const task = yield* spawn(
        Effect.gen(function* () {
          const moving = yield* Effect.forkChild(
            Effect.forever(Effect.flatMap(Queue.take(events), (event) => update(shared, (s) => progress(s, event)))),
          )
          const result = yield* Effect.result(auth.connect(store, provider, label, login, prompt))
          yield* Fiber.interrupt(moving)
          if (shared.paste === pasted) shared.paste = undefined
          yield* Queue.end(pasted)
          yield* update(shared, (s) => ({ ...s, signIn: undefined }))
          if (result._tag === "Success") {
            const [account, created] = result.success
            yield* tell(shared, `${created ? "Connected" : "Updated"} ${Account.name(account)}.`, false)
          } else {
            yield* tell(shared, `Sign-in failed: ${error.chain(result.failure)}`, true)
          }
          yield* sync(shared)
        }),
      )
      shared.signIn = task
      return task
    })

  const load = (range: history.Range, keep: (s: Snapshot, h: history.History) => Snapshot): Effect.Effect<Task> =>
    spawn(
      Effect.gen(function* () {
        const snapshot = yield* SubscriptionRef.get(state)
        const names = new Map((snapshot.report?.accounts ?? []).map((a) => [a.id, a.name] as const))
        // The plans' prices as config.toml has it now.
        const prices = history.Prices.of(snapshot.config)
        const loaded = yield* Effect.option(history.load(home, range, yield* Timestamp.now, prices, names))
        if (Option.isSome(loaded)) yield* update(shared, (s) => keep(s, loaded.value))
      }),
    )

  const app: AppShape = {
    config,
    changes: SubscriptionRef.changes(state),
    snapshot: SubscriptionRef.get(state),
    scope,

    signIn: (provider) => connect(provider, undefined, auth.LoginOptions.default()),

    addKey: (provider, key) => connect(provider, undefined, { ...auth.LoginOptions.default(), key }),

    addEndpoint: (endpoint) =>
      connect("compat", endpoint.label, {
        ...auth.LoginOptions.default(),
        key: endpoint.key,
        endpoint: {
          baseUrl: texts.trim(endpoint.url).replace(/\/+$/, ""),
          dialect: endpoint.dialect,
          models: [...endpoint.models],
        },
      }),

    addClientKey: (name, models) =>
      act(
        Effect.gen(function* () {
          const trimmed = texts.trim(name)
          const key = yield* Configs.addKey(home.config(), trimmed, models)
          const current = adopt(config, yield* Configs.loadFrom(home.config()))
          yield* update(shared, (s) => ({ ...s, config: current, newKey: { name: trimmed, key } }))
          return `Made the key ${trimmed}.`
        }),
      ),

    revokeKey: (name) =>
      act(
        Effect.gen(function* () {
          if (!(yield* Configs.removeKey(home.config(), name)))
            return yield* error.fail(`there is no key named ${name}`)
          const current = adopt(config, yield* Configs.loadFrom(home.config()))
          yield* update(shared, (s) => ({
            ...s,
            config: current,
            newKey: s.newKey?.name === name ? undefined : s.newKey,
          }))
          return `Revoked the key ${name}.`
        }),
      ),

    dismissNewKey: now(update(shared, (s) => ({ ...s, newKey: undefined }))),

    checkSetup: Effect.gen(function* () {
      yield* update(shared, (s) => ({ ...s, doctor: Doctor.Running }))
      return yield* spawn(
        Effect.gen(function* () {
          const current = (yield* SubscriptionRef.get(state)).config
          const found = yield* doctor.check(current, store).pipe(
            Effect.match({
              onSuccess: Doctor.Done,
              onFailure: (e) => Doctor.Failed(error.chain(e)),
            }),
          )
          yield* update(shared, (s) => ({ ...s, doctor: found }))
        }),
      )
    }),

    own: (id) =>
      change(id, (account) =>
        Effect.map(
          store.update(account.id, (a) => accounts.without(a, "link")),
          (a) => `slopmax now refreshes ${Account.name(a)} itself.`,
        ),
      ),

    paste: (address) =>
      now(
        Effect.suspend(() =>
          shared.paste === undefined ? Effect.void : Effect.asVoid(Queue.offer(shared.paste, address)),
        ),
      ),

    cancelSignIn: now(cancelSignIn),

    import: spawn(
      Effect.gen(function* () {
        const http = yield* auth.httpClient(new net.Origins())
        const found = yield* import_.discover(http, "all")
        const saved = yield* import_.save(store, found, false)
        const imported = saved.filter((s) => s.account._tag === "Success").length
        const text =
          saved.length === 0
            ? "No logins found to import."
            : imported === saved.length
              ? `Imported ${countAccounts(imported)}.`
              : `Imported ${countAccounts(imported)} of ${saved.length} logins found.`
        yield* tell(shared, text, false)
        yield* sync(shared)
      }),
    ),

    pin: (id) =>
      change(id, (account) =>
        Effect.as(
          accounts.pin(home, account),
          `New ${account.provider} sessions will use ${Account.name(account)} while it has quota.`,
        ),
      ),

    unpinAll: act(Effect.as(accounts.unpinAll(home), "slopmax will choose accounts automatically.")),

    setDisabled: (id, disabled) =>
      change(id, (account) =>
        Effect.map(
          store.update(account.id, (a) => ({ ...a, disabled })),
          (a) => `${disabled ? "Disabled" : "Enabled"} ${Account.name(a)}.`,
        ),
      ),

    setPriority: (id, priority) =>
      change(id, (account) =>
        Effect.map(
          store.update(account.id, (a) => ({ ...a, priority })),
          (a) => `${Account.name(a)} now has priority ${priority}.`,
        ),
      ),

    rename: (id, label) =>
      change(id, (account) =>
        Effect.map(
          store.update(account.id, (a) => (label === undefined ? accounts.without(a, "label") : { ...a, label })),
          (a) => `Renamed it ${Account.name(a)}.`,
        ),
      ),

    remove: (id) =>
      change(id, (account) => Effect.as(accounts.forget(store, home, account), `Removed ${Account.name(account)}.`)),

    connectAgent: (id) => {
      const found = agent.find(id)
      if (found === undefined) return Effect.succeed(idle)
      return act(Effect.as(agent.setup(found, config), `${found.title} now uses slopmax. ${found.setupNote}`))
    },

    disconnectAgent: (id) => {
      const found = agent.find(id)
      if (found === undefined) return Effect.succeed(idle)
      return act(Effect.as(agent.undo(found), `${found.title} is back to its own setup.`))
    },

    startProxy: spawn(startProxy(shared)),

    stopProxy: spawn(
      Effect.gen(function* () {
        const stopped = yield* Effect.result(background.stop(config))
        if (stopped._tag === "Success") yield* tell(shared, "Stopped the proxy.", false)
        else yield* tell(shared, `Could not stop the proxy: ${error.chain(stopped.failure)}`, true)
        yield* lookAgain(shared, true)
      }),
    ),

    installService: spawn(
      Effect.gen(function* () {
        const installed = yield* Effect.result(
          Effect.gen(function* () {
            const manager = yield* service.detect
            if (manager === undefined) return yield* error.fail("this system has no service manager")
            const cli = yield* cliOf(shared)
            return yield* background.installService(config, manager, cli)
          }),
        )
        if (installed._tag === "Success") yield* tell(shared, "slopmax now starts at login.", false)
        else yield* tell(shared, `Could not install the service: ${error.chain(installed.failure)}`, true)
        yield* lookAgain(shared, true)
      }),
    ),

    uninstallService: spawn(
      Effect.gen(function* () {
        const removed = yield* Effect.result(
          Effect.gen(function* () {
            const manager = yield* service.detect
            if (manager === undefined) return yield* error.fail("this system has no service manager")
            return yield* service.uninstall(manager)
          }),
        )
        if (removed._tag === "Success") yield* tell(shared, "slopmax no longer starts at login.", false)
        else yield* tell(shared, `Could not remove the service: ${error.chain(removed.failure)}`, true)
        yield* startProxy(shared)
      }),
    ),

    redeem: (id) =>
      Effect.gen(function* () {
        yield* update(shared, (s) => ({ ...s, redeeming: id }))
        return yield* spawn(
          Effect.gen(function* () {
            const found = (yield* SubscriptionRef.get(state)).report?.accounts.find((a) => a.id === id)
            const name = found?.name ?? id
            const title = found === undefined ? "Its provider" : Providers.spec(found.provider).title
            const result = yield* Effect.result(daemon.redeem(id))
            yield* update(shared, (s) => ({ ...s, redeeming: undefined }))
            if (result._tag === "Failure") {
              return yield* tell(shared, `Could not redeem a limit reset: ${error.chain(result.failure)}`, true)
            }
            const [outcome, latest] = result.success
            yield* update(shared, (s) => ({ ...s, report: latest }))
            yield* tell(shared, redeemed(outcome, name, title), outcome === "no_credit")
          }),
        )
      }),

    set: (setting) =>
      act(
        Effect.gen(function* () {
          const written = yield* Setting.write(setting, home.config())
          const current = adopt(config, written)
          yield* update(shared, (s) => ({ ...s, config: current }))
          return view.settingChanged(setting)
        }),
      ),

    alerts: Effect.sync(() => {
      if (shared.heard) return undefined
      shared.heard = true
      return alerts
    }),

    setNotifications: (on) =>
      now(
        Effect.gen(function* () {
          yield* shared.telling.withPermit(
            Effect.suspend(() => {
              if (shared.told === undefined) return Effect.void
              shared.told = { ...shared.told, enabled: on }
              return Told.save(shared.told, Told.path(home))
            }),
          )
          yield* update(shared, (s) => ({ ...s, notifications: on }))
        }),
      ),

    refresh: spawn(
      Effect.gen(function* () {
        const latest = yield* daemon.report(true)
        if (latest !== undefined) yield* update(shared, (s) => ({ ...s, report: latest }))
      }),
    ),

    loadHistory: (range) => load(range, (s, h) => ({ ...s, history: h })),

    loadToday: load("today", (s, h) => ({ ...s, today: h })),

    openDashboard: spawn(
      Effect.gen(function* () {
        if (!(yield* auth.callback.openBrowser(Configs.dashboardUrl(config)))) {
          yield* tell(shared, "Could not open a browser.", true)
        }
      }),
    ),

    dismissNotice: now(update(shared, (s) => ({ ...s, notice: undefined }))),
  }
  return app
})

/** What a redemption did, in a sentence. */
const redeemed = (outcome: provider.credits.Outcome, name: string, title: string): string => {
  switch (outcome) {
    case "reset":
      return `Reset the usage windows on ${name}.`
    case "nothing_to_reset":
      return `${name} had nothing to reset yet, so the limit reset was kept.`
    case "no_credit":
      return `${name} has no limit reset left.`
    case "already_redeemed":
      return "That limit reset was already used."
    case "declined":
      return `${title} would not use a limit reset on ${name} right now, so it was kept.`
  }
}

/** The app as a service: started when its layer is built, stopped when the layer's scope closes. */
export class App extends Context.Service<App, AppShape>()("@slopmax/app/App", {
  make: Effect.suspend(() => start(defaults())),
}) {
  static readonly layer = Layer.effect(App, App.make)

  /** As `layer`, started with `options`. */
  static readonly layerWith = (options: Options): Layer.Layer<App, Failure> => Layer.effect(App, start(options))
}

/**
 * How the app starts by default: posting nudges, with the CLI it runs the
 * proxy with being this program when it is slopmax itself (the desktop's
 * engine is `slopmax app-host`), else the one shipped beside it or on PATH.
 */
export const defaults = (): Options => ({
  notify: true,
  cli: background.currentExe.pipe(Effect.catch(() => bundledCli)),
})

// What the background work shares. Single-threaded, so plain fields stand
// where the Rust holds mutexes.
interface Shared {
  readonly config: Config
  told: Told | undefined
  /** Held while `told` is read, changed, and saved, as the Rust's mutex is. */
  readonly telling: Semaphore.Semaphore
  readonly alerts: Queue.Queue<Alert>
  /** Whether a UI took the alerts. */
  heard: boolean
  readonly home: Home
  readonly store: Store
  readonly daemon: background.Daemon
  readonly cli: string | undefined
  readonly state: SubscriptionRef.SubscriptionRef<Snapshot>
  /** Hands redirect addresses pasted by hand to the sign-in in progress. */
  paste: Queue.Queue<string, Cause.Done> | undefined
  signIn: Task | undefined
  readonly look: Queue.Queue<void>
  full: boolean
}

const update = (shared: Shared, change: (s: Snapshot) => Snapshot): Effect.Effect<void> =>
  SubscriptionRef.update(shared.state, change)

const tell = (shared: Shared, text: string, bad: boolean): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (shown) =>
    update(shared, (s) => ({ ...s, notice: { text, error: bad, shown } })),
  )

/** Asks for a fresh look now; `full` rereads the slow parts too. */
const lookAgain = (shared: Shared, full: boolean): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (full) shared.full = true
    return Effect.asVoid(Queue.offer(shared.look, undefined))
  })

/** Has the proxy apply changes made on disk, and shows the result. */
const sync = Effect.fn("App.sync")(function* (shared: Shared) {
  const latest = yield* shared.daemon.sync
  if (latest !== undefined) yield* update(shared, (s) => ({ ...s, report: latest }))
  else yield* lookAgain(shared, false)
  yield* lookAgain(shared, true)
})

const cliOf = (shared: Shared): Effect.Effect<string, Failure> =>
  shared.cli === undefined
    ? error.fail("cannot find the slopmax command line, which the app runs the proxy with; reinstall the app")
    : Effect.succeed(shared.cli)

/**
 * Runs `action`, shows its outcome, and has the proxy pick up what it
 * changed. A defect reads as the action having stopped.
 */
const actOn = Effect.fn("App.act")(function* (shared: Shared, action: Effect.Effect<string, Failure>) {
  const outcome = yield* Effect.exit(action)
  if (outcome._tag === "Success") yield* tell(shared, outcome.value, false)
  else {
    if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt
    const failure = Cause.findErrorOption(outcome.cause)
    yield* tell(shared, Option.isSome(failure) ? error.chain(failure.value) : stopped(outcome.cause), true)
  }
  yield* sync(shared)
})

/** @internal An action that died, as the Rust words a panicked one: `the action stopped: ` and why; exported for tests. */
export const stopped = (cause: Cause.Cause<unknown>): string => {
  const defect = Cause.findDefect(cause)
  if (Result.isFailure(defect)) return "the action stopped"
  const why = defect.success instanceof Error ? defect.success.message : String(defect.success)
  return why === "" ? "the action stopped" : `the action stopped: ${why}`
}

/** Starts the proxy unless it is running. */
const startProxy = Effect.fn("App.startProxy")(function* (shared: Shared) {
  if (yield* shared.daemon.isRunning) return
  yield* update(shared, (s) => ({ ...s, proxy: Proxy.Starting }))
  const started = yield* Effect.result(
    Effect.flatMap(cliOf(shared), (cli) => background.ensureRunning(shared.config, cli)),
  )
  if (started._tag === "Failure") {
    yield* update(shared, (s) => ({ ...s, proxy: Proxy.Stopped }))
    yield* tell(shared, `Could not start the proxy: ${error.chain(started.failure)}`, true)
  }
  yield* lookAgain(shared, true)
})

/**
 * Keeps the snapshot current: the report every `POLL`, and the agents and
 * login service every `SLOW_POLL` or when an action changed them.
 */
const watchOver = Effect.fn("App.watch")(function* (shared: Shared) {
  const last = { full: yield* Clock.currentTimeMillis }
  for (;;) {
    // A round that breaks is said on stderr (stdout may be a protocol's),
    // and the next goes on.
    yield* lookOnce(shared, last).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => log.warn(`the app's look at the proxy failed: ${Cause.pretty(cause)}`)),
      ),
    )
    yield* Effect.raceFirst(Effect.sleep(POLL), Queue.take(shared.look))
  }
})

/** One round of `watchOver`. */
const lookOnce = Effect.fn("App.look")(function* (shared: Shared, last: { full: number }) {
  const live = yield* shared.daemon.report(false)
  const running = live?.version
  const latest =
    live ??
    (yield* report
      .offline(shared.config, shared.store, false)
      .pipe(Effect.orElseSucceed((): report.Report | undefined => undefined)))
  if (latest !== undefined) yield* tellNudges(shared, latest)
  const at = yield* Clock.currentTimeMillis
  yield* update(shared, (s) => ({
    ...s,
    report: latest,
    notice: s.notice !== undefined && !s.notice.error && at - s.notice.shown >= NOTICE_FOR_MS ? undefined : s.notice,
    proxy:
      running !== undefined ? Proxy.Running(running) : s.proxy._tag === "Starting" ? Proxy.Starting : Proxy.Stopped,
  }))

  const full = shared.full || at - last.full >= SLOW_POLL_MS
  shared.full = false
  if (!full) return
  last.full = at
  const [agents, status] = yield* lookAround(shared.config)
  // As config.toml has it, should someone have edited it.
  const current = yield* Configs.loadFrom(shared.home.config()).pipe(
    Effect.map((c): Config | undefined => adopt(shared.config, c)),
    Effect.orElseSucceed(() => undefined),
  )
  yield* update(shared, (s) => ({ ...s, agents, service: status, config: current ?? s.config }))
})

/**
 * Hands the UI the nudges `report` calls for that were not told before, if
 * notifications are on, and remembers them as told.
 */
const tellNudges = Effect.fn("App.tellNudges")(function* (shared: Shared, latest: report.Report) {
  if (shared.told === undefined) return
  const current = (yield* SubscriptionRef.get(shared.state)).config
  const at = yield* Timestamp.now
  const found = nudges(latest, current, at)
  yield* shared.telling.withPermit(
    Effect.gen(function* () {
      const told = shared.told
      if (told === undefined) return
      const [next, changed, fresh] = Told.fresh(told, found, at)
      shared.told = next
      if (changed) yield* Told.save(next, Told.path(shared.home))
      if (!next.enabled) return
      for (const [key, event] of fresh) Queue.offerUnsafe(shared.alerts, Alert.of(key, event))
    }),
  )
})

/**
 * How the agents are wired, and the login service's status: file reads
 * and, for the service, a call to systemd or launchd.
 */
const lookAround = Effect.fn("App.lookAround")(function* (config: Config) {
  const agents: Array<AgentStatus> = []
  for (const a of agent.AGENTS) agents.push({ id: a.id, title: a.title, wiring: yield* agent.wiring(a, config) })
  const manager = yield* service.detect
  return [agents, manager === undefined ? undefined : yield* service.status(manager)] as const
})

/**
 * A config read from config.toml, as the app runs with it: on the address
 * and with the key it started with, which `SLOPMAX_LISTEN` may have set and
 * only a restart changes.
 */
export const adopt = (running: Config, read: Config): Config => ({
  ...read,
  listen: running.listen,
  apiKey: running.apiKey,
})

/** @internal Moves a sign-in along with an event the core told; exported for tests. */
export const progress = (snapshot: Snapshot, event: auth.LoginEvent): Snapshot => {
  const signIn = snapshot.signIn
  if (signIn === undefined) return snapshot
  switch (event._tag) {
    case "Authorize":
      return { ...snapshot, signIn: { ...signIn, step: Step.Authorize(event.url, event.opened) } }
    case "DeviceCode":
      return { ...snapshot, signIn: { ...signIn, step: Step.DeviceCode(event.url, event.code) } }
    case "Notice":
      return { ...snapshot, signIn: { ...signIn, notes: [...signIn.notes, event.text] } }
  }
}

const cliName = (): string => (process.platform === "win32" ? "slopmax.exe" : "slopmax")

const isFile = (path: string): Effect.Effect<boolean> => Effect.map(fsx.metadata(path), (m) => m?.isFile === true)

/**
 * The slopmax CLI shipped beside the app: in the same directory (a macOS
 * bundle, a build directory) or in `../bin` (an install that keeps the app
 * in `libexec`). Else whichever is on PATH.
 */
export const bundledCli: Effect.Effect<string | undefined> = Effect.gen(function* () {
  const name = cliName()
  const dir = dirname(process.execPath)
  for (const candidate of [paths.join(dir, name), paths.join(paths.join(dir, "../bin"), name)]) {
    if (yield* isFile(candidate)) return candidate
  }
  return yield* onPath(name)
})

/** @internal The first `name` on `PATH` that is a file; exported for tests. */
export const onPath = Effect.fn("App.onPath")(function* (name: string) {
  const path = Option.getOrUndefined(
    yield* EffectConfig.option(EffectConfig.String("PATH")).pipe(Effect.orElseSucceed(() => Option.none<string>())),
  )
  if (path === undefined) return undefined
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    const candidate = paths.join(dir, name)
    if (yield* isFile(candidate)) return candidate
  }
  return undefined
})

/** @internal `3 accounts`; exported for tests. */
export const countAccounts = (n: number): string => `${n} account${n === 1 ? "" : "s"}`
