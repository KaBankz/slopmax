// The accounts as the app draws them: one group per provider, with each
// usage window as a column, a gauge per account, the pool read as one, the
// limit resets each account holds, and where a new session would go. Pure:
// the report, `now` and the zone to show times in come in as arguments.
import {
  type AccountView,
  conditionTone,
  type LimitReset,
  noteTone,
  type PoolView,
  type PoolWindow,
  providerFacts,
  providerOrder,
  type ProviderId,
  type Report,
  type Span,
  type Tone,
  toneOfUse,
  upcomingReset,
  usedAt,
  Window,
} from "@slopmax/domain"
import { ago, clock, compact, conditionText, day, noteText, pace, percent, until } from "@slopmax/domain/format"
import { DateTime, Duration, Option } from "effect"
import { count, listed, lowercaseFirst, poolBasis, resetCount, titleCase } from "./words.ts"

/** Words in a tone. */
export interface Label {
  readonly text: string
  readonly tone: Tone
}

/** A window's use against spending it evenly until it resets. */
export interface PaceView {
  /** How far through the window it is, 0 to 1: where an even spend would have reached. */
  readonly elapsed: number
  readonly label: Label
}

/** A usage window as a bar. */
export interface Gauge {
  /** How full, 0 to 1. */
  readonly fraction: number
  /** `42%`. */
  readonly percent: string
  /** Time until it resets, when it has use to reset: `2h05m`. */
  readonly resetsIn?: string
  /** When it resets on the local clock: `22:59`, `Wed 20:27`, `Nov 3`. */
  readonly resetsAt?: string
  readonly tone: Tone
  readonly pace?: PaceView
}

/** One account's use of a window, as a segment of the pool's bar. */
export interface Share {
  readonly id: string
  readonly name: string
  /** Its part of the pool: its plan's share where every plan's size is known, else an even part. */
  readonly weight: number
  readonly fraction: number
  readonly tone: Tone
  /** Not serving: turned off, or its sign-in failed. */
  readonly idle: boolean
}

/** One usage window across a provider's accounts. */
export interface Overview {
  readonly title: string
  readonly gauge: Gauge
  readonly shares: ReadonlyArray<Share>
}

/** One limit reset an account holds. */
export interface CreditLine {
  readonly id: string
  readonly title?: string
  /** `Expires Oct 9`, or that it does not. */
  readonly expires: string
  /** `Expires in 2d23h · Oct 9`, or that it does not. */
  readonly line: string
  /** `in 2d23h`. */
  readonly left?: string
  /** `Granted Sep 21`. */
  readonly granted?: string
  /** A warning once it expires within three days. */
  readonly tone: Tone
  /** When it expires, for the redeem dialog. */
  readonly expiresAt?: DateTime.Utc
}

/** An account's limit resets, each of which clears its usage windows at once. */
export interface Credits {
  readonly count: number
  /** `2 limit resets`. */
  readonly title: string
  /** Soonest to expire first; empty until slopmax has listed them. */
  readonly credits: ReadonlyArray<CreditLine>
  /** The windows one clears: `5-hour and weekly`. */
  readonly clears: string
  /** Why none can be redeemed now. */
  readonly held?: string
}

export interface Row {
  readonly id: string
  readonly account: AccountView
  readonly name: string
  /** The plan in title case, `per token` for keys, or empty. */
  readonly plan: string
  /** One gauge per column of the group, or nothing where this account reports no such window. */
  readonly gauges: ReadonlyArray<Gauge | undefined>
  /** Whether each column is faded: the account is off, or another of its windows is full and this one is not. */
  readonly faded: ReadonlyArray<boolean>
  readonly status: Label
  readonly notes: ReadonlyArray<Label>
  readonly pinned: boolean
  readonly disabled: boolean
  readonly signedOut: boolean
  readonly priority: number
  /** `used 3m ago`. */
  readonly lastUsed?: string
  readonly credits?: Credits
  /** Whether a new session would go to it now. */
  readonly next: boolean
  /** The tool whose copy of its login slopmax follows. */
  readonly follows?: string
}

