// Notices: telling people when something needs them, once.
//
// Every 15 seconds the daemon hands the notifier its live report. The
// notifier compares each account's standing with the one it saw last, so a
// change (an account limited, every account of a provider spent, a sign-in
// gone) is told exactly once, and the first look only takes stock: what was
// already so when slopmax started is not news. The report's nudges (a
// limit reset about to expire unused, a week about to reset with quota to
// spare) are told once each too; the keys told go to the `Told` store, which
// the daemon keeps with its saved state, so a restart, the dashboard and the
// desktop never repeat one.
//
// Each notice goes to the event feed (the dashboard and the desktop show
// it) and, when the settings name one, to a webhook and a shell command.
import {
  type AccountId,
  type AccountView,
  Event,
  formatInstant,
  Notice,
  type NoticeKind,
  type ProviderId,
  providerFacts,
  providerOrder,
  type Report,
  upcomingReset,
  usedAt,
} from "@slopmax/domain"
import { clock, fixed, until as untilText } from "@slopmax/domain/format"
import {
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  type PlatformError,
  Ref,
  Schema,
  Stream,
} from "effect"
import { type HttpClientError, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Events } from "./events.ts"
import { unusedValue } from "./ledger-views.ts"
import type { Pricing } from "./pricing.ts"
import { SettingsService } from "./settings.ts"
import { Upstream } from "./upstream.ts"

// ---------------------------------------------------------------------------
// Words

/** `in 2h05m (14:00)`: how long until a moment, and when it is on the local clock. */
export const when = (at: DateTime.DateTime, now: DateTime.DateTime, zone: DateTime.TimeZone): string =>
  `in ${untilText(at, now)} (${clock(at, now, zone)})`

/** The test notice's message. */
export const testMessage = "slopmax notifications are working."

/** The notice `slopmax notify` sends to check the setup. */
export const testNotice = (now: DateTime.Utc): Notice =>
  new Notice({ kind: "test", key: "test", message: testMessage, at: now })

// ---------------------------------------------------------------------------
// Conditions, as notices care about them

/** Where an account stands for notices: serving, limited, signed out, or switched off by its owner. */
export type Standing = "ready" | "limited" | "signed-out" | "off"

/** What the last look saw. */
export interface Conditions {
  /** False until the first look, which only takes stock. */
  readonly primed: boolean
  readonly accounts: ReadonlyMap<AccountId, Standing>
  readonly exhausted: ReadonlyMap<ProviderId, boolean>
}

/** Before the first look. */
export const noConditions: Conditions = { primed: false, accounts: new Map(), exhausted: new Map() }

/** An account switched off is none of the notices' business, even when its sign-in also failed. */
export const standingOf = (account: AccountView): Standing => {
  if (account.disabled) return "off"
  switch (account.condition._tag) {
    case "SignInNeeded":
      return "signed-out"
    case "Disabled":
      return "off"
    case "Limited":
      return "limited"
    default:
      return "ready"
  }
}

const limitedUntil = (account: AccountView): DateTime.Utc | undefined =>
  account.condition._tag === "Limited" ? account.condition.until : undefined

const back = (at: DateTime.Utc | undefined, now: DateTime.Utc, zone: DateTime.TimeZone): string =>
  at !== undefined && DateTime.isGreaterThan(at, now) ? `; back ${when(at, now, zone)}` : ""

/**
 * The notices that the change from `previous` to `report` makes, and what
 * to compare the next report with. Per account: limited, available again,
 * signed out. Per provider, in registry order: every account limited or
 * signed out (`exhausted`), and served again (`recovered`). An account
 * limited by the same look that spends its provider is told as the
 * provider's one notice, not two. Accounts removed are forgotten, so one
 * added again starts fresh.
 */
