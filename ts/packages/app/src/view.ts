// What a window draws, worked out once for every UI: the accounts grouped
// by provider with their gauges and status, the lines about the proxy,
// agents, and service, a sign-in's instructions, and the menu bar's line.
// Account words come from the core, so they read as `slopmax status` does.
import {
  type agent,
  config as configs,
  type Config,
  daemon,
  type doctor,
  fmt,
  type history,
  human,
  limits,
  pool as pools,
  provider,
  ProviderId,
  report,
  serde,
  type service,
  time,
} from "@slopmax/core"

import type { AgentStatus, Setting, SignIn, Snapshot } from "./lib.ts"

type Timestamp = time.Timestamp
type SignedDuration = time.SignedDuration
const { SignedDuration, Timestamp } = time
type Tone = report.Tone
type Window = limits.Window
const { Window } = limits
type AccountReport = report.AccountReport
const { AccountReport } = report

/** One provider's accounts. */
export interface Group {
  readonly provider: ProviderId
  readonly title: string
  /** Whether its accounts have usage windows; keys bill per token. */
  readonly subscription: boolean
  /**
   * The usage windows its accounts report, as columns: `5-hour`, `Weekly`,
   * then any limited to one model, such as `Weekly · Fable`.
   */
  readonly limits: ReadonlyArray<string>
  readonly accounts: ReadonlyArray<Row>
  /**
   * Each window across the working accounts, as agents see them, with
   * every account's share of it. Empty for keys.
   */
  readonly overview: ReadonlyArray<Overview>
  /** How many working accounts the overview reads as one. */
  readonly working: number
  /** Whether the pool weighs its accounts by their plans' sizes, rather than averaging them. */
  readonly weighted: boolean
  /** Its accounts' limit resets, and when the next expires: `4 limit resets · the next expires in 2d23h`. */
  readonly credits: string | undefined
  /**
   * Where a new session would go now, and why: `New sessions → claude0 ·
   * its quota resets soonest`; a warning when none can take one.
   */
  readonly next: Label
  /** The same, short, for the menu bar panel: `New sessions → claude0 · its quota resets soonest`. */
  readonly nextShort: Label
}

export interface Row {
  readonly id: string
  readonly name: string
  /** The plan, or how a key is billed. */
  readonly plan: string
  /** A gauge for each of the group's `limits`, or undefined where this account reports no such window. */
  readonly limits: ReadonlyArray<Gauge | undefined>
  readonly status: Label
  readonly notes: ReadonlyArray<Label>
  readonly pinned: boolean
  readonly disabled: boolean
  readonly priority: number
  /** When it last answered: `used 3m ago`. */
  readonly lastUsed: string | undefined
  /** Its reset credits, when it has any. */
  readonly credits: Credits | undefined
  /** Whether a new session would go to it now. */
  readonly next: boolean
  /**
   * The tool whose copy of its login slopmax follows, such as Claude
   * Code, rather than refreshing it itself.
   */
  readonly follows: string | undefined
}

/** An account's reset credits, each of which clears its usage windows at once. */
export interface Credits {
  /** `2 limit resets`. */
  readonly title: string
  /** Soonest to expire first; empty until slopmax has listed them. */
  readonly credits: ReadonlyArray<CreditLine>
  /** The windows one clears: `5-hour and weekly`. */
  readonly clears: string
  /** Why none can be redeemed now: nothing to reset yet, or the account is off or signed out. */
  readonly held: string | undefined
}

/** One reset credit. */
export interface CreditLine {
  /** `Expires Oct 9`, or that it does not. */
  readonly expires: string
  /** `Expires in 2d23h · Oct 9`, or that it does not, as the dashboard says it. */
  readonly line: string
  /** `in 2d23h`. */
  readonly left: string | undefined
  /** `Granted Sep 21`, when the provider says. */
  readonly granted: string | undefined
  /** A warning once it expires within `EXPIRING`. */
  readonly tone: Tone
}

/** How soon a credit's expiry is worth a warning. */
const EXPIRING: SignedDuration = SignedDuration.fromHours(72)

/** One usage window across a provider's accounts. */
export interface Overview {
  readonly title: string
  /** The working accounts' use, read as one. */
  readonly gauge: Gauge
  /** Each account's use of it, in the group's order. */
  readonly shares: ReadonlyArray<Share>
}

/** One account's use of a window, as a segment of the overview's bar. */
export interface Share {
  /** Its part of the pool, by its plan's size where every plan's is known; else an even part. */
  readonly weight: number
  readonly fraction: number
  readonly tone: Tone
  /** Not serving: disabled, or its sign-in failed. */
  readonly idle: boolean
}