export interface Group {
  readonly provider: ProviderId
  readonly title: string
  /** Whether its accounts have usage windows; keys bill per token. */
  readonly subscription: boolean
  /** The column titles: `5-hour`, `Weekly`, then any limited to one model. */
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Row>
  /** Each window across the working accounts, with every account's share. */
  readonly overview: ReadonlyArray<Overview>
  /** How many working accounts the overview reads as one. */
  readonly working: number
  /** Accounts turned on, and those of them ready for a request. */
  readonly enabled: number
  readonly ready: number
  readonly weighted: boolean
  /** `4 limit resets · the next expires in 2d23h`. */
  readonly credits?: string
  /** Where a new session would go, and why; a warning when none can take one. */
  readonly next: Label
  /** The same, naming the account by its address's local part. */
  readonly nextShort: Label
}

/** How soon a limit reset's expiry is worth a warning. */
export const expiringWithin: Duration.Duration = Duration.hours(72)

/** A kind of usage window: its span and the one model it covers, if any. */
interface Slot {
  readonly span: Span
  readonly model?: string
}

const spanOrder: { readonly [K in Span]: number } = { "5h": 0, "7d": 1, "30d": 2 }
const spanTitles: { readonly [K in Span]: string } = { "5h": "5-hour", "7d": "Weekly", "30d": "Monthly" }

/** `5-hour`, `Weekly`, `Monthly`, or `Weekly · Fable` for a window that covers one model. */
export const windowTitle = (slot: Slot): string =>
  slot.model === undefined ? spanTitles[slot.span] : `${spanTitles[slot.span]} · ${slot.model}`

const holds = (slot: Slot, window: { readonly span: Span; readonly model?: string }) =>
  window.span === slot.span && window.model === slot.model

const bySlot = (a: Slot, b: Slot): number => {
  const scoped = Number(a.model !== undefined) - Number(b.model !== undefined)
  if (scoped !== 0) return scoped
  const span = spanOrder[a.span] - spanOrder[b.span]
  if (span !== 0) return span
  return (a.model ?? "").localeCompare(b.model ?? "")
}

/** Every kind of window the accounts report, shared ones first, shortest first, then those for one model. */
export const slots = (accounts: ReadonlyArray<AccountView>): ReadonlyArray<Slot> => {
  const found: Array<Slot> = []
  for (const account of accounts) {
    for (const window of account.windows) {
      if (!found.some((slot) => holds(slot, window))) {
        found.push(window.model === undefined ? { span: window.span } : { span: window.span, model: window.model })
      }
    }
  }
  return found.toSorted(bySlot)
}

/** Whether an account serves requests: turned on and signed in. */
export const serving = (account: AccountView): boolean => !account.disabled && account.condition._tag !== "SignInNeeded"

/** An address's local part, for narrow places: `ana@example.com` → `ana`. */
export const shortName = (name: string): string => name.split("@")[0] ?? name

const isUnexpired = (reset: LimitReset, now: DateTime.Utc) =>
  reset.expiresAt === undefined || DateTime.isGreaterThan(reset.expiresAt, now)

/** The limit resets an account holds that have not expired, soonest to expire first. */
export const unexpiredResets = (account: AccountView, now: DateTime.Utc): ReadonlyArray<LimitReset> =>
  account.resets.filter((reset) => isUnexpired(reset, now))

/** How many limit resets an account can still redeem: those listed, else the count its usage reports. */
export const resetsLeft = (account: AccountView, now: DateTime.Utc): number => {
  if (account.resets.length > 0) return unexpiredResets(account, now).length
  const note = account.notes.find((n) => n._tag === "Resets")
  return note?._tag === "Resets" ? note.count : 0
}

/** A window as a bar, with its reset and its pace. */
export const gauge = (window: Window, now: DateTime.Utc, zone: DateTime.TimeZone, withPace = true): Gauge => {
  const used = usedAt(window, now)
  const resets = used > 0 ? upcomingReset(window, now) : Option.none<DateTime.Utc>()
  const windowPace = withPace ? pace(window, now, zone) : Option.none()
  return {
    fraction: Math.min(1, Math.max(0, used / 100)),
    percent: percent(used),
    tone: toneOfUse(used),
    ...Option.match(resets, {
      onNone: () => ({}),
      onSome: (at) => ({ resetsIn: until(at, now), resetsAt: clock(at, now, zone) }),
    }),
    ...Option.match(windowPace, {
      onNone: () => ({}),
      onSome: (p) => ({ pace: { elapsed: p.elapsed, label: { text: p.text, tone: p.tone } } }),
    }),
  }
}

