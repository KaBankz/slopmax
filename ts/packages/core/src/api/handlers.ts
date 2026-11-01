// slopmax's own API, as the daemon serves it. Each handler calls the same
// service the CLI calls in process, so an action has one implementation
// whichever front end asks for it. A change to the accounts, the pins or
// the settings answers with the report as it is after the change.
import {
  type AccountId,
  agentOrder,
  BadRequest,
  Conflict,
  Internal,
  keyInfo,
  NewKey,
  NotFound,
  RedeemResult,
  Settings,
  settingsView,
  UpstreamFailed,
} from "@slopmax/domain"
import {
  AccountAdded,
  type AccountPatch,
  AgentConnected,
  AgentDisconnected,
  type ImportOutcome,
  ImportResult,
  ImportSource,
  LoginStarted,
  SlopmaxApi,
  Stopping,
} from "@slopmax/domain/api"
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Semaphore,
  Stream,
} from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import * as Agents from "../agents/index.ts"
import { doctor, type DoctorOptions } from "../doctor.ts"
import { Events } from "../events.ts"
import * as Importers from "../importers.ts"
import { Ledger } from "../ledger.ts"
import { history, rangeStart, summary, type ViewContext } from "../ledger-views.ts"
import { Notifier } from "../notifier.ts"
import { pin, Pool, unpinAll } from "../pool.ts"
import { pricingOf } from "../pricing.ts"
import { LoginUi } from "../providers/oauth.ts"
import { signIn } from "../providers/index.ts"
import { Quota } from "../quota.ts"
import { currentZone } from "../report.ts"
import { SettingsService } from "../settings.ts"
import { Logins } from "./logins.ts"
import { freshReport, viewIn } from "./status.ts"

/** Asks the daemon to stop, as `POST /shutdown` does; the daemon waits on it. */
export class Shutdown extends Context.Service<
  Shutdown,
  {
    /** Asks for a stop. Answers at once; the daemon drains and stops after. */
    readonly request: Effect.Effect<void>
    /** Waits until a stop is asked for. */
    readonly requested: Effect.Effect<void>
    /**
     * Says the stop has begun, however it was asked for: open event streams
     * end, since they never finish on their own and the server's drain would
     * wait the full time for them.
     */
    readonly begin: Effect.Effect<void>
    /** Waits until the stop has begun. */
    readonly begun: Effect.Effect<void>
  }
>()("@slopmax/core/Shutdown") {
  static readonly layer: Layer.Layer<Shutdown> = Layer.effect(
    Shutdown,
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const stopping = yield* Deferred.make<void>()
      return {
        request: Deferred.succeed(asked, undefined).pipe(Effect.asVoid),
        requested: Deferred.await(asked),
        begin: Deferred.succeed(stopping, undefined).pipe(Effect.asVoid),
        begun: Deferred.await(stopping),
      }
    }),
  )
}

/**
 * What the API's doctor checks with: the defaults, unless a test points the
 * CLIProxyAPI and network checks somewhere harmless.
 */
export const ApiDoctorOptions = Context.Reference<DoctorOptions>("@slopmax/core/ApiDoctorOptions", {
  defaultValue: () => ({}),
})

/** Any failure that is slopmax's own, with its words. */
const internal = (error: { readonly message: string }) => new Internal({ message: error.message })

const noSuchAccount = new NotFound({ what: "account" })

/** A sign-in that needs nobody: keys and endpoints are checked with their provider, and nothing opens or is pasted. */
const quietLogin = Layer.succeed(LoginUi)({ tell: () => Effect.void, pasted: Stream.never, openBrowser: false })

/**
 * Runs `task` once for every caller that asks while it runs: a second
 * caller joins the run in progress instead of starting another.
 */
