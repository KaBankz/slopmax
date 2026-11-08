// How the accounts stand in a line, and what wants a look: the overview's
// headline, the "Needs attention" list, and the menu bar panel's short form
// of it. Every front end lists the same things in the same order.
import { type AccountView, type Notice, type ProviderId, type Report, type Tone, usedAt } from "@slopmax/client"
import { clock, fixed, pace, until } from "@slopmax/client/format"
import { DateTime, Duration, Option } from "effect"
import { expiringWithin, resetsLeft, shortName, unexpiredResets, windowTitle } from "./groups.ts"
import { lowercaseFirst, resetCount } from "./words.ts"

/** How the accounts stand: what an overview leads with. */
export interface Standing {
  /** `All 4 accounts are ready`, or `3 of 4 accounts are ready`. */
  readonly headline: string
  /** What keeps the rest: `1 limited · 1 needs signing in`. */
  readonly detail?: string
  readonly tone: Tone
}

export const standing = (report: Report): Standing => {
  const enabled = report.accounts.filter((account) => !account.disabled)
  const tags = enabled.map((account) => account.condition._tag)
  const ready = tags.filter((tag) => tag === "Ready" || tag === "Active").length
  const limited = tags.filter((tag) => tag === "Limited" || tag === "Throttled").length
  const signedOut = tags.filter((tag) => tag === "SignInNeeded").length
  const off = report.accounts.length - enabled.length
  const headline =
    enabled.length === 0
      ? off === 0
        ? "No accounts yet"
        : "Every account is turned off"
      : enabled.length === 1 && ready === 1
        ? "Your account is ready"
        : ready === enabled.length
          ? `All ${enabled.length} accounts are ready`
          : `${ready} of ${enabled.length} accounts are ready`
  const parts = [
    ...(limited > 0 ? [`${limited} limited`] : []),
    ...(signedOut === 1 ? ["1 needs signing in"] : signedOut > 1 ? [`${signedOut} need signing in`] : []),
    ...(off > 0 ? [`${off} turned off`] : []),
  ]
  return {
    headline,
    ...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
    tone: signedOut > 0 ? "bad" : limited > 0 ? "warn" : "good",
  }
}

/** What an item that wants a look offers to do about it. */
export type Remedy = "sign-in" | "redeem" | "look"

/** Something about an account that wants a look. */
export interface Attention {
  readonly provider: ProviderId
  readonly account: string
  readonly text: string
  /** Short, for the menu bar panel: who, by the local part of their address. */
  readonly who: string
  /** And what and when, which a narrow line keeps whole. */
  readonly what: string
  readonly tone: Tone
  readonly remedy: Remedy
}

const item = (account: AccountView, text: string, what: string, tone: Tone, remedy: Remedy): Attention => ({
  provider: account.provider,
  account: account.id,
  text,
  who: shortName(account.name),
  what,
  tone,
  remedy,
})

/**
 * A notice's first sentence, without its full stop or the marks around a
 * command, and its times as the window sets them: `in 19h59m (19:12)` reads
 * `in 19h59m · 19:12`.
 */
export const firstSentence = (message: string): string =>
  (message.split(". ")[0] ?? message)
    .replace(/\.+$/, "")
    .replaceAll("`", "")
    .replace(/ \(([^)]*)\)/g, " · $1")

/** Whether a notice is about this account: its name, and its provider when the notice says. */
const names = (notice: Notice, account: AccountView): boolean =>
  notice.account === account.name && (notice.provider === undefined || notice.provider === account.provider)

/** An account's long window, `week` or `month`, and how much of it is unused, in percent. */
const unusedAtReset = (account: AccountView, now: DateTime.Utc): { period: string; unused: number } => {
  const long = account.windows.find((w) => w.model === undefined && (w.span === "7d" || w.span === "30d"))
  if (long === undefined) return { period: "week", unused: 0 }
  return { period: long.span === "30d" ? "month" : "week", unused: 100 - Math.min(100, Math.max(0, usedAt(long, now))) }
}

