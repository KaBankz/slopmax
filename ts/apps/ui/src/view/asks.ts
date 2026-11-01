// What the app asks before it does something to an account or a key: the
// dialog's title, what it explains, the facts it lists, its field and its
// button. Pure, so a test reads every question as people will.
import { type AccountView, usedAt } from "@slopmax/domain"
import { percent, until } from "@slopmax/domain/format"
import { DateTime } from "effect"
import { windowTitle } from "./groups.ts"

/** A question the app asks in a dialog. */
export interface Ask {
  readonly title: string
  readonly body: string
  /** Lines worth knowing before answering. */
  readonly facts?: ReadonlyArray<string>
  /** A field to fill in; without one the dialog only confirms. */
  readonly field?: {
    readonly label: string
    readonly value: string
    readonly placeholder?: string
    readonly kind: "text" | "number"
  }
  readonly confirm: string
  /** Whether the answer cannot be taken back, so the button reads as a warning. */
  readonly danger: boolean
}

export const askOwn = (account: AccountView): Ask => {
  const tool = account.follows ?? "the tool"
  return {
    title: `Refresh ${account.name} here?`,
    body: `slopmax follows ${tool}'s copy of this account's tokens now. From here on slopmax refreshes them itself, and stops reading ${tool}'s copy.`,
    confirm: "Refresh here",
    danger: false,
  }
}

export const askPriority = (account: AccountView): Ask => ({
  title: "Set priority",
  body: `Higher tiers are used first; within a tier the strategy decides. ${account.name} is at ${account.priority}.`,
  field: { label: "Priority", value: String(account.priority), kind: "number" },
  confirm: "Save",
  danger: false,
})

/** A priority as typed: a whole number, or nothing when the field is blank or not a number. */
export const readPriority = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}

export const askRename = (account: AccountView): Ask => {
  const label = account.email !== undefined && account.name === account.email ? "" : account.name
  return {
    title: "Rename account",
    body: "A name for this account here and in the CLI. Leave it empty to show its email again.",
    field: { label: "Name", value: label, placeholder: account.email ?? account.id, kind: "text" },
    confirm: "Rename",
    danger: false,
  }
}

export const askRemove = (account: AccountView): Ask => ({
  title: `Remove ${account.name}?`,
  body: "slopmax forgets this account and its tokens. Its sessions move to other accounts. You can sign in again later.",
  confirm: "Remove",
  danger: true,
})

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()

/** A moment on the local clock with its date: `Nov 3, 14:05`. */
export const dateTime = (at: DateTime.DateTime, zone: DateTime.TimeZone): string => {
  const timeZone = DateTime.zoneToString(zone)
  let format = dateTimeFormats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    dateTimeFormats.set(timeZone, format)
  }
  return DateTime.formatIntl(at, format)
}

/**
 * Before a limit reset is spent: what it spends, when it would have expired,
 * and each window's use now, with when a used window resets anyway.
 */
export const askRedeem = (
  account: AccountView,
  resetId: string | undefined,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): Ask => {
  const reset = account.resets.find((r) => r.id === resetId) ?? account.resets[0]
  const spends = reset?.title === undefined ? "one limit reset" : `“${reset.title}”`
  const expires = reset?.expiresAt === undefined ? "" : ` It would expire ${dateTime(reset.expiresAt, zone)}.`
  const facts = account.windows
    .filter((w) => w.model === undefined)
    .map((w) => {
      const used = usedAt(w, now)
      const resets =
        used > 0 && w.resetsAt !== undefined && DateTime.isGreaterThan(w.resetsAt, now)
          ? ` · resets anyway in ${until(w.resetsAt, now)}`
          : ""
      return `${windowTitle(w)}: ${percent(used)} used${resets}`
    })
  return {
    title: "Redeem a limit reset?",
    body: `This spends ${spends} on ${account.name} and resets its windows now.${expires}`,
    ...(facts.length === 0 ? {} : { facts: ["Its windows now", ...facts] }),
    confirm: "Redeem",
    danger: false,
  }
}

export const askRevoke = (name: string): Ask => ({
  title: `Revoke ${name}?`,
  body: "Agents using this key are refused from now on. This cannot be undone; make a new key to restore access.",
  confirm: "Revoke",
  danger: true,
})