const sharedRun = <E>(task: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const current = yield* Ref.make(Option.none<Fiber.Fiber<void, E>>())
    const start = lock.withPermit(
      Effect.gen(function* () {
        const running = yield* Ref.get(current)
        if (Option.isSome(running)) return running.value
        const fiber = yield* task.pipe(
          // Cleared under the same lock, so it is never cleared before it is set.
          Effect.ensuring(lock.withPermit(Ref.set(current, Option.none()))),
          Effect.forkIn(scope),
        )
        yield* Ref.set(current, Option.some(fiber))
        return fiber
      }),
    )
    return Effect.flatMap(start, Fiber.join)
  })

const systemGroup = HttpApiBuilder.group(SlopmaxApi, "system", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService
    const accounts = yield* Accounts
    const quota = yield* Quota
    const shutdown = yield* Shutdown
    const services = yield* Effect.context<Pool | Accounts | SettingsService | Doctor>()
    const doctorOptions = yield* ApiDoctorOptions
    const fresh = Effect.provideContext(freshReport, services)
    // Polls and listings run in the server's scope, so a caller hanging up never cuts one short.
    const refreshAll = yield* sharedRun(Effect.andThen(quota.pollDue({ force: true }), quota.listDue({ force: true })))

    return handlers
      .handle("status", () => fresh)
      .handle("refresh", () => Effect.andThen(refreshAll, fresh))
      .handle("sync", () =>
        Effect.gen(function* () {
          if ((yield* settings.reload) === "invalid") {
            return yield* new Internal({ message: "config.json is invalid; the last good settings stay in force" })
          }
          yield* accounts.rescan.pipe(Effect.mapError(internal))
          return yield* fresh
        }),
      )
      .handle("shutdown", () => Effect.as(shutdown.request, new Stopping({ status: "stopping" })))
      .handle("doctor", () => Effect.provideContext(doctor(doctorOptions), services))
  }),
)

/** What the doctor runs on. */
type Doctor = Effect.Services<ReturnType<typeof doctor>>