/**
 * What wants a look, most pressing first: an account signed out, one limited
 * that holds a limit reset, a window running out before it resets, a limit
 * reset soon to expire, then the report's nudges not already listed. An
 * account merely limited is slopmax's to work around, and wants nothing.
 */
export const attention = (report: Report, now: DateTime.Utc, zone: DateTime.TimeZone): ReadonlyArray<Attention> => {
  const found: Array<Attention> = []
  for (const account of report.accounts.filter((a) => !a.disabled)) {
    const held = resetsLeft(account, now)
    const condition = account.condition
    if (condition._tag === "SignInNeeded") {
      found.push(item(account, `${account.name} needs signing in again`, "sign in again", "bad", "sign-in"))
      continue
    }
    if (condition._tag === "Limited") {
      if (held === 0) continue
      const at = clock(condition.until, now, zone)
      found.push(
        item(
          account,
          `${account.name} is limited until ${at}, and holds ${resetCount(held)}`,
          `limited until ${at}, ${held} held`,
          "warn",
          "redeem",
        ),
      )
    }
    for (const window of account.windows.filter((w) => w.model === undefined)) {
      const windowPace = pace(window, now, zone)
      if (Option.isNone(windowPace) || windowPace.value.tone !== "warn") continue
      const title = lowercaseFirst(windowTitle(window))
      const text = lowercaseFirst(windowPace.value.text)
      found.push(item(account, `${account.name}'s ${title} window ${text}`, `${title} ${text}`, "warn", "look"))
    }
    const expiring = unexpiredResets(account, now)
      .flatMap((reset) => (reset.expiresAt === undefined ? [] : [reset.expiresAt]))
      .find((at) => Duration.isLessThan(DateTime.distance(now, at), expiringWithin))
    if (expiring !== undefined) {
      // slopmax redeems it by itself unless a nudge says it will not.
      const autoOff = report.nudges.some((n) => n.kind === "reset-expiring" && names(n, account))
      found.push(
        item(
          account,
          `A limit reset on ${account.name} expires in ${until(expiring, now)} · ${clock(expiring, now, zone)}${autoOff ? "; auto-redeem is off" : ""}`,
          `reset expires in ${until(expiring, now)}`,
          "warn",
          "redeem",
        ),
      )
    }
  }
  for (const nudge of report.nudges) {
    const account = report.accounts.find((a) => names(nudge, a))
    if (account === undefined) continue
    const at = nudge.until ?? now
    if (nudge.kind === "reset-expiring") {
      if (found.some((f) => f.account === account.id && f.remedy === "redeem")) continue
      found.push(item(account, firstSentence(nudge.message), `reset expires in ${until(at, now)}`, "warn", "redeem"))
    } else if (nudge.kind === "quota-unused") {
      const { period, unused } = unusedAtReset(account, now)
      const worth =
        nudge.worth !== undefined && nudge.worth >= 0.5 ? `, about $${fixed(nudge.worth, 0)} of its plan` : ""
      found.push(
        item(
          account,
          `${account.name}'s ${period} resets in ${until(at, now)} · ${clock(at, now, zone)} with ${fixed(unused, 0)}% of it unused${worth}`,
          `${period} ends in ${until(at, now)}, ${fixed(unused, 0)}% unused`,
          "warn",
          "look",
        ),
      )
    }
  }
  // Stable: what is broken first, everything else in the order found.
  return found.toSorted((a, b) => Number(a.tone !== "bad") - Number(b.tone !== "bad"))
}

/** The worst tone among a provider's items, for the dot beside it in the sidebar. */
export const worstTone = (items: ReadonlyArray<Attention>, provider: ProviderId): Tone | undefined => {
  const tones = items.filter((a) => a.provider === provider).map((a) => a.tone)
  return tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : undefined
}
