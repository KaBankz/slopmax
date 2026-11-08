// The small words the app is made of: counts, lists, money, ranges, and the
// sentences beside each setting. Pure, so a test reads them as people will.
import type { HistoryRange, Level, LiveKey, LivePatch, Settings, Strategy, Tone } from "@slopmax/client"
import { fixed, grouped } from "@slopmax/client/format"
import { Cause } from "effect"

/** The first letter capitalized, the rest as it is. */
export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A check's message names the field it is about on its own lines (`at ["url"]`); people read the message alone. */
const withoutPath = (message: string): string => message.split("\n")[0]?.trim() ?? message

/** The words of a check of the answer's shape, which say nothing to someone reading the page. */
const shapeWords = /^(Missing key|Unexpected key|Expected )/

/**
 * What went wrong, as people read it: the API's own words, a refused
 * field's message without its path, and an answer this page cannot read as such.
 */
export const failureText = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? withoutPath(error.message)
      : ""
  if (message === "") return "it failed"
  return shapeWords.test(message) ? "slopmax answered in a form this page does not read; reload it" : message
}

/**
 * A finding or a note read as a sentence: its first letter capitalized,
 * unless it starts with a name that keeps its case, such as slopmax itself,
 * an address, a host or a path.
 */
export const sentenceCase = (text: string): string => {
  const first = text.split(/\s/, 1)[0] ?? ""
  return first === "slopmax" || /[.@/:]/.test(first) ? text : capitalize(text)
}

/** The first letter lowercased, for a title used inside a sentence: `Weekly` → `weekly`. */
export const lowercaseFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** Every space-separated word capitalized: `max 20x` → `Max 20x`. */
export const titleCase = (text: string): string =>
  text
    .split(" ")
    .map((word) => capitalize(word))
    .join(" ")

/**
 * A word from the engine read as a sentence: a leading `●` (the CLI's live
 * marker) dropped and the first letter capitalized.
 */
export const sentence = (text: string): string => sentenceCase(text.replace(/^●\s*/, ""))

/** `a`, `a and b`, or `a, b, and c`. */
export const listed = (items: ReadonlyArray<string>): string => {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`
}

/** `1 request`, `1,204 requests`. */
export const count = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${grouped(n)} ${noun}s`)

/** `1 limit reset`, `3 limit resets`. */
export const resetCount = (n: number): string => count(n, "limit reset")

/** Dollars as a figure: `$1,204` from a thousand up, `$412.30` below. */
export const dollars = (amount: number): string =>
  amount >= 1000 ? `$${grouped(Math.round(amount))}` : `$${fixed(amount, 2)}`

/**
 * What some requests came to at API prices: `—` when none could be priced
 * (and there were some), `$12.30+` when some could not, else the dollars.
 */
export const priced = (cost: number, unpriced: number, requests: number): string => {
  if (unpriced > 0 && unpriced >= requests && requests > 0) return "—"
  return unpriced > 0 ? `${dollars(cost)}+` : dollars(cost)
}

/** Model patterns as people type them: split on commas and whitespace, empties dropped. */
export const patterns = (text: string): ReadonlyArray<string> => text.split(/[\s,]+/).filter((part) => part !== "")

/** What each history range is called. */
export const rangeTitle = (range: HistoryRange): string =>
  range === "today" ? "Today" : range === "7d" ? "7 days" : "30 days"

/** Every range the usage pages offer, in order. */
export const ranges: ReadonlyArray<HistoryRange> = ["today", "7d", "30d"]

/** The range the usage pages open on. */
export const defaultRange: HistoryRange = "7d"

const strategyTitles: { readonly [K in Strategy]: string } = {
  "reset-first": "Reset first",
  "fill-first": "Fill first",
  "least-used": "Least used",
  "round-robin": "Round robin",
}

/** A strategy's name, as Settings lists it. */
export const strategyTitle = (strategy: Strategy): string => strategyTitles[strategy]

/** What a strategy does, as a sentence, from the summary the API serves. */
export const strategyDetail = (summary: string): string => `${summary}.`

/** How requests find their account, in a line: `Reset first · sessions keep their account`. */
/** How new sessions find an account; the strategy alone until the settings say whether sessions keep theirs. */
export const routing = (settings: Pick<Settings, "strategy"> & Partial<Pick<Settings, "sessionAffinity">>): string =>
  settings.sessionAffinity === undefined
    ? strategyTitle(settings.strategy)
    : `${strategyTitle(settings.strategy)} · ${settings.sessionAffinity ? "sessions keep their account" : "sessions move between accounts"}`

export const affinityDetail =
  "Keep a conversation on the account it started on, so its prompt cache stays warm. Off, the strategy places every request."

export const affinityHeader = "A request can ask otherwise with the x-slopmax-affinity header, set to on or off."

/** How long before a limit reset expires slopmax redeems it, when it does. */
export const redeemLeadHours = 3

export const redeemExpiringDetail = `Redeem it ${redeemLeadHours} hours before, if the account has quota to reset.`

export const redeemExhaustedDetail = "Redeem one so the pool keeps serving, rather than wait for a reset."

/** When slopmax redeems a provider's limit resets by itself, if it does. */
export const autoRedeem = (
  settings: Pick<Settings, "redeemExpiring" | "redeemWhenExhausted">,
  provider: string,
): string | undefined => {
  if (settings.redeemWhenExhausted && settings.redeemExpiring) {
    return `slopmax redeems one by itself when every ${provider} account is spent, and ${redeemLeadHours} hours before one would expire unused.`
  }
  if (settings.redeemExpiring) {
    return `slopmax redeems one by itself ${redeemLeadHours} hours before it would expire unused, if the account has quota to reset.`
  }
  if (settings.redeemWhenExhausted) return `slopmax redeems one by itself when every ${provider} account is spent.`
  return undefined
}