/** An account with a change from the API: a `null` label clears it. */
const patched = (account: Account, patch: AccountPatch): Account => {
  const { label: _old, ...rest } = account
  const label = patch.label === undefined ? account.label : (patch.label ?? undefined)
  return new Account({
    ...rest,
    ...(label === undefined ? {} : { label }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
  })
}

const accountsGroup = HttpApiBuilder.group(SlopmaxApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const pool = yield* Pool
    const quota = yield* Quota
    const services = yield* Effect.context<
      | Pool
      | Accounts
      | SettingsService
      | Exclude<Effect.Services<ReturnType<typeof signIn>>, LoginUi>
      | Importers.ImportServices
    >()
    const fresh = Effect.provideContext(freshReport, services)

    const known = (id: AccountId) =>
      Effect.flatMap(
        accounts.get(id),
        Option.match({ onNone: () => Effect.fail(noSuchAccount), onSome: Effect.succeed }),
      )

    /** Changes an account on disk, then answers the report. */
    const change = (id: AccountId, f: (account: Account) => Account) =>
      Effect.gen(function* () {
        yield* known(id)
        yield* accounts
          .update(id, f)
          .pipe(Effect.mapError((error) => (error._tag === "AccountGone" ? noSuchAccount : internal(error))))
        return yield* fresh
      })

    return handlers
      .handle("add", ({ payload }) =>
        Effect.gen(function* () {
          const label = payload.label === undefined || payload.label === "" ? undefined : payload.label
          const saved = yield* (
            payload._tag === "Key"
              ? signIn(payload.provider, { key: Redacted.make(payload.key), label })
              : signIn("compat", {
                  endpoint: { baseUrl: payload.url, dialect: payload.dialect, models: payload.models },
                  ...(payload.key === undefined ? {} : { key: Redacted.make(payload.key) }),
                  label,
                })
          ).pipe(
            Effect.provide(quietLogin),
            Effect.provideContext(services),
            Effect.mapError((error) =>
              error._tag === "LoginFailed" || error._tag === "LoginTimedOut" || error._tag === "StateMismatch"
                ? new UpstreamFailed({ message: error.message })
                : internal(error),
            ),
          )
          const report = yield* fresh
          const account = viewIn(report, saved.account.id)
          if (account === undefined) return yield* new Internal({ message: "the account was saved but is not listed" })
          return new AccountAdded({ account, report })
        }),
      )
      .handle("update", ({ params, payload }) => change(params.id, (account) => patched(account, payload)))
      .handle("pin", ({ params }) =>
        Effect.gen(function* () {
          const account = yield* known(params.id)
          yield* pool.update((m) => pin(m, account.provider, account.id))
          return yield* fresh
        }),
      )
      .handle("unpinAll", () => Effect.andThen(pool.update(unpinAll), fresh))
      .handle("own", ({ params }) => change(params.id, Importers.owned))
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const account = yield* known(params.id)
          yield* accounts
            .remove(account.id)
            .pipe(Effect.mapError((error) => (error._tag === "AccountGone" ? noSuchAccount : internal(error))))
          // Its pin goes with it.
          yield* pool.update((m) => (m.pins[account.provider] === account.id ? pin(m, account.provider, undefined) : m))
          return yield* fresh
        }),
      )
      .handle("redeem", ({ params, payload }) =>
        Effect.gen(function* () {
          const account = yield* known(params.id)
          const outcome = yield* quota.redeem(account, payload.reset).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "NoLimitResets":
                  return new BadRequest({ message: "this account has no limit resets" })
                case "NotReady":
                  return new Conflict({ message: "the account needs signing in again" })
                default:
                  return new UpstreamFailed({ message: error.message })
              }
            }),
          )
          return new RedeemResult({ outcome, report: yield* fresh })
        }),
      )
      .handle("import", ({ payload }) =>
        Effect.gen(function* () {
          const outcomes: Array<ImportOutcome> = []
          const saved: Array<{ readonly source: ImportSource; readonly item: Importers.Saved }> = []
          for (const source of payload.sources ?? ImportSource.literals) {
            const found = yield* Effect.provideContext(Importers.discover(source), services)
            for (const item of yield* Effect.provideContext(Importers.save(found, payload.own), services)) {
              saved.push({ source, item })
            }
          }
          const report = yield* fresh
          for (const { source, item } of saved) {
            const result = item.account
            if (Result.isFailure(result)) {
              outcomes.push({ _tag: "Failed", source, origin: item.origin, message: result.failure.message })
              continue
            }
            const account = viewIn(report, result.success.account.id)
            if (account === undefined) continue
            outcomes.push({ _tag: "Saved", source, origin: item.origin, account, isNew: result.success.isNew })
          }
          return new ImportResult({ outcomes, report })
        }),
      )
  }),
)

const loginsGroup = HttpApiBuilder.group(SlopmaxApi, "logins", (handlers) =>
  Effect.gen(function* () {
    const logins = yield* Logins
    return handlers
      .handle("start", ({ payload }) =>
        Effect.map(logins.start(payload.provider, { device: payload.device }), (id) => new LoginStarted({ id })),
      )
      .handle("paste", ({ params, payload }) => logins.paste(params.id, payload.address))
      .handle("cancel", ({ params }) => logins.cancel(params.id))
  }),
)

const configGroup = HttpApiBuilder.group(SlopmaxApi, "config", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService
    /** The settings in force: the file's, with what only a restart changes as this process started. */
    const view = Effect.map(settings.get, (file) => {
      const upstreamProxy = Option.getOrUndefined(settings.running.upstreamProxy)
      const { upstreamProxy: _file, ...rest } = file
      const running = new Settings({
        ...rest,
        listen: settings.running.listen,
        ...(upstreamProxy === undefined ? {} : { upstreamProxy }),
      })
      return settingsView(running, file)
    })
    const keys = Effect.map(settings.get, (current) => current.keys.map(keyInfo))
    return handlers
      .handle("settings", () => view)
      .handle("change", ({ payload }) =>
        Effect.gen(function* () {
          yield* settings.setLive(payload).pipe(Effect.mapError(internal))
          yield* Effect.logInfo("settings changed from the API")
          return yield* view
        }),
      )
      .handle("keys", () => keys)
      .handle("makeKey", ({ payload }) =>
        Effect.gen(function* () {
          const made = yield* settings
            .addKey(payload.name, payload.models)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "SettingRejected" ? new Conflict({ message: error.message }) : internal(error),
              ),
            )
          return new NewKey({ name: made.name, key: Redacted.value(made.key), models: made.models })
        }),
      )
      .handle("removeKey", ({ params }) =>
        Effect.gen(function* () {
          const removed = yield* settings.removeKey(params.name).pipe(Effect.mapError(internal))
          if (!removed) return yield* new NotFound({ what: `key ${JSON.stringify(params.name)}` })
          return yield* keys
        }),
      )
  }),
)

