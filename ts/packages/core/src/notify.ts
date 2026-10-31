// Notifications: a webhook or command told when something needs the user's
// attention. A watcher compares each account's condition with the one it
// saw last, so every change is reported exactly once.
//
// `Settings` and `Kind` are `[notify]`'s, and live with the rest of the
// config's schema (`config.ts`).
import process from "node:process"

import { Effect, Schema } from "effect"

import { fmt, human, SignedDuration, Timestamp, TimestampFromString } from "@slopmax/common"
import type { Client } from "@slopmax/net"

import { Account } from "./account.ts"
import { type NotifyKind, NotifyKindSchema, type NotifySettings } from "./config.ts"
import { chain, context, Failure } from "./error.ts"
import { Window } from "./limits.ts"
import { AccountState } from "./pool.ts"
import * as proc from "./proc.ts"
import { ProviderId, ProviderIdSchema } from "./provider/mod.ts"
import type { AccountReport } from "./report.ts"
import { byteOrder, F64, opt } from "./serde.ts"
import * as waste from "./waste.ts"

export { NotifySettings as Settings, NotifySettingsSchema as SettingsSchema } from "./config.ts"

/** What happened. */
export type Kind = NotifyKind
export const KindSchema = NotifyKindSchema

/** How long a notification command may run before it is killed. */
const COMMAND_TIMEOUT = "30 seconds"

/**
 * Sent unless `events` says otherwise: the ones that need action or
 * explain failing requests. Per-account limits come and go all day.
 */
export const DEFAULT_EVENTS: ReadonlyArray<Kind> = [
  "exhausted",
  "recovered",
  "signed-out",
  "reset-expiring",
  "quota-unused",
]

export const Kind = {
  asStr: (self: Kind): string => self,
} as const

/** One notification. */
export const EventSchema = Schema.Struct({
  event: NotifyKindSchema,
  provider: opt(ProviderIdSchema),
  /** The account's display name. */
  account: opt(Schema.String),
  /** When the account or provider is expected back. */
  until: opt(TimestampFromString),
  message: Schema.String,
  at: TimestampFromString,
  /** For a nudge about unused quota: what it is worth, in dollars of the plan. */
  worth: opt(F64),
})

export type Event = typeof EventSchema.Type

export const Event = {
  test: (now: Timestamp): Event => ({ event: "test", message: "slopmax notifications are working.", at: now }),
} as const

/** Whether `settings` sends events of `kind`: `test` always, the rest as `events` (or the defaults) say. */
export const wants = (settings: NotifySettings, kind: Kind): boolean => {
  const events = settings.events.length === 0 ? DEFAULT_EVENTS : settings.events
  return kind === "test" || events.includes(kind)
}

const encodeEvent = Schema.encodeEffect(EventSchema)

/** Delivers `event` everywhere it is configured to go, if wanted. */
export const send = Effect.fn("notify.send")(function* (settings: NotifySettings, http: Client, event: Event) {
  if (!wants(settings, event.event)) return
  const failures: Array<string> = []
  if (settings.webhook !== undefined) {
    const posted = yield* Effect.result(post(http, settings.webhook, event))
    if (posted._tag === "Failure") failures.push(`webhook: ${chain(posted.failure)}`)
  }
  if (settings.command !== undefined) {
    const ran = yield* Effect.result(run(settings.command, event))
    if (ran._tag === "Failure") failures.push(`command: ${chain(ran.failure)}`)
  }
  if (failures.length > 0) return yield* Effect.fail(new Failure({ message: failures.join("; ") }))
})

/**
 * POSTs the event as JSON. `text` and `content` repeat the message so
 * Slack- and Discord-style webhooks show it as is.
 */
const post = Effect.fn("notify.post")(function* (http: Client, url: string, event: Event) {
  const body = { ...(yield* encodeEvent(event)), text: event.message, content: event.message }
  const response = yield* http.post(url).json(body).send()
  yield* response.errorForStatus()
})