/** A usage window as a bar. */
export interface Gauge {
  /** How full, from 0 to 1. */
  readonly fraction: number
  /** `42%`. */
  readonly percent: string
  /** Time until it resets, when it has use to reset: `2h05m`. */
  readonly resetsIn: string | undefined
  /** When it resets on this machine's clock: `22:59` today, `Wed 20:27` within the week, `Nov 3` after. */
  readonly resetsAt: string | undefined
  readonly tone: Tone
  /** How the use compares with spending the window evenly until it resets. */
  readonly pace: Pace | undefined
}

/** A window's use against an even spend. */
export interface Pace {
  /** How far through the window it is, from 0 to 1: where an even spend would have reached. */
  readonly elapsed: number
  /** `On pace`, `Runs out ~14:10`, or `18% in reserve`. */
  readonly label: Label
}

export interface Label {
  readonly text: string
  readonly tone: Tone
}

/** How the accounts stand, in a line: what an overview leads with. */
export interface Status {
  /** `All 4 accounts are ready`, or `3 of 4 accounts are ready`. */
  readonly headline: string
  /** What keeps the rest: `1 limited · 1 needs signing in`. */
  readonly detail: string | undefined
  readonly tone: Tone
}

export const status = (self: report.Report, now: Timestamp): Status => {
  const enabled = self.accounts.filter((a) => !a.disabled).map((a) => AccountReport.condition(a, now))
  const ready = enabled.filter((c) => c._tag === "Ready" || c._tag === "Active").length
  const limited = enabled.filter((c) => c._tag === "Limited" || c._tag === "Throttled").length
  const signedOut = enabled.filter((c) => c._tag === "SignInNeeded").length
  const off = self.accounts.length - enabled.length
  const n = enabled.length
  const headline =
    n === 0
      ? off === 0
        ? "No accounts yet"
        : "Every account is turned off"
      : n === 1 && ready === 1
        ? "Your account is ready"
        : ready === n
          ? `All ${n} accounts are ready`
          : `${ready} of ${n} accounts are ready`
  const parts: Array<string> = []
  if (limited > 0) parts.push(`${limited} limited`)
  if (signedOut === 1) parts.push("1 needs signing in")
  else if (signedOut > 1) parts.push(`${signedOut} need signing in`)
  if (off > 0) parts.push(`${off} turned off`)
  return {
    headline,
    detail: parts.length > 0 ? parts.join(" · ") : undefined,
    tone: signedOut > 0 ? "bad" : limited > 0 ? "warn" : "good",
  }
}

/** What a notice that wants a look offers to do about it. */
export type Remedy =
  /** Sign in to the account again. */
  | "SignIn"
  /** Redeem one of its reset credits. */
  | "Redeem"
  /** Look at the account. */
  | "Look"

/** Something about an account that wants a look. */
export interface Attention {
  readonly provider: ProviderId
  /** The account's id. */
  readonly account: string
  readonly text: string
  /**
   * The same, short, for the menu bar panel: who, by the local part of
   * their address, and what and when, which a narrow line keeps whole.
   */
  readonly who: string
  readonly what: string
  readonly tone: Tone
  readonly remedy: Remedy
}

/** An account's name, short: an address's local part. */
const shortName = (name: string): string => name.split("@")[0] ?? name

// This machine's clock at `at`.
const local = (at: Timestamp, now: Timestamp): string => clock(at, now, Timestamp.localOffset(at))

/**
 * What wants a look, most pressing first: an account signed out, one
 * limited that holds a reset credit, a window running out before it
 * resets, and a reset credit soon to expire. An account merely limited is
 * slopmax's to work around, and wants nothing.
 */
export const attention = (self: report.Report, now: Timestamp): Array<Attention> => {
  const found: Array<Attention> = []
  for (const account of self.accounts.filter((a) => !a.disabled)) {
    const note = (text: string, what: string, tone: Tone, remedy: Remedy): Attention => ({
      provider: account.provider,
      account: account.id,
      text,
      who: shortName(account.name),
      what,
      tone,
      remedy,
    })
    const credits = pools.AccountState.creditsLeft(account.state, now)
    const condition = AccountReport.condition(account, now)
    if (condition._tag === "SignInNeeded") {
      found.push(note(`${account.name} needs signing in again`, "sign in again", "bad", "SignIn"))
      continue
    }
    if (condition._tag === "Limited") {
      if (credits === 0) continue
      const until = local(condition.until, now)
      found.push(
        note(
          `${account.name} is limited until ${until}, and holds ${creditCount(credits)}`,
          `limited until ${until}, ${creditCount(credits)} held`,
          "warn",
          "Redeem",
        ),
      )
    }
    for (const window of account.state.limits.windows.filter((w) => w.model === undefined)) {
      const paced = pace(window, Window.usedAt(window, now), now)
      if (paced === undefined || paced.label.tone !== "warn") continue
      const title = lowercaseFirst(Slot.title(Slot.ofWindow(window)))
      const label = lowercaseFirst(paced.label.text)
      found.push(note(`${account.name}'s ${title} window ${label}`, `${title} ${label}`, "warn", "Look"))
    }
    const at = pools.AccountState.unexpiredCredits(account.state, now).find((c) => c.expiresAt !== undefined)?.expiresAt
    if (at !== undefined && Timestamp.durationSince(at, now) < EXPIRING) {
      // slopmax would redeem it by itself unless a nudge says it won't.
      const held = self.nudges.some((n) => n.event === "reset-expiring" && n.account === account.name)
      found.push(
        note(
          `A limit reset on ${account.name} expires in ${human.until(at, now)} · ${local(at, now)}${held ? "; auto-redeem is off" : ""}`,
          `reset expires in ${human.until(at, now)}`,
          "warn",
          "Redeem",
        ),
      )
    }
  }
  addNudges(found, self, now)
  // Stable: what is bad first, the rest as found.
  return found.toSorted((a, b) => Number(a.tone !== "bad") - Number(b.tone !== "bad"))
}

