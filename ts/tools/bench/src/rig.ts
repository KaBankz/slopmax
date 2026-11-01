// The bench rig: the real daemon over a throwaway home with two Claude and
// two ChatGPT accounts whose traffic goes to the mock provider. Every
// provider origin those accounts use is rewritten to the mock, so nothing
// leaves the machine, and the home's settings keep the rig to itself: the
// key agents present is `bench`, and nothing refreshes sign-ins or polls
// usage behind the load's back.
import {
  Account,
  Accounts,
  Assets,
  Background,
  type CoreServices,
  Credential,
  Daemon,
  Events,
  Home,
  Identity,
  Ledger,
  Lock,
  Log,
  SettingsService,
  Shutdown,
  Tokens,
  Upstream,
  withAssignedId,
} from "@slopmax/core"
import { AccountId, Settings } from "@slopmax/domain"
import { DateTime, Effect, type FileSystem, Layer, type Path, Redacted } from "effect"
import { Argument, Command } from "effect/cli"
import { Digest } from "effect/crypto"
import type { ChildProcessSpawner } from "effect/process"

/** The key agents present to the rig. */
export const benchKey = "bench"

/** Where the rig sends what slopmax would send to Claude and ChatGPT. */
export const benchOrigins = (upstream: string): Readonly<Record<string, string>> => ({
  "https://api.anthropic.com": upstream,
  "https://chatgpt.com/backend-api": upstream,
})

const subscriptions = ["claude", "codex"] as const
type Subscription = (typeof subscriptions)[number]

/** Plans, for what unused quota is worth on the dashboard. */
const plans: Readonly<Record<Subscription, readonly [string, string]>> = {
  claude: ["max 20x", "max 5x"],
  codex: ["pro", "plus"],
}

/**
 * The rig's four accounts, signed in as of `now` for 30 days: tokens
 * `bench-{provider}-{i}`, emails `{provider}{i}@bench.invalid`, and
 * organizations that are UUIDs, as Claude's are, since spending a limit
 * reset names one. Each is added a second after the one before, so the
 * order they are tried in is fixed.
 */
export const benchAccounts = (now: DateTime.Utc): ReadonlyArray<Account> =>
  subscriptions.flatMap((provider, p) =>
    [0, 1].map((i) => {
      const order = 100 * p + i
      return new Account({
        id: AccountId.make(`${provider}-${i}`),
        provider,
        credential: Credential.cases.OAuth.make({
          tokens: new Tokens({
            access: Redacted.make(`bench-${provider}-${i}`),
            refresh: Redacted.make(`bench-refresh-${provider}-${i}`),
            expiresAt: DateTime.add(now, { days: 30 }),
          }),
        }),
        identity: new Identity({
          email: `${provider}${i}@bench.invalid`,
          accountId: `acct-${provider}-${i}`,
          orgId: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
          plan: plans[provider][i] ?? "",
        }),
        addedAt: DateTime.add(now, { seconds: 2 * p + i - 4 }),
      })
    }),
  )

/** The settings the rig runs on: the home's own, but listening at `listen` with the bench's key and no background refreshing or polling. */
export const rigSettings =
  (listen: string, overrides: Partial<Pick<Settings, "redeemExpiring">> = {}) =>
  (settings: Settings): Settings =>
    new Settings({
      ...settings,
      listen,
      apiKey: Redacted.make(benchKey),
      refreshTokens: false,
      pollMinutes: 0,
      ...overrides,
    })

/** What the platform layer gives every process, below the engine's own services. */
type PlatformServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

/**
 * The engine's services over the home at `root`, with provider traffic sent
 * to `upstream`: the daemon's own base with the home and the origins
 * swapped. It must provide every service the daemon's base does, so one
 * added there and missing here fails the type check instead of leaving the
 * rig measuring less.
 */
export const rigBase = ((root: string, upstream: string) =>
  Layer.mergeAll(Accounts.layer, Ledger.layer, Background.layer).pipe(
    Layer.provideMerge(Upstream.layerOrigins(benchOrigins(upstream))),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(SettingsService.layer),
    Layer.provideMerge(Lock.layer),
    Layer.provideMerge(Home.layerAt(root)),
  )) satisfies (
  root: string,
  upstream: string,
) => Layer.Layer<Exclude<CoreServices, PlatformServices>, unknown, unknown>

export interface RigOptions {
  /** `host:port` the proxy listens on. */
  readonly listen: string
  /** The mock provider's URL. */
  readonly upstream: string
  /** The home's directory, made when missing. */
  readonly root: string
  /** Leave limit resets about to expire unspent (the demo leaves them to the person). */
  readonly keepExpiring?: boolean | undefined
}

/** Saves the four accounts and the rig's settings into the home, keeping whatever else is there. */
export const prepareHome = Effect.fn("Bench.prepareHome")(
  function* (options: RigOptions) {
    const accounts = yield* Accounts
    const settings = yield* SettingsService
    const now = yield* DateTime.now
    for (const account of benchAccounts(now)) {
      yield* accounts.upsert(yield* Effect.provide(withAssignedId(account), Digest.layerWebCrypto))
    }
    yield* settings.update(rigSettings(options.listen, options.keepExpiring === true ? { redeemExpiring: false } : {}))
  },
  (effect, options) => Effect.provide(effect, rigBase(options.root, options.upstream)),
)

/**
 * The daemon on a home `prepareHome` made, until it is asked to stop (or
 * interrupted), with no dashboard files: the rig measures the proxy. It
 * logs as `slopmax serve` does, so it does the same work per request.
 */
export const servePrepared = Effect.fn("Bench.servePrepared")(function* (options: RigOptions) {
  const daemon = Daemon.layerWith().pipe(
    Layer.provide(Assets.none),
    Layer.provide(rigBase(options.root, options.upstream)),
    Layer.provide(Log.layer({ fallback: "Info" })),
  )
  yield* Effect.flatMap(Effect.service(Shutdown), (shutdown) => shutdown.requested).pipe(Effect.provide(daemon))
})

/** Prepares the home at `options.root`, then serves the daemon on it. */
export const serveRig = Effect.fn("Bench.serveRig")(function* (options: RigOptions) {
  yield* prepareHome(options)
  yield* servePrepared(options)
})

/** `rig <host:port> <mock-url> <home>`: the bench command, and the whole of the rig's own binary. */
export const rigCommand = Command.make(
  "rig",
  {
    listen: Argument.String("listen").pipe(Argument.withDescription("host:port to listen on")),
    upstream: Argument.String("upstream").pipe(Argument.withDescription("the mock provider's URL")),
    home: Argument.String("home").pipe(Argument.withDescription("the rig's home directory")),
  },
  ({ listen, upstream, home }) => serveRig({ listen, upstream, root: home }),
).pipe(Command.withDescription("The slopmax daemon over four bench accounts whose providers are the mock"))