const run = Effect.fn("notify.run")(function* (command: string, event: Event) {
  const [shell, flag] = process.platform === "win32" ? ["cmd", "/C"] : ["sh", "-c"]
  const env = {
    SLOPMAX_EVENT: event.event,
    SLOPMAX_PROVIDER: event.provider ?? "",
    SLOPMAX_ACCOUNT: event.account ?? "",
    SLOPMAX_UNTIL: event.until === undefined ? "" : Timestamp.display(event.until),
    SLOPMAX_MESSAGE: event.message,
  }
  const output = yield* proc.output(shell, [flag, command], { env }).pipe(
    context("could not start it"),
    Effect.timeoutOrElse({
      duration: COMMAND_TIMEOUT,
      orElse: () =>
        Effect.fail(new Failure({ message: "timed out", cause: new Failure({ message: "deadline has elapsed" }) })),
    }),
  )
  if (!proc.ExitStatus.success(output.status)) {
    const stderr = proc.text(output.stderr).trim()
    return yield* Effect.fail(new Failure({ message: `${proc.ExitStatus.display(output.status)}: ${stderr}` }))
  }
})

/** How long before it lapses a limit reset is worth a nudge, and a week's unused quota too. */
export const NUDGE_AHEAD: SignedDuration = SignedDuration.fromHours(24)
/** The share of a week, in percent, left unused that is worth a nudge. */
export const UNUSED_WORTH_A_NUDGE = 25.0

/** An account as nudges see it. */
export interface Subject {
  readonly id: string
  readonly name: string
  readonly provider: ProviderId
  readonly plan: string | undefined
  /** Disabled or signed out: nothing to nudge about. */
  readonly off: boolean
  readonly state: AccountState
}

export const Subject = {
  of: (report: AccountReport): Subject => ({
    id: report.id,
    name: report.name,
    provider: report.provider,
    plan: report.plan,
    off: report.disabled || report.authError !== undefined,
    state: report.state,
  }),
} as const

/** A nudge's key, which names it so it is told once, and the event. */
export type Nudge = readonly [key: string, event: Event]

/**
 * Things worth doing before they are lost: a limit reset that will lapse
 * unredeemed, and a week about to reset with quota to spare. Each comes
 * with a key that names it, so it is told once. `autoRedeem` is
 * `redeem_expiring_credits`, which spends lapsing resets by itself.
 */
export const nudges = (
  accounts: ReadonlyArray<Subject>,
  autoRedeem: boolean,
  planPrices: Readonly<Record<string, number>>,
  now: Timestamp,
): Array<Nudge> => {
  const horizon = Timestamp.add(now, NUDGE_AHEAD)
  const found: Array<Nudge> = []
  for (const account of accounts) {
    if (account.off) continue
    const event = (kind: Kind, until: Timestamp, message: string): Event => ({
      event: kind,
      provider: account.provider,
      account: account.name,
      until,
      message,
      at: now,
    })
    if (!autoRedeem) {
      for (const credit of AccountState.unexpiredCredits(account.state, now)) {
        const expires = credit.expiresAt
        if (expires === undefined || expires > horizon) continue
        const key = `reset:${account.id}:${credit.id}`
        const message = `A limit reset on ${account.name} expires ${when(expires, now)}; redeem it with \`slopmax redeem ${account.name}\` before it is lost.`
        found.push([key, event("reset-expiring", expires, message)])
      }
    }
    const long = account.state.limits.windows.filter(
      (w) => w.model === undefined && (w.span === "7d" || w.span === "30d"),
    )
    for (const window of long) {
      const resets = Window.upcomingReset(window, now)
      if (resets === undefined || resets > horizon) continue
      const unused = 100.0 - Math.min(100, Math.max(0, Window.usedAt(window, now)))
      if (unused < UNUSED_WORTH_A_NUDGE || AccountState.isBlocked(account.state, now)) continue
      const dollars = waste.value(account.provider, account.plan, window.span, undefined, 100.0 - unused, planPrices)
      const worth = dollars !== undefined && dollars >= 0.5 ? `, about $${fmt.fixed(dollars, 0)} of its plan` : ""
      const period = window.span === "30d" ? "month" : "week"
      const key = `unused:${account.id}:${window.span}:${Timestamp.asSecond(resets)}`
      const message = `${account.name}'s ${period} resets ${when(resets, now)} with ${fmt.fixed(unused, 0)}% of it unused${worth}. Work sent there before then costs nothing extra.`
      const nudge = event("quota-unused", resets, message)
      found.push([key, dollars === undefined ? nudge : { ...nudge, worth: dollars }])
    }
  }
  return found
}

/** An account's condition, as far as notifications care. */
type Condition =
  | "ready"
  | "limited"
  | "signed-out"
  /** Disabled by the user: none of our business. */
  | "off"

/** Turns successive looks at the pool into events. */
export class Watcher {
  private readonly accounts = new Map<string, Condition>()
  private readonly exhausted = new Map<ProviderId, boolean>()
  private primed = false
  /** The keys of the nudges told already. */
  private readonly toldKeys = new Set<string>()