/** The idle minutes a session may keep its account, as Settings offers them. */
export const sessionSteps: ReadonlyArray<number> = [5, 15, 30, 60, 120, 240, 480, 1440]

/** The minutes between usage polls, as Settings offers them; 0 is off. */
export const pollSteps: ReadonlyArray<number> = [0, 1, 2, 5, 10, 15, 30, 60]

/**
 * The next step from `current`, up or down, if there is one. A value set by
 * hand between two steps moves to the nearer one in that direction.
 */
export const step = (steps: ReadonlyArray<number>, current: number, up: boolean): number | undefined =>
  up ? steps.find((s) => s > current) : steps.findLast((s) => s < current)

/** `45 min`, `2 h`, `1 day`. */
export const minutes = (mins: number): string =>
  mins === 1440 ? "1 day" : mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`

/** What the app says once a live setting is changed. */
export const settingChanged = (patch: LivePatch): string | undefined => {
  if (patch.strategy !== undefined) return `slopmax now routes ${strategyTitle(patch.strategy).toLowerCase()}.`
  if (patch.sessionAffinity !== undefined) {
    return patch.sessionAffinity
      ? "Sessions keep the account they started on."
      : "The strategy now places every request."
  }
  if (patch.redeemExpiring !== undefined) {
    return patch.redeemExpiring ? "Limit resets are redeemed before they expire." : "Limit resets are left to expire."
  }
  if (patch.redeemWhenExhausted !== undefined) {
    return patch.redeemWhenExhausted
      ? "A limit reset is redeemed once every account is spent."
      : "Once every account is spent, the pool waits for a reset."
  }
  if (patch.sessionMinutes !== undefined)
    return `A session keeps its account through ${minutes(patch.sessionMinutes)} idle.`
  if (patch.warmWindows !== undefined) {
    return patch.warmWindows
      ? "Idle ChatGPT windows start as they reset."
      : "Idle windows wait for their first request."
  }
  if (patch.paidOverflow !== undefined) {
    return patch.paidOverflow
      ? "API keys take over once subscriptions are limited."
      : "API keys serve a subscription's models only when asked for by name."
  }
  if (patch.pollMinutes !== undefined) {
    return patch.pollMinutes === 0
      ? "slopmax no longer polls usage."
      : `slopmax polls usage every ${minutes(patch.pollMinutes)}.`
  }
  if (patch.refreshTokens !== undefined) {
    return patch.refreshTokens ? "Sign-ins are refreshed before they expire." : "Sign-ins are left to expire."
  }
  if (patch.websockets !== undefined) {
    return patch.websockets ? "Codex may use WebSockets through slopmax." : "Codex streams over HTTP through slopmax."
  }
  return undefined
}

/** A live setting's summary, as the API serves it, read as a sentence; empty when unknown. */
export const liveDetail = (
  name: LiveKey,
  live: ReadonlyArray<{ readonly name: string; readonly summary: string }>,
): string => {
  const summary = live.find((row) => row.name === name)?.summary
  return summary === undefined || summary === "" ? "" : `${capitalize(summary)}.`
}

/** What weekly resets threw away over a range, in a line. */
export const leftLine = (windows: number, unused: number): string =>
  windows === 0
    ? "No weekly window reset in this range"
    : windows === 1
      ? `1 weekly window · ${fixed(unused, 0)}% unused`
      : `${windows} weekly windows · ${fixed(unused, 0)}% unused on average across them`

/** How a pool reads its accounts as one. */
export const poolBasis = (weighted: boolean): string => (weighted ? "weighted by plan" : "average of accounts")

/** What a pool's segmented bar shows. */
const segmentsTip = (weighted: boolean): string =>
  weighted
    ? "One segment per account, as wide as its plan's share of the pool"
    : "One segment per account; the pool reads as their average"

/**
 * The most accounts the pool's bar draws a segment for. Past it the segments
 * would shrink to dots, so the bar reads as the pool's one use instead.
 */
export const segmentsShown = 12

/** What the pool's bar shows on hover, when it draws one segment per account or the pool as one. */
export const poolBarTip = (accounts: number, weighted: boolean): string =>
  accounts > segmentsShown
    ? `The pool's use across ${accounts} accounts${weighted ? ", weighted by plan" : ""}`
    : segmentsTip(weighted)

const levelTones: { readonly [K in Level]: Tone } = { ok: "good", info: "muted", warn: "warn", fail: "bad" }

/** How a doctor finding is colored. */
export const levelTone = (level: Level): Tone => levelTones[level]

/** Resets wording under a gauge: `Resets in 2h05m · 22:59`, `Resets in 2h05m`, or `Nothing to reset`. */
export const resetsLine = (resetsIn: string | undefined, resetsAt: string | undefined): string =>
  resetsIn === undefined
    ? "Nothing to reset"
    : resetsAt === undefined
      ? `Resets in ${resetsIn}`
      : `Resets in ${resetsIn} · ${resetsAt}`

/** When the report was built: `Updated just now`, `Updated 3m ago`. */
export const updated = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return "Updated just now"
  if (s < 3_600) return `Updated ${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `Updated ${Math.floor(s / 3_600)}h ago`
  return `Updated ${Math.floor(s / 86_400)}d ago`
}