/**
 * @internal Adds the report's nudges to what wants a look, leaving out a
 * limit reset the list already offers to redeem; exported for tests.
 */
export const addNudges = (found: Array<Attention>, self: report.Report, now: Timestamp): void => {
  for (const nudge of self.nudges) {
    const account = nudge.account === undefined ? undefined : self.accounts.find((a) => a.name === nudge.account)
    if (account === undefined) continue
    const until = nudge.until ?? now
    const item = (text: string, what: string, remedy: Remedy): Attention => ({
      provider: account.provider,
      account: account.id,
      text,
      who: shortName(account.name),
      what,
      tone: "warn",
      remedy,
    })
    switch (nudge.event) {
      case "reset-expiring":
        // The list may already offer to redeem it, above.
        if (found.some((f) => f.account === account.id && f.remedy === "Redeem")) continue
        found.push(item(firstSentence(nudge.message), `reset expires in ${human.until(until, now)}`, "Redeem"))
        break
      case "quota-unused": {
        // Quota about to go to waste: amber, as on the dashboard.
        const [period, unused] = unusedAtReset(account, now)
        const worth =
          nudge.worth !== undefined && nudge.worth >= 0.5 ? `, about $${fmt.fixed(nudge.worth, 0)} of its plan` : ""
        const left = human.until(until, now)
        found.push(
          item(
            `${account.name}'s ${period} resets in ${left} · ${local(until, now)} with ${fmt.fixed(unused, 0)}% of it unused${worth}`,
            `${period} ends in ${left}, ${fmt.fixed(unused, 0)}% unused`,
            "Look",
          ),
        )
        break
      }
      default:
        continue
    }
  }
}

/** An account's long window, `week` or `month`, and how much of it is unused, in percent. */
const unusedAtReset = (account: AccountReport, now: Timestamp): readonly [string, number] => {
  const long = account.state.limits.windows.find((w) => w.model === undefined && (w.span === "7d" || w.span === "30d"))
  if (long === undefined) return ["week", 0]
  return [long.span === "30d" ? "month" : "week", 100 - Math.min(100, Math.max(0, Window.usedAt(long, now)))]
}

/**
 * A message's first sentence, without its full stop or the marks around a
 * command, and its times as the window sets them: `in 19h59m (19:12)` as
 * `in 19h59m · 19:12`.
 */
const firstSentence = (message: string): string => {
  const first = message.split(". ")[0] ?? message
  let text = first.replace(/\.+$/, "").replaceAll("`", "")
  for (;;) {
    const open = text.indexOf(" (")
    if (open < 0) break
    const close = text.indexOf(")", open)
    if (close < 0) break
    text = `${text.slice(0, open)} · ${text.slice(open + 2, close)}${text.slice(close + 1)}`
  }
  return text
}