  /**
   * A watcher that remembers the nudges told before, as `told` lists their
   * keys, so a restart doesn't tell them again.
   */
  static remembering(told: Iterable<string>): Watcher {
    const watcher = new Watcher()
    for (const key of told) watcher.toldKeys.add(key)
    return watcher
  }

  /** The keys of the nudges told so far. */
  told(): Array<string> {
    return [...this.toldKeys].toSorted(byteOrder)
  }

  /** The `nudges` not told before. */
  newNudges(found: ReadonlyArray<Nudge>): Array<Event> {
    const fresh: Array<Event> = []
    for (const [key, event] of found) {
      if (this.toldKeys.has(key)) continue
      this.toldKeys.add(key)
      fresh.push(event)
    }
    return fresh
  }

  /**
   * What changed since the previous call. The first call only takes stock:
   * conditions that predate the proxy are not news.
   */
  changes(accounts: ReadonlyArray<Account>, stateOf: (id: string) => AccountState, now: Timestamp): Array<Event> {
    const event = (
      kind: Kind,
      provider: ProviderId,
      account: Account | undefined,
      until: Timestamp | undefined,
      message: string,
    ): Event => ({
      event: kind,
      provider,
      ...(account === undefined ? {} : { account: Account.name(account) }),
      ...(until === undefined ? {} : { until }),
      message,
      at: now,
    })
    const events: Array<Event> = []
    for (const provider of ProviderId.ALL) {
      const mine = accounts
        .filter((a) => a.provider === provider)
        .map((a) => {
          const until = AccountState.limitedUntil(stateOf(a.id), now)
          const condition: Condition = a.disabled
            ? "off"
            : a.authError !== undefined
              ? "signed-out"
              : until !== undefined
                ? "limited"
                : "ready"
          return { account: a, condition, until }
        })
      const serving = mine.filter((m) => m.condition !== "off")
      const exhausted = serving.length > 0 && serving.every((m) => m.condition !== "ready")
      const wasExhausted = this.exhausted.get(provider) ?? false
      this.exhausted.set(provider, exhausted)
      let soonest: Timestamp | undefined
      for (const m of serving) {
        if (m.until !== undefined && (soonest === undefined || m.until < soonest)) soonest = m.until
      }
      const title = ProviderId.spec(provider).title

      for (const { account, condition, until } of mine) {
        const before = this.accounts.get(account.id)
        this.accounts.set(account.id, condition)
        if (!this.primed || before === undefined || before === condition) continue
        const name = Account.name(account)
        // An exhausted pool is one event, not one per account.
        if (condition === "limited" && (!exhausted || wasExhausted)) {
          events.push(event("limited", provider, account, until, `${name} hit a usage limit${back(until, now)}.`))
        } else if (condition === "ready" && before === "limited") {
          events.push(event("available", provider, account, undefined, `${name} can serve requests again.`))
        } else if (condition === "signed-out") {
          events.push(
            event(
              "signed-out",
              provider,
              account,
              undefined,
              `${name} is signed out (${account.authError ?? "unknown reason"}); run \`slopmax login ${provider}\` to sign in again.`,
            ),
          )
        }
      }
      if (!this.primed || exhausted === wasExhausted) continue
      events.push(
        exhausted
          ? event(
              "exhausted",
              provider,
              undefined,
              soonest,
              `Every ${title} account is limited or signed out, so ${title} requests fail${soonest === undefined ? "" : ` until ${when(soonest, now)}`}.`,
            )
          : event("recovered", provider, undefined, undefined, `${title} requests are being served again.`),
      )
    }
    // Forget removed accounts, so a re-added one starts fresh.
    for (const id of this.accounts.keys()) {
      if (!accounts.some((a) => a.id === id)) this.accounts.delete(id)
    }
    this.primed = true
    return events
  }
}

const back = (until: Timestamp | undefined, now: Timestamp): string =>
  until !== undefined && until > now ? `; back ${when(until, now)}` : ""

/** `in 2h05m (14:00)`, in local time. */
export const when = (at: Timestamp, now: Timestamp): string => {
  const local = Timestamp.localOffset(at)
  const [hour, minute] = Timestamp.timeOfDay(at, local)
  return `in ${human.until(at, now)} (${fmt.zeroPad(hour, 2)}:${fmt.zeroPad(minute, 2)})`
}