/** A pool's window read as one account's, for drawing it the same way. */
const asWindow = (window: PoolWindow): Window => Window.of(window.span, window.used, window.resetsAt)

const creditLine = (reset: LimitReset, now: DateTime.Utc, zone: DateTime.TimeZone): CreditLine => {
  const at = reset.expiresAt
  const soon = at !== undefined && Duration.isLessThan(DateTime.distance(now, at), expiringWithin)
  return {
    id: reset.id,
    ...(reset.title === undefined ? {} : { title: reset.title }),
    expires: at === undefined ? "Does not expire" : `Expires ${clock(at, now, zone)}`,
    line: at === undefined ? "Does not expire" : `Expires in ${until(at, now)} · ${clock(at, now, zone)}`,
    ...(at === undefined ? {} : { left: `in ${until(at, now)}`, expiresAt: at }),
    ...(reset.grantedAt === undefined ? {} : { granted: `Granted ${day(reset.grantedAt, now, zone)}` }),
    tone: soon ? "warn" : "muted",
  }
}

/** An account's limit resets, for a provider that grants them, when it holds any. */
export const credits = (account: AccountView, now: DateTime.Utc, zone: DateTime.TimeZone): Credits | undefined => {
  const left = resetsLeft(account, now)
  if (left === 0 || !providerFacts[account.provider].hasResets) return undefined
  const shared = account.windows.filter((window) => window.model === undefined)
  const held =
    account.condition._tag === "SignInNeeded"
      ? "Sign in again to redeem one"
      : account.disabled
        ? "Turn it on to redeem one"
        : shared.every((window) => usedAt(window, now) <= 0)
          ? "Nothing to reset yet"
          : undefined
  return {
    count: left,
    title: resetCount(left),
    credits: unexpiredResets(account, now).map((reset) => creditLine(reset, now, zone)),
    clears: listed(shared.map((window) => lowercaseFirst(windowTitle(window)))),
    ...(held === undefined ? {} : { held }),
  }
}

const poolCredits = (accounts: ReadonlyArray<AccountView>, now: DateTime.Utc): string | undefined => {
  const total = accounts.reduce((sum, account) => sum + resetsLeft(account, now), 0)
  if (total === 0) return undefined
  const expiries = accounts
    .flatMap((account) => unexpiredResets(account, now))
    .flatMap((reset) => (reset.expiresAt === undefined ? [] : [reset.expiresAt]))
  if (expiries.length === 0) return resetCount(total)
  const next = expiries.reduce((a, b) => (DateTime.isLessThan(b, a) ? b : a))
  return `${resetCount(total)} · the next expires in ${until(next, now)}`
}

/** An account's words beside its condition; limit resets and the pin show elsewhere. */
const notes = (account: AccountView): ReadonlyArray<Label> =>
  account.notes.flatMap((note): ReadonlyArray<Label> => {
    if (note._tag === "Resets" || note._tag === "Pinned") return []
    if (note._tag === "Served") {
      return [{ text: `${count(note.requests, "request")}, ${compact(note.tokens)} tokens all time`, tone: "muted" }]
    }
    return [{ text: noteText(note), tone: noteTone(note) }]
  })

/** An account's condition in its tone, noting a pin unless it is turned off. */
export const status = (account: AccountView, now: DateTime.Utc): Label => {
  const text = conditionText(account.condition, now)
  return {
    text: account.pinned && !account.disabled ? `${text} · pinned` : text,
    tone: conditionTone(account.condition),
  }
}

const row = (
  account: AccountView,
  columns: ReadonlyArray<Slot>,
  next: string | undefined,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): Row => {
  const windows = columns.map((slot) => account.windows.find((window) => holds(slot, window)))
  const full = windows.map((window) => window !== undefined && usedAt(window, now) >= 100)
  const anyFull = full.some(Boolean)
  const metered = providerFacts[account.provider].billing === "metered"
  const accountCredits = credits(account, now, zone)
  return {
    id: account.id,
    account,
    name: account.name,
    plan: account.plan !== undefined ? titleCase(account.plan) : metered ? "per token" : "",
    gauges: windows.map((window) => (window === undefined ? undefined : gauge(window, now, zone))),
    faded: full.map((isFull) => account.disabled || (anyFull && !isFull)),
    status: status(account, now),
    notes: notes(account),
    pinned: account.pinned,
    disabled: account.disabled,
    signedOut: account.condition._tag === "SignInNeeded",
    priority: account.priority,
    ...(account.lastUsed === undefined ? {} : { lastUsed: ago(account.lastUsed, now) }),
    ...(accountCredits === undefined ? {} : { credits: accountCredits }),
    next: next === account.id,
    ...(account.follows === undefined ? {} : { follows: account.follows }),
  }
}