/** The accounts grouped by provider, in the order requests try them. */
export const groups = (self: report.Report, now: Timestamp): Array<Group> => {
  const found: Array<Group> = []
  for (const id of ProviderId.ALL) {
    const accounts = self.accounts.filter((a) => a.provider === id)
    if (accounts.length === 0) continue
    const columns = slots(accounts)
    const pool = self.pools.find((p) => p.provider === id)
    const shares = pool !== undefined && Object.keys(pool.shares).length > 0 ? pool.shares : undefined
    const weight = (account: AccountReport): number => (shares === undefined ? 1.0 : (shares[account.id] ?? 0.0))
    const overview: Array<Overview> = []
    for (const slot of columns) {
      // The pool's window, or a lone account's own.
      const window =
        pool !== undefined
          ? pool.windows.find((w) => Slot.holds(slot, w))
          : accounts.length === 1 && accounts[0] !== undefined
            ? Slot.of(slot, accounts[0])
            : undefined
      if (window === undefined) continue
      overview.push({
        title: Slot.title(slot),
        // Pooled accounts reset at staggered times, so an even spend of the
        // pool means nothing.
        gauge: { ...gauge(window, now), pace: undefined },
        shares: accounts.map((a) => share(a, slot, weight(a), now)),
      })
    }
    const next = pool?.next
    const rows = accounts.map((a) => ({ ...row(a, columns, now), next: next !== undefined && next.account === a.id }))
    const spec = ProviderId.spec(id)
    found.push({
      provider: id,
      title: spec.title,
      subscription: provider.Spec.isSubscription(spec),
      limits: columns.map(Slot.title),
      accounts: rows,
      overview,
      working: pool === undefined ? accounts.filter(serving).length : pool.accounts,
      weighted: shares !== undefined,
      credits: poolCredits(accounts, now),
      next: nextLine(next, accounts, now, false),
      nextShort: nextLine(next, accounts, now, true),
    })
  }
  return found
}

/**
 * Where a new session goes, worded: the account and why, or, when none can
 * take one, when the soonest is back. With `short`, an account goes by its
 * address's local part.
 */
const nextLine = (
  next: report.NextReport | undefined,
  accounts: ReadonlyArray<AccountReport>,
  now: Timestamp,
  short: boolean,
): Label => {
  const call = (name: string): string => (short ? shortName(name) : name)
  if (next !== undefined) {
    const name = call(accounts.find((a) => a.id === next.account)?.name ?? next.account)
    return { text: `New sessions → ${name} · ${next.why}`, tone: "muted" }
  }
  let back: readonly [Timestamp, string] | undefined
  for (const a of accounts) {
    if (a.disabled) continue
    const condition = AccountReport.condition(a, now)
    // `min_by_key`: the first of the soonest.
    if (condition._tag === "Limited" && (back === undefined || condition.until < back[0])) {
      back = [condition.until, a.name]
    }
  }
  return {
    text:
      back === undefined
        ? "No account can take a new session"
        : `No account can take a new session until ${local(back[0], now)}, when ${call(back[1])} is back`,
    tone: "warn",
  }
}

/**
 * A kind of usage window: its span, and the model it is limited to. Sorts
 * windows covering every request first, shortest first, then the rest.
 */
interface Slot {
  readonly scoped: boolean
  readonly order: number
  readonly span: string
  readonly model: string | undefined
}

const Slot = {
  ofWindow: (window: Window): Slot => ({
    scoped: window.model !== undefined,
    order: window.span === "5h" ? 0 : window.span === "7d" ? 1 : window.span === "30d" ? 2 : 3,
    span: window.span,
    model: window.model,
  }),

  holds: (self: Slot, window: Window): boolean => window.span === self.span && window.model === self.model,

  of: (self: Slot, account: AccountReport): Window | undefined =>
    account.state.limits.windows.find((w) => Slot.holds(self, w)),

  title: (self: Slot): string => {
    const span =
      self.span === "5h" ? "5-hour" : self.span === "7d" ? "Weekly" : self.span === "30d" ? "Monthly" : self.span
    return self.model === undefined ? span : `${span} · ${self.model}`
  },

  // The derived `Ord`: field by field, `None` before `Some`, strings by bytes.
  compare: (a: Slot, b: Slot): number => {
    if (a.scoped !== b.scoped) return a.scoped ? 1 : -1
    if (a.order !== b.order) return a.order - b.order
    const span = serde.byteOrder(a.span, b.span)
    if (span !== 0) return span
    if (a.model === b.model) return 0
    if (a.model === undefined) return -1
    if (b.model === undefined) return 1
    return serde.byteOrder(a.model, b.model)
  },
} as const

/** Every kind of window the accounts report, in column order. */
const slots = (accounts: ReadonlyArray<AccountReport>): Array<Slot> => {
  const all = accounts.flatMap((a) => a.state.limits.windows.map(Slot.ofWindow)).toSorted(Slot.compare)
  return all.filter((slot, i) => {
    const previous = all[i - 1]
    return previous === undefined || Slot.compare(previous, slot) !== 0
  })
}

/** A provider's reset credits across its accounts, and the next to expire. */
const poolCredits = (accounts: ReadonlyArray<AccountReport>, now: Timestamp): string | undefined => {
  const total = accounts.reduce((sum, a) => sum + pools.AccountState.creditsLeft(a.state, now), 0)
  if (total === 0) return undefined
  let next: Timestamp | undefined
  for (const a of accounts) {
    for (const c of pools.AccountState.unexpiredCredits(a.state, now)) {
      if (c.expiresAt !== undefined && (next === undefined || c.expiresAt < next)) next = c.expiresAt
    }
  }
  const count = creditCount(total)
  return next === undefined ? count : `${count} · the next expires in ${human.until(next, now)}`
}