export const watch = (
  previous: Conditions,
  report: Pick<Report, "accounts" | "generatedAt">,
  zone: DateTime.TimeZone,
): readonly [ReadonlyArray<Notice>, Conditions] => {
  const now = report.generatedAt
  const notices: Array<Notice> = []
  const accounts = new Map<AccountId, Standing>()
  const exhaustedNow = new Map<ProviderId, boolean>()
  const notice = (
    kind: NoticeKind,
    key: string,
    provider: ProviderId,
    message: string,
    extra: { readonly account?: string; readonly until?: DateTime.Utc | undefined } = {},
  ) =>
    new Notice({
      kind,
      key,
      provider,
      message,
      at: now,
      ...(extra.account === undefined ? {} : { account: extra.account }),
      ...(extra.until === undefined ? {} : { until: extra.until }),
    })

  for (const provider of providerOrder) {
    const mine = report.accounts
      .filter((account) => account.provider === provider)
      .map((account) => ({ account, standing: standingOf(account), until: limitedUntil(account) }))
    const serving = mine.filter((entry) => entry.standing !== "off")
    const exhausted = serving.length > 0 && serving.every((entry) => entry.standing !== "ready")
    const wasExhausted = previous.exhausted.get(provider) ?? false
    exhaustedNow.set(provider, exhausted)
    const soonest = serving
      .flatMap((entry) => (entry.until === undefined ? [] : [entry.until]))
      .reduce<DateTime.Utc | undefined>((a, b) => (a === undefined || DateTime.isLessThan(b, a) ? b : a), undefined)
    const title = providerFacts[provider].title

    for (const { account, standing, until } of mine) {
      accounts.set(account.id, standing)
      const before = previous.accounts.get(account.id)
      if (!previous.primed || before === undefined || before === standing) continue
      const key = `account:${account.id}`
      const name = account.name
      if (standing === "limited" && (!exhausted || wasExhausted)) {
        notices.push(
          notice("limited", key, provider, `${name} hit a usage limit${back(until, now, zone)}.`, {
            account: name,
            until,
          }),
        )
      } else if (standing === "ready" && before === "limited") {
        notices.push(notice("available", key, provider, `${name} can serve requests again.`, { account: name }))
      } else if (standing === "signed-out") {
        const reason = account.condition._tag === "SignInNeeded" ? account.condition.error : "unknown reason"
        notices.push(
          notice(
            "signed-out",
            key,
            provider,
            `${name} is signed out (${reason}); run \`slopmax login ${provider}\` to sign in again.`,
            { account: name },
          ),
        )
      }
    }

    if (!previous.primed || exhausted === wasExhausted) continue
    const key = `provider:${provider}`
    notices.push(
      exhausted
        ? notice(
            "exhausted",
            key,
            provider,
            `Every ${title} account is limited or signed out, so ${title} requests fail${
              soonest === undefined ? "" : ` until ${when(soonest, now, zone)}`
            }.`,
            { until: soonest },
          )
        : notice("recovered", key, provider, `${title} requests are being served again.`),
    )
  }
  return [notices, { primed: true, accounts, exhausted: exhaustedNow }]
}

// ---------------------------------------------------------------------------
// Nudges

/** How far ahead an expiring reset or a resetting week is worth a word. */
export const nudgeAhead: Duration.Duration = Duration.hours(24)

/** The share of a week, in percent, left unused that is worth a word. */
export const unusedWorthANudge = 25

export interface NudgeOptions {
  /** slopmax redeems expiring resets itself (`redeemExpiring`), so they need no word. */
  readonly autoRedeem: boolean
  readonly pricing: Pick<Pricing, "planFee">
  readonly now: DateTime.Utc
  readonly zone: DateTime.TimeZone
}

/**
 * What is worth doing before it is lost: a limit reset that expires within
 * the day unredeemed (only when slopmax does not redeem them itself), and a
 * week or month that resets within the day with at least a quarter of it
 * unused, on an account that can serve, so work sent there costs nothing
 * extra. Each has a key that names it, so it is told once.
 */
