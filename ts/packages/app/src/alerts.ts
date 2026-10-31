// Notifications on the desktop for the nudges the core finds: a limit
// reset about to lapse unredeemed, and a week about to reset with quota
// to spare. Each nudge is told once, as its key names it, even across a
// restart of the app: what was told is kept in slopmax's home, beside
// whether to tell at all. The UI posts each `Alert` the system's way.
import { Effect } from "effect"

import { type Config, fsx, type Home, notify, paths, type report, serde, text as texts, time } from "@slopmax/core"

type Timestamp = time.Timestamp
const { Timestamp } = time

/** What the app keeps about notifications. */
export interface Told {
  /** Whether to post them at all. */
  readonly enabled: boolean
  /**
   * The nudges told, by key, with when each stops mattering, after which
   * it is forgotten. Saved in key order, as the Rust's `BTreeMap` is.
   */
  readonly keys: ReadonlyMap<string, Timestamp>
}

const INTEGER = /^[+-]?[0-9]+$/

// `str::parse::<i64>`, then `Timestamp::from_second`.
const second = (text: string): Timestamp | undefined => {
  if (!INTEGER.test(text)) return undefined
  const n = BigInt(text)
  if (n < -(2n ** 63n) || n >= 2n ** 63n) return undefined
  return Timestamp.fromSecond(Number(n))
}

// The entries in the Rust's key order.
const sorted = (keys: ReadonlyMap<string, Timestamp>): Array<[string, Timestamp]> =>
  [...keys].toSorted(([a], [b]) => serde.byteOrder(a, b))

const afresh = (): Told => ({ enabled: true, keys: new Map() })

export const Told = {
  default: afresh,

  /** Where it is kept. */
  path: (home: Home): string => paths.join(home.dir, "desktop-notified"),

  /**
   * What was kept at `path`, or a fresh start. The file has a line
   * `enabled = true` or `false`, then a line per nudge told: its key and,
   * after a tab, the second it stops mattering. A line it cannot read is
   * skipped.
   */
  load: Effect.fn("Told.load")((path: string): Effect.Effect<Told> =>
    fsx.readText(path).pipe(
      Effect.map((text): Told => {
        if (text === undefined) return afresh()
        let enabled = true
        const keys = new Map<string, Timestamp>()
        // `str::lines`: split at `\n`, a `\r` before it dropped, no last empty line.
        const lines = text.split("\n")
        if (lines.at(-1) === "") lines.pop()
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
          if (line.startsWith("enabled = ")) {
            enabled = texts.trim(line.slice("enabled = ".length)) !== "false"
            continue
          }
          const tab = line.indexOf("\t")
          if (tab < 0) continue
          const until = second(texts.trim(line.slice(tab + 1)))
          if (until !== undefined) keys.set(line.slice(0, tab), until)
        }
        return { enabled, keys }
      }),
      Effect.orElseSucceed(afresh),
    ),
  ),

  /** Keeps it at `path`; a failure only means a nudge may be told again. */
  save: Effect.fn("Told.save")((self: Told, path: string): Effect.Effect<void> => {
    let text = `enabled = ${self.enabled}\n`
    for (const [key, until] of sorted(self.keys)) text += `${key}\t${Timestamp.asSecond(until)}\n`
    return Effect.ignore(fsx.writePrivate(path, text))
  }),

  /**
   * The nudges in `found` not told before, which are now remembered as
   * told. Those whose moment has passed are forgotten. Returns the new
   * value, whether anything changed, to save, and what is new to tell.
   */
  fresh: (
    self: Told,
    found: ReadonlyArray<notify.Nudge>,
    now: Timestamp,
  ): readonly [told: Told, changed: boolean, fresh: Array<notify.Nudge>] => {
    const keys = new Map<string, Timestamp>()
    for (const [key, until] of self.keys) if (until > now) keys.set(key, until)
    let changed = keys.size !== self.keys.size
    const fresh: Array<notify.Nudge> = []
    for (const [key, event] of found) {
      if (keys.has(key)) continue
      keys.set(key, event.until ?? now)
      changed = true
      fresh.push([key, event])
    }
    return [{ enabled: self.enabled, keys }, changed, fresh]
  },
} as const

/** The nudges `report`'s accounts call for, with their keys. */
export const nudges = (report: report.Report, config: Config, now: Timestamp): Array<notify.Nudge> =>
  notify.nudges(report.accounts.map(notify.Subject.of), config.redeemExpiringCredits, config.planPrices, now)

/** A notification's title for a nudge. */
export const title = (kind: notify.Kind): string => {
  switch (kind) {
    case "reset-expiring":
      return "Limit reset expiring"
    case "quota-unused":
      return "Quota going unused"
    case "exhausted":
      return "Every account is limited"
    case "recovered":
      return "Accounts are back"
    case "signed-out":
      return "Sign in again"
    case "limited":
      return "Account limited"
    case "available":
      return "Account available"
    case "test":
      return "slopmax"
  }
}

/**
 * A nudge's words as a notification shows them: the core's, without the
 * marks that set off a command in a terminal.
 */
export const body = (event: notify.Event): string => event.message.replaceAll("`", "")

/** A notification for the UI to post. */
export interface Alert {
  /**
   * The nudge's key: a notification posted again under it replaces the
   * last rather than stacking beside it.
   */
  readonly key: string
  readonly title: string
  readonly body: string
}

export const Alert = {
  of: (key: string, event: notify.Event): Alert => ({ key, title: title(event.event), body: body(event) }),
} as const