const creditCount = (n: number): string => (n === 1 ? "1 limit reset" : `${n} limit resets`)

/** The account's reset credits, for a provider that grants them. */
const credits = (account: AccountReport, now: Timestamp): Credits | undefined => {
  const state = account.state
  const left = pools.AccountState.creditsLeft(state, now)
  if (left === 0 || ProviderId.get(account.provider).credits() === undefined) return undefined
  const windows = state.limits.windows.filter((w) => w.model === undefined)
  const clears = windows.map((w) => lowercaseFirst(Slot.title(Slot.ofWindow(w))))
  const held =
    account.authError !== undefined
      ? "Sign in again to redeem one"
      : account.disabled
        ? "Turn it on to redeem one"
        : windows.every((w) => Window.usedAt(w, now) <= 0)
          ? "Nothing to reset yet"
          : undefined
  return {
    title: creditCount(left),
    credits: pools.AccountState.unexpiredCredits(state, now).map((c) => creditLine(c, now)),
    clears: listed(clears),
    held,
  }
}

const creditLine = (credit: provider.credits.Credit, now: Timestamp): CreditLine => {
  const at = credit.expiresAt
  return {
    expires: at === undefined ? "Does not expire" : `Expires ${local(at, now)}`,
    line: at === undefined ? "Does not expire" : `Expires in ${human.until(at, now)} · ${local(at, now)}`,
    left: at === undefined ? undefined : `in ${human.until(at, now)}`,
    granted:
      credit.grantedAt === undefined
        ? undefined
        : `Granted ${day(credit.grantedAt, now, Timestamp.localOffset(credit.grantedAt))}`,
    tone: at !== undefined && Timestamp.durationSince(at, now) < EXPIRING ? "warn" : "muted",
  }
}

const LEAD_HOURS = Math.trunc(SignedDuration.asSecs(daemon.CREDIT_EXPIRY_LEAD) / 3_600)

/** When slopmax redeems the reset credits of the provider titled `title` by itself, as `config` has it, if it does. */
export const autoRedeem = (config: Config, title: string): string | undefined => {
  if (config.redeemWhenExhausted && config.redeemExpiringCredits) {
    return `slopmax redeems one by itself when every ${title} account is spent, and ${LEAD_HOURS} hours before one would expire unused.`
  }
  if (config.redeemExpiringCredits) {
    return `slopmax redeems one by itself ${LEAD_HOURS} hours before it would expire unused, if the account has quota to reset.`
  }
  if (config.redeemWhenExhausted) return `slopmax redeems one by itself when every ${title} account is spent.`
  return undefined
}

/** A strategy's name, as Settings lists it: `Reset first`. */
export const strategyTitle = (strategy: configs.Strategy): string => {
  switch (strategy) {
    case "reset-first":
      return "Reset first"
    case "fill-first":
      return "Fill first"
    case "least-used":
      return "Least used"
    case "round-robin":
      return "Round robin"
  }
}

/** What a strategy does, as a sentence. */
export const strategyDetail = (strategy: configs.Strategy): string => `${configs.Strategy.summary(strategy)}.`

/** How requests find their account, in a line: `Reset first · sessions keep their account`. */
export const routing = (config: Config): string =>
  `${strategyTitle(config.strategy)} · ${config.sessionAffinity ? "sessions keep their account" : "sessions move between accounts"}`

/** What session affinity does. */
export const AFFINITY =
  "Keep a conversation on the account it started on, so its prompt cache stays warm. Off, the strategy places every request."

/** How one request can ask otherwise. */
export const AFFINITY_HEADER = "A request can ask otherwise with the x-slopmax-affinity header, set to on or off."

/** What `redeem_expiring_credits` does. */
export const redeemExpiringDetail = (): string =>
  `Redeem it ${LEAD_HOURS} hours before, if the account has quota to reset.`

/** What `redeem_when_exhausted` does. */
export const REDEEM_EXHAUSTED = "Redeem one so the pool keeps serving, rather than wait for a reset."