const isReady = (account: AccountView) => account.condition._tag === "Ready" || account.condition._tag === "Active"

const nextLine = (
  pool: PoolView | undefined,
  accounts: ReadonlyArray<AccountView>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
  short: boolean,
): Label => {
  const call = (name: string) => (short ? shortName(name) : name)
  const next = pool?.next
  if (next !== undefined) {
    const name = accounts.find((account) => account.id === next.account)?.name ?? next.account
    return { text: `New sessions → ${call(name)} · ${next.why}`, tone: "muted" }
  }
  let back: { readonly until: DateTime.Utc; readonly name: string } | undefined
  for (const account of accounts) {
    if (account.disabled || account.condition._tag !== "Limited") continue
    const at = account.condition.until
    if (back === undefined || DateTime.isLessThan(at, back.until)) back = { until: at, name: account.name }
  }
  return {
    text:
      back === undefined
        ? "No account can take a new session"
        : `No account can take a new session until ${clock(back.until, now, zone)}, when ${call(back.name)} is back`,
    tone: "warn",
  }
}

/** The accounts grouped by provider, in the order requests try them. */
export const groups = (report: Report, now: DateTime.Utc, zone: DateTime.TimeZone): ReadonlyArray<Group> =>
  providerOrder.flatMap((provider): ReadonlyArray<Group> => {
    const accounts = report.accounts.filter((account) => account.provider === provider)
    if (accounts.length === 0) return []
    const columns = slots(accounts)
    const pool = report.pools.find((p) => p.provider === provider)
    const weighted = pool !== undefined && Object.keys(pool.shares).length > 0
    const weight = (account: AccountView) => (weighted ? (pool.shares[account.id] ?? 0) : 1)
    const overview = columns.flatMap((slot): ReadonlyArray<Overview> => {
      const window =
        pool !== undefined
          ? slot.model === undefined
            ? Option.fromUndefinedOr(pool.windows.find((w) => w.span === slot.span)).pipe(Option.map(asWindow))
            : Option.fromUndefinedOr(pool.scoped.find((w) => holds(slot, w)))
          : accounts.length === 1
            ? Option.fromUndefinedOr(accounts[0]?.windows.find((w) => holds(slot, w)))
            : Option.none()
      if (Option.isNone(window)) return []
      return [
        {
          title: windowTitle(slot),
          // Pooled accounts reset at staggered times, so an even spend of the pool means nothing.
          gauge: gauge(window.value, now, zone, false),
          shares: accounts.map((account) => {
            const own = account.windows.find((w) => holds(slot, w))
            const used = own === undefined ? 0 : usedAt(own, now)
            return {
              id: account.id,
              name: account.name,
              weight: weight(account),
              fraction: Math.min(1, Math.max(0, used / 100)),
              tone: toneOfUse(used),
              idle: !serving(account),
            }
          }),
        },
      ]
    })
    const enabled = accounts.filter((account) => !account.disabled)
    return [
      {
        provider,
        title: providerFacts[provider].title,
        subscription: providerFacts[provider].billing === "subscription",
        columns: columns.map(windowTitle),
        rows: accounts.map((account) => row(account, columns, pool?.next?.account, now, zone)),
        overview,
        working: pool?.accounts ?? accounts.filter(serving).length,
        enabled: enabled.length,
        ready: enabled.filter(isReady).length,
        weighted,
        ...Option.match(Option.fromUndefinedOr(poolCredits(accounts, now)), {
          onNone: () => ({}),
          onSome: (text) => ({ credits: text }),
        }),
        next: nextLine(pool, accounts, now, zone, false),
        nextShort: nextLine(pool, accounts, now, zone, true),
      },
    ]
  })

/** What a pool reads as one: `Across 3 accounts, weighted by plan`, saying when some are out of service. */
export const across = (group: Group): string => {
  const all = group.rows.length
  const basis = poolBasis(group.weighted)
  return group.working >= all
    ? `Across ${count(all, "account")}, ${basis}`
    : `Across ${group.working} of ${count(all, "account")}, ${basis}; the rest are out of service`
}