export const nudges = (accounts: ReadonlyArray<AccountView>, options: NudgeOptions): ReadonlyArray<Notice> => {
  const { now, zone } = options
  const horizon = DateTime.addDuration(now, nudgeAhead)
  const soon = (at: DateTime.Utc) => DateTime.isGreaterThan(at, now) && DateTime.isLessThanOrEqualTo(at, horizon)
  const found: Array<Notice> = []
  for (const account of accounts) {
    if (account.disabled || account.condition._tag === "SignInNeeded") continue
    const name = account.name
    const about = { provider: account.provider, account: name, at: now }
    if (!options.autoRedeem) {
      for (const reset of account.resets) {
        if (reset.expiresAt === undefined || !soon(reset.expiresAt)) continue
        found.push(
          new Notice({
            ...about,
            kind: "reset-expiring",
            key: `reset:${account.id}:${reset.id}`,
            until: reset.expiresAt,
            message: `A limit reset on ${name} expires ${when(reset.expiresAt, now, zone)}; redeem it with \`slopmax redeem ${name}\` before it is lost.`,
          }),
        )
      }
    }
    // A limited account cannot take the work, so its spare week is not worth a word.
    if (account.condition._tag === "Limited") continue
    for (const window of account.windows) {
      if (window.model !== undefined || window.span === "5h") continue
      const resets = Option.getOrUndefined(upcomingReset(window, now))
      if (resets === undefined || !soon(resets)) continue
      const used = Math.min(100, Math.max(0, usedAt(window, now)))
      const unused = 100 - used
      if (unused < unusedWorthANudge) continue
      const worth = unusedValue(
        { provider: account.provider, plan: account.plan, span: window.span, used },
        options.pricing,
      )
      const worthText = worth !== undefined && worth >= 0.5 ? `, about $${fixed(worth, 0)} of its plan` : ""
      const period = window.span === "30d" ? "month" : "week"
      found.push(
        new Notice({
          ...about,
          kind: "quota-unused",
          key: `unused:${account.id}:${window.span}:${Math.floor(DateTime.toEpochMillis(resets) / 1000)}`,
          until: resets,
          message: `${name}'s ${period} resets ${when(resets, now, zone)} with ${fixed(unused, 0)}% of it unused${worthText}. Work sent there before then costs nothing extra.`,
          ...(worth === undefined ? {} : { worth }),
        }),
      )
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// What was told

/** Each notice key told, and when it stops mattering. */
export type ToldSet = Readonly<Record<string, DateTime.Utc>>

/**
 * The notices in `found` not told before, and the told set after telling
 * them. A key is kept until its moment passes (the reset's expiry, the
 * week's end), which is also when its notice stops coming up, so the set
 * stays small and nothing is told twice.
 */
export const tell = (
  told: ToldSet,
  found: ReadonlyArray<Notice>,
  now: DateTime.Utc,
): { readonly fresh: ReadonlyArray<Notice>; readonly told: ToldSet; readonly changed: boolean } => {
  const next = new Map<string, DateTime.Utc>()
  let changed = false
  for (const [key, at] of Object.entries(told)) {
    if (DateTime.isGreaterThan(at, now)) next.set(key, at)
    else changed = true
  }
  const fresh: Array<Notice> = []
  for (const notice of found) {
    if (next.has(notice.key)) continue
    next.set(notice.key, notice.until ?? now)
    fresh.push(notice)
    changed = true
  }
  return { fresh, told: Object.fromEntries(next), changed }
}

/**
 * Where the told set is kept. In the daemon it is `state.json`'s, which the
 * pool saves; a process that only sends one notice needs none.
 */
export class Told extends Context.Service<
  Told,
  {
    readonly get: Effect.Effect<ToldSet>
    readonly set: (told: ToldSet) => Effect.Effect<void>
  }
>()("@slopmax/core/Told") {
  /** Kept in memory only, starting from `seed`. */
  static readonly layerMemory = (seed: ToldSet = {}): Layer.Layer<Told> =>
    Layer.effect(
      Told,
      Effect.map(Ref.make(seed), (ref) => ({ get: Ref.get(ref), set: (told: ToldSet) => Ref.set(ref, told) })),
    )
}

// ---------------------------------------------------------------------------
// Sending

/** Neither a webhook nor a command is set up. */
export class NotifyOff extends Data.TaggedError("NotifyOff")<{}> {
  override get message(): string {
    return "notifications are off: set notify.webhook or notify.command in config.json"
  }
}

/** The webhook answered other than 2xx (`status`), or could not be reached (`cause`). */
export class WebhookFailed extends Data.TaggedError("WebhookFailed")<{
  readonly status?: number
  readonly cause?: HttpClientError.HttpClientError
}> {
  override get message(): string {
    return this.status === undefined ? (this.cause?.message ?? "failed") : `HTTP ${this.status}`
  }
}

/** Why a notify command failed. */
export type CommandFailure = "start" | "timeout" | "exit" | "output"

/** The notify command could not start, ran too long, exited other than 0, or its output could not be read. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly reason: CommandFailure
  readonly code?: number
  readonly stderr?: string
  readonly cause?: PlatformError.PlatformError
}> {
  override get message(): string {
    switch (this.reason) {
      case "start":
        return "could not start it"
      case "timeout":
        return "timed out"
      case "exit":
        return `exit status ${this.code ?? "unknown"}: ${this.stderr ?? ""}`
      case "output":
        return this.cause?.message ?? "could not read its output"
    }
  }
}

/** The webhook, the command, or both failed; both were tried. */
export class NotifyFailed extends Data.TaggedError("NotifyFailed")<{
  readonly webhook?: WebhookFailed
  readonly command?: CommandFailed
}> {
  override get message(): string {
    return [
      ...(this.webhook === undefined ? [] : [`webhook: ${this.webhook.message}`]),
      ...(this.command === undefined ? [] : [`command: ${this.command.message}`]),
    ].join("; ")
  }
}

/** How long a notify command may run before it is stopped. */
export const commandTimeout: Duration.Duration = Duration.seconds(30)

/**
 * How long a stopped command has to exit before it is killed outright, so a
 * script that ignores the stop cannot hold up the notices after it.
 */
export const commandGrace: Duration.Duration = Duration.seconds(2)

/** The command line that runs `command` in the system's shell. */
export const shellFor = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): readonly [string, ReadonlyArray<string>] =>
  platform === "win32" ? ["cmd", ["/C", command]] : ["sh", ["-c", command]]

/** The environment a notify command sees the notice in. */
export const commandEnv = (notice: Notice): Record<string, string> => ({
  SLOPMAX_EVENT: notice.kind,
  SLOPMAX_PROVIDER: notice.provider ?? "",
  SLOPMAX_ACCOUNT: notice.account ?? "",
  SLOPMAX_UNTIL: notice.until === undefined ? "" : formatInstant(notice.until),
  SLOPMAX_MESSAGE: notice.message,
})

const encodeNotice = Schema.encodeSync(Notice)

/** A webhook's body: the notice, with `text` and `content` repeating its message for Slack and Discord. */
export const webhookBody = (notice: Notice): Record<string, unknown> => ({
  ...encodeNotice(notice),
  text: notice.message,
  content: notice.message,
})

export interface Shape {
  /** Sends a notice to the webhook and the command, when set up and the settings want its kind. */
  readonly send: (notice: Notice) => Effect.Effect<void, NotifyFailed>
  /** Sends the test notice, which every setup wants. */
  readonly test: Effect.Effect<void, NotifyFailed | NotifyOff>
  /**
   * One look at the live report: the changes since the last look and the
   * nudges not told yet go to the event feed, the log, and the webhook and
   * command. A failed send is logged; it never stops the next look.
   */
  readonly look: (report: Report) => Effect.Effect<void>
}

/** Runs one way of sending, giving its failure, or nothing when it worked. */
const attempt = <E>(effect: Effect.Effect<void, E> | undefined): Effect.Effect<E | undefined> =>
  effect === undefined ? Effect.undefined : effect.pipe(Effect.as(undefined), Effect.catch(Effect.succeed))

export const make = Effect.gen(function* () {
  const upstream = yield* Upstream
  const settings = yield* SettingsService
  const events = yield* Events
  const told = yield* Told
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const conditions = yield* Ref.make(noConditions)

  const post = (url: string, notice: Notice) =>
    upstream.http.execute(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), webhookBody(notice))).pipe(
      Effect.mapError((cause) => new WebhookFailed({ cause })),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : Effect.fail(new WebhookFailed({ status: response.status })),
      ),
      Effect.withSpan("Notifier.webhook"),
    )

  const run = (command: string, notice: Notice) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(...shellFor(command), {
              env: commandEnv(notice),
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
              forceKillAfter: commandGrace,
            }),
          )
          .pipe(Effect.mapError((cause) => new CommandFailed({ reason: "start", cause })))
        const [code, stderr] = yield* Effect.all([handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))], {
          concurrency: 2,
        }).pipe(Effect.mapError((cause) => new CommandFailed({ reason: "output", cause })))
        if (code !== 0) return yield* new CommandFailed({ reason: "exit", code, stderr: stderr.trim() })
      }),
    ).pipe(
      // Closing the scope stops the command when it runs too long, and kills
      // it when it does not stop.
      Effect.timeoutOrElse({
        duration: commandTimeout,
        orElse: () => Effect.fail(new CommandFailed({ reason: "timeout" })),
      }),
      Effect.withSpan("Notifier.command"),
    )

  const deliver = Effect.fn("Notifier.deliver")(function* (notice: Notice) {
    const { notify } = yield* settings.get
    const [webhook, command] = yield* Effect.all(
      [
        attempt(notify.webhook === undefined ? undefined : post(notify.webhook, notice)),
        attempt(notify.command === undefined ? undefined : run(notify.command, notice)),
      ],
      { concurrency: "unbounded" },
    )
    if (webhook !== undefined || command !== undefined) {
      return yield* new NotifyFailed({
        ...(webhook === undefined ? {} : { webhook }),
        ...(command === undefined ? {} : { command }),
      })
    }
  })

  const send = Effect.fn("Notifier.send")(function* (notice: Notice) {
    const { notify } = yield* settings.get
    if (notify.wants(notice.kind)) yield* deliver(notice)
  })

  const test = Effect.gen(function* () {
    const { notify } = yield* settings.get
    if (!notify.enabled) return yield* new NotifyOff()
    yield* deliver(testNotice(yield* DateTime.now))
  }).pipe(Effect.withSpan("Notifier.test"))

  const look = Effect.fn("Notifier.look")(function* (report: Report) {
    const zone = Option.getOrElse(yield* Effect.serviceOption(DateTime.CurrentTimeZone), DateTime.zoneMakeLocal)
    const [changes, next] = watch(yield* Ref.get(conditions), report, zone)
    yield* Ref.set(conditions, next)
    const telling = tell(yield* told.get, report.nudges, report.generatedAt)
    if (telling.changed) yield* told.set(telling.told)
    const notices = [...changes, ...telling.fresh]
    if (notices.length === 0) return
    for (const notice of notices) {
      yield* Effect.logInfo(notice.message)
      yield* events.publish(Event.cases.Notice.make({ notice }))
    }
    const { notify } = yield* settings.get
    if (!notify.enabled) return
    yield* Effect.forEach(
      notices,
      (notice) =>
        send(notice).pipe(Effect.catch((error) => Effect.logWarning(`sending a notification: ${error.message}`))),
      { concurrency: "unbounded", discard: true },
    )
  })

  return { send, test, look } satisfies Shape
})

/** Notices to people. */
export class Notifier extends Context.Service<Notifier, Shape>()("@slopmax/core/Notifier", { make }) {
  static readonly layer: Layer.Layer<
    Notifier,
    never,
    Upstream | SettingsService | Events | Told | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(Notifier, Notifier.make)
}