/** What the app says once `setting` is changed. */
export const settingChanged = (setting: Setting): string => {
  switch (setting._tag) {
    case "Strategy":
      return `slopmax now routes ${strategyTitle(setting.value).toLowerCase()}.`
    case "SessionAffinity":
      return setting.value ? "Sessions keep the account they started on." : "The strategy now places every request."
    case "RedeemExpiringCredits":
      return setting.value ? "Limit resets are redeemed before they expire." : "Limit resets are left to expire."
    case "RedeemWhenExhausted":
      return setting.value
        ? "A limit reset is redeemed once every account is spent."
        : "Once every account is spent, the pool waits for a reset."
    case "SessionTtlMins":
      return `A session keeps its account through ${minutes(setting.value)} idle.`
    case "WarmWindows":
      return setting.value ? "Idle ChatGPT windows start as they reset." : "Idle windows wait for their first request."
    case "PaidOverflow":
      return setting.value
        ? "API keys take over once subscriptions are limited."
        : "API keys serve a subscription's models only when asked for by name."
    case "PollMins":
      return setting.value === 0
        ? "slopmax no longer polls usage."
        : `slopmax polls usage every ${minutes(setting.value)}.`
  }
}

/** A live setting's description, as `slopmax config` lists it, as a sentence. */
export const liveDetail = (name: string): string => {
  const phrase = configs.LIVE.find(([n]) => n === name)?.[1] ?? ""
  return phrase === "" ? "" : `${upperFirst(phrase)}.`
}

/** The idle minutes a session may keep its account, as Settings offers them. */
export const SESSION_TTL_STEPS: ReadonlyArray<number> = [5, 15, 30, 60, 120, 240, 480, 1_440]
/** The minutes between usage polls, as Settings offers them; 0 is off. */
export const POLL_STEPS: ReadonlyArray<number> = [0, 1, 2, 5, 10, 15, 30, 60]

/**
 * The step after `current` among `steps`, `up` or down, if there is one. A
 * value set by hand between two steps goes to the nearer one that way.
 */
export const step = (steps: ReadonlyArray<number>, current: number, up: boolean): number | undefined =>
  up ? steps.find((s) => s > current) : steps.findLast((s) => s < current)

/** `45 min`, `2 h`, `1 day`. */
export const minutes = (mins: number): string =>
  mins === 1_440 ? "1 day" : mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`

/**
 * What weekly resets left unused over a range, in a line, as the dashboard
 * and `slopmax usage` say it: `4 weekly windows · 62% unused on average
 * across them`.
 */
export const leftLine = (windows: number, unused: number): string => {
  if (windows === 0) return "No weekly window reset in this range"
  if (windows === 1) return `1 weekly window · ${fmt.fixed(unused, 0)}% unused`
  return `${windows} weekly windows · ${fmt.fixed(unused, 0)}% unused on average across them`
}

/** @internal `a`, `a and b`, or `a, b, and c`; exported for tests. */
export const listed = (items: ReadonlyArray<string>): string => {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`
}

/** @internal `text` with its first character upper-cased, as Rust's `char::to_uppercase`; exported for the host. */
export const upperFirst = (text: string): string => {
  const first = text.codePointAt(0)
  if (first === undefined) return ""
  const char = String.fromCodePoint(first)
  return `${char.toUpperCase()}${text.slice(char.length)}`
}

const lowercaseFirst = (text: string): string => {
  const first = text.codePointAt(0)
  if (first === undefined) return ""
  const char = String.fromCodePoint(first)
  return `${char.toLowerCase()}${text.slice(char.length)}`
}

const serving = (account: AccountReport): boolean => !account.disabled && account.authError === undefined

const share = (account: AccountReport, slot: Slot, weight: number, now: Timestamp): Share => {
  const window = Slot.of(slot, account)
  const used = window === undefined ? 0 : Window.usedAt(window, now)
  return {
    weight,
    fraction: Math.min(1, Math.max(0, used / 100)),
    tone: report.Tone.ofUse(used),
    idle: !serving(account),
  }
}

/**
 * The menu bar's line: each subscription's use in its 5-hour window,
 * across its working accounts, as `Claude 42% · ChatGPT 18%`.
 */
export const menuBar = (self: report.Report, now: Timestamp): string => {
  const parts = self.pools.map((pool) => {
    const title = ProviderId.spec(pool.provider).title
    const window = report.PoolReport.window(pool, "5h")
    return window === undefined ? `${title} —` : `${title} ${fmt.fixed(Window.usedAt(window, now), 0)}%`
  })
  return parts.length === 0 ? "slopmax" : parts.join(" · ")
}

/** The header's line about the proxy. */
export const proxyLine = (snapshot: Pick<Snapshot, "proxy" | "address">): string => {
  switch (snapshot.proxy._tag) {
    case "Checking":
      return "Looking for the proxy…"
    case "Starting":
      return "Starting the proxy…"
    case "Running":
      return `Running ${snapshot.proxy.version} at ${snapshot.address}`
    case "Stopped":
      return "Stopped: agents cannot reach slopmax"
  }
}