const agentsGroup = HttpApiBuilder.group(SlopmaxApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Effect.Services<ReturnType<typeof Agents.connect>> | Effect.Services<ReturnType<typeof Agents.wiring>>
    >()
    return handlers
      .handle("list", () => Effect.provideContext(Effect.forEach(agentOrder, Agents.wiring), services))
      .handle("connect", ({ params }) =>
        Agents.connect(params.id).pipe(
          Effect.provideContext(services),
          Effect.map((done) => new AgentConnected(done)),
          Effect.mapError(internal),
        ),
      )
      .handle("disconnect", ({ params }) =>
        Agents.disconnect(params.id).pipe(
          Effect.provideContext(services),
          Effect.map((done) => new AgentDisconnected(done)),
          Effect.mapError((error) =>
            error._tag === "NothingToUndo" ? new Conflict({ message: error.message }) : internal(error),
          ),
        ),
      )
  }),
)

const usageGroup = HttpApiBuilder.group(SlopmaxApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const accounts = yield* Accounts
    const settings = yield* SettingsService
    /** Names, prices, the time and the zone the views are made with. */
    const context = Effect.gen(function* () {
      const names = new Map((yield* accounts.list).map((account) => [account.id, account.name] as const))
      const ctx: ViewContext = {
        names,
        pricing: pricingOf(yield* settings.get),
        now: yield* DateTime.now,
        zone: yield* currentZone,
      }
      return ctx
    })
    return handlers
      .handle("summary", ({ query }) =>
        Effect.gen(function* () {
          const ctx = yield* context
          const records = yield* ledger.load(rangeStart(query.range, ctx.now, ctx.zone)).pipe(Effect.mapError(internal))
          return summary(records, query.range, query.by, ctx)
        }),
      )
      .handle("history", ({ query }) =>
        Effect.gen(function* () {
          const ctx = yield* context
          const records = yield* ledger.load(rangeStart(query.range, ctx.now, ctx.zone)).pipe(Effect.mapError(internal))
          return history(records, query.range, ctx)
        }),
      )
  }),
)

const eventsGroup = HttpApiBuilder.group(SlopmaxApi, "events", (handlers) =>
  Effect.gen(function* () {
    const events = yield* Events
    const shutdown = yield* Shutdown
    return handlers.handle("watch", () => Effect.succeed(events.subscribe.pipe(Stream.interruptWhen(shutdown.begun))))
  }),
)

const notifyGroup = HttpApiBuilder.group(SlopmaxApi, "notify", (handlers) =>
  Effect.gen(function* () {
    const notifier = yield* Notifier
    return handlers.handle("test", () =>
      notifier.test.pipe(
        Effect.mapError((error) =>
          error._tag === "NotifyOff"
            ? new BadRequest({ message: error.message })
            : new UpstreamFailed({ message: error.message }),
        ),
      ),
    )
  }),
)

/** Every group of slopmax's own API, over the daemon's services. */
export const apiHandlers = Layer.mergeAll(
  systemGroup,
  accountsGroup,
  loginsGroup,
  configGroup,
  agentsGroup,
  usageGroup,
  eventsGroup,
  notifyGroup,
)