/** How an agent is wired, and whether that is through slopmax. */
export const agentLine = (self: AgentStatus): readonly [string, boolean] => {
  const wiring: agent.Wiring = self.wiring
  switch (wiring._tag) {
    case "Slopmax":
      return ["Goes through slopmax", true]
    case "Elsewhere":
      return [`Goes to ${wiring.target}`, false]
    case "Direct":
      return ["Goes straight to its provider", false]
  }
}

/** The Start at login setting: whether it is on, whether it can change, and what it says. */
export interface Login {
  readonly on: boolean
  readonly available: boolean
  readonly detail: string
}

export const login = (service: service.Status | undefined): Login => {
  if (service === undefined) {
    return {
      on: false,
      available: false,
      detail: "This system has no login service slopmax can use, so the app starts the proxy while it runs.",
    }
  }
  return {
    on: service.installed,
    available: true,
    detail:
      service.installed && !service.running
        ? "Runs the proxy whenever you log in. It is not running now."
        : "Runs the proxy whenever you log in, even while the app is closed.",
  }
}

/** What a sign-in in progress asks of the person. */
export interface SignInView {
  readonly title: string
  readonly detail: string
  /** The address to open, to show in full and copy. */
  readonly link: string | undefined
  /** A device code to enter. */
  readonly code: string | undefined
  /** Notes while waiting, such as a rejected paste. */
  readonly notes: string
}

export const signIn = (self: SignIn): SignInView => {
  const title = ProviderId.spec(self.provider).title
  const at = self.step
  const [detail, link, code] = ((): readonly [string, string | undefined, string | undefined] => {
    switch (at._tag) {
      case "Starting":
        return ["Starting…", undefined, undefined]
      case "Authorize":
        return at.opened
          ? [`Finish signing in to ${title} in your browser, which opened this address:`, at.url, undefined]
          : [`Open this address in a browser and sign in to ${title}:`, at.url, undefined]
      case "DeviceCode":
        return [`Open ${at.url} and enter this code:`, undefined, at.code]
    }
  })()
  return { title: `Signing in to ${title}`, detail, link, code, notes: self.notes.join("\n") }
}

export const gauge = (window: Window, now: Timestamp): Gauge => {
  const used = Window.usedAt(window, now)
  const upcoming = Window.upcomingReset(window, now)
  const reset = used > 0 ? upcoming : undefined
  return {
    fraction: Math.min(1, Math.max(0, used / 100)),
    percent: `${fmt.fixed(used, 0)}%`,
    resetsIn: reset === undefined ? undefined : human.until(reset, now),
    resetsAt: reset === undefined ? undefined : local(reset, now),
    tone: report.Tone.ofUse(used),
    pace: pace(window, used, now),
  }
}

/** How far within an even spend counts as on pace, in points. */
const ON_PACE = 5

/**
 * @internal The window's use against spending it evenly until it resets:
 * nothing before 3% of it has passed, too soon to say, nor once it is
 * spent. Exported for tests.
 */
export const pace = (window: Window, used: number, now: Timestamp): Pace | undefined => {
  const length =
    window.span === "5h" ? 5 * 3_600 : window.span === "7d" ? 7 * 86_400 : window.span === "30d" ? 30 * 86_400 : 0
  if (length === 0) return undefined
  const resets = Window.upcomingReset(window, now)
  if (resets === undefined) return undefined
  const passed = length - SignedDuration.asSecs(Timestamp.durationSince(resets, now))
  const elapsed = passed / length
  if (!(elapsed >= 0.03 && elapsed < 1) || used >= 100) return undefined
  const ahead = used - elapsed * 100
  let label: Label
  if (Math.abs(ahead) < ON_PACE) label = { text: "On pace", tone: "muted" }
  else if (ahead > 0) {
    // Ahead of an even spend, the same rate fills it before the reset.
    const rate = used / passed
    const out = Timestamp.add(now, SignedDuration.fromSecs(Math.trunc((100 - used) / rate)))
    label = { text: `Runs out ~${local(out, now)}`, tone: "warn" }
  } else label = { text: `${fmt.fixed(-ahead, 0)}% in reserve`, tone: "muted" }
  return { elapsed, label }
}

/** @internal `used 3m ago`, coarsely; exported for tests. */
export const ago = (at: Timestamp, now: Timestamp): string => {
  const secs = Math.max(SignedDuration.asSecs(Timestamp.durationSince(now, at)), 0)
  if (secs < 60) return "used just now"
  if (secs < 3_600) return `used ${Math.floor(secs / 60)}m ago`
  if (secs < 86_400) return `used ${Math.floor(secs / 3_600)}h ago`
  return `used ${Math.floor(secs / 86_400)}d ago`
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const MONTHS = time.MONTHS

const divEuclid = (a: number, b: number): number => Math.floor(a / b)

// The day `t` falls on, counted from 1970-01-01, on a clock `offset` east of UTC.
const dayOf = (t: Timestamp, offset: SignedDuration): number =>
  divEuclid(Timestamp.asSecond(t) + SignedDuration.asSecs(offset), 86_400)

const monthDay = (at: Timestamp, offset: SignedDuration): string => {
  const [, month, date] = Timestamp.date(at, offset)
  return `${MONTHS[month - 1] ?? ""} ${date}`
}

/** The day `at` fell on, on a clock `offset` east of UTC: `today`, `yesterday`, or `Sep 21`. */
const day = (at: Timestamp, now: Timestamp, offset: SignedDuration): string => {
  const days = dayOf(now, offset) - dayOf(at, offset)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  return monthDay(at, offset)
}

/**
 * @internal When `at` comes on a clock `offset` east of UTC: `22:59` on
 * `now`'s day, `Wed 20:27` within the week, `Nov 3` after. Exported for
 * tests.
 */
export const clock = (at: Timestamp, now: Timestamp, offset: SignedDuration): string => {
  const [hour, minute] = Timestamp.timeOfDay(at, offset)
  const hm = `${fmt.zeroPad(hour, 2)}:${fmt.zeroPad(minute, 2)}`
  const days = dayOf(at, offset) - dayOf(now, offset)
  if (days === 0) return hm
  // The first day, January 1st 1970, was a Thursday.
  if (days >= 1 && days <= 6) return `${WEEKDAYS[(((dayOf(at, offset) + 3) % 7) + 7) % 7] ?? ""} ${hm}`
  return monthDay(at, offset)
}

const row = (account: AccountReport, columns: ReadonlyArray<Slot>, now: Timestamp): Row => {
  const condition = AccountReport.condition(account, now)
  const plan =
    account.plan !== undefined
      ? titleCase(account.plan)
      : !provider.Spec.isSubscription(ProviderId.spec(account.provider))
        ? "per token"
        : ""
  const said = report.Condition.describe(condition, now)
  return {
    id: account.id,
    name: account.name,
    plan,
    limits: columns.map((slot) => {
      const window = Slot.of(slot, account)
      return window === undefined ? undefined : gauge(window, now)
    }),
    status: {
      // A pin is how it stands too, so it says so here.
      text: condition._tag !== "Disabled" && account.pinned ? `${said} · pinned` : said,
      tone: report.Condition.tone(condition),
    },
    // Reset credits show apart, where they can be redeemed, and a pin in the status.
    notes: AccountReport.notes(account, now)
      .filter((n) => n._tag !== "ResetCredits" && n._tag !== "Pinned")
      .map(note),
    pinned: account.pinned,
    disabled: account.disabled,
    priority: account.priority,
    lastUsed: account.state.lastUsed === undefined ? undefined : ago(account.state.lastUsed, now),
    credits: credits(account, now),
    next: false,
    follows: account.follows,
  }
}

/** @internal `1,312`; exported for tests. */
export const grouped = (n: number): string => {
  const digits = String(n)
  let out = ""
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ","
    out += digits[i]
  }
  return out
}

/** `max 20x` as `Max 20x`: each word capitalized. */
const titleCase = (text: string): string => text.split(" ").map(upperFirst).join(" ")

// `char::is_whitespace`: Unicode's White_Space, which `\s` does not quite match.
const SEPARATOR = /[,\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** Model patterns as typed, with commas or spaces between them. */
export const patterns = (text: string): Array<string> => text.split(SEPARATOR).filter((p) => p !== "")

/** A range's name as a choice: `7 days`. */
export const rangeTitle = (range: history.Range): string =>
  range === "today" ? "Today" : range === "week" ? "7 days" : "30 days"

/** How a pool reads its accounts as one: `weighted by plan`, or an average. */
export const poolBasis = (group: Group): string => (group.weighted ? "weighted by plan" : "average of accounts")

/** What a pool's bar shows, for a tooltip. */
export const segmentsTip = (group: Group): string =>
  group.weighted
    ? "One segment per account, as wide as its plan's share of the pool"
    : "One segment per account; the pool reads as their average"

/** How bad a finding of the doctor's is. */
export const levelTone = (level: doctor.Level): Tone => {
  switch (level) {
    case "ok":
      return "good"
    case "note":
      return "muted"
    case "warn":
      return "warn"
    case "fail":
      return "bad"
  }
}

/**
 * A note beside an account. What it has served counts every request since
 * it was added, which it says, as the Usage page counts a range.
 */
const note = (self: report.Note): Label => ({
  text:
    self._tag === "Served"
      ? `${grouped(self.requests)} ${self.requests === 1 ? "request" : "requests"}, ${human.compact(self.tokens)} tokens all time`
      : report.Note.describe(self),
  tone: report.Note.tone(self),
})
