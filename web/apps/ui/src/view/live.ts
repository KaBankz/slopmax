// The live feed of requests, the sign-in card's steps, the proxy's state in
// words, and which notices a browser has already shown. Each is a small pure
// state with the functions that move it along.
import type { AgentWiring, LoginEvent, Notice, ProviderId, RequestRecord, Tone } from "@slopmax/client"
import { providerFacts } from "@slopmax/client"
import { DateTime } from "effect"
import { readOnlyShort } from "./tailnet.ts"

// --- Live requests -------------------------------------------------------------

/** How many requests the feed keeps, newest first. */
export const feedSize = 200

export interface FeedEntry {
  /** Unique within the feed, for React keys and the flash on arrival. */
  readonly seq: number
  readonly record: RequestRecord
  /** Its worth at API prices, when the daemon knows its model's price. */
  readonly cost?: number
}

/** Adds a request to the top of the feed, keeping the newest {@link feedSize}. */
export const pushFeed = (
  feed: ReadonlyArray<FeedEntry>,
  record: RequestRecord,
  seq: number,
  cost?: number,
): ReadonlyArray<FeedEntry> => [{ seq, record, ...(cost === undefined ? {} : { cost }) }, ...feed].slice(0, feedSize)

/** `420 ms`, `1.24 s`, `12.3 s`. */
export const secs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`

/** A request is a failure when its status is outside 200–399. */
export const isFailure = (status: number): boolean => status < 200 || status >= 400

// --- Sign-in ----------------------------------------------------------------------

export type SignInStep =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Authorize"; readonly url: string; readonly opened: boolean; readonly port: number }
  | { readonly _tag: "DeviceCode"; readonly url: string; readonly code: string }

/** A sign-in in progress. */
export interface SignIn {
  readonly provider: ProviderId
  /** The API's id for it, once it has started. */
  readonly id?: string
  readonly step: SignInStep
  readonly notes: ReadonlyArray<string>
}

export const startSignIn = (provider: ProviderId): SignIn => ({ provider, step: { _tag: "Starting" }, notes: [] })

/** Moves a sign-in along with a step it reported; the end of a sign-in is handled by whoever started it. */
export const stepSignIn = (signIn: SignIn, event: LoginEvent): SignIn => {
  switch (event._tag) {
    case "Authorize":
      return { ...signIn, step: { _tag: "Authorize", url: event.url, opened: event.opened, port: event.port } }
    case "DeviceCode":
      return { ...signIn, step: { _tag: "DeviceCode", url: event.url, code: event.code } }
    case "Note":
      return { ...signIn, notes: [...signIn.notes, event.text] }
    case "Done":
    case "Failed":
      return signIn
  }
}

/** What a sign-in asks of the person. */
export interface SignInView {
  readonly title: string
  readonly detail: string
  /** The address to open, to show in full and copy. */
  readonly link?: string
  /** What to paste back from a browser elsewhere, and its button. */
  readonly paste?: { readonly hint: string; readonly action: string }
  /** A code to enter, and the page it is entered on. */
  readonly code?: string
  readonly codePage?: string
  readonly notes: string
}

export const signInView = (signIn: SignIn): SignInView => {
  const title = providerFacts[signIn.provider].title
  const notes = signIn.notes.join("\n")
  const step = signIn.step
  switch (step._tag) {
    case "Starting":
      return { title: `Signing in to ${title}`, detail: "Starting…", notes }
    case "Authorize":
      // Port 0: nothing listens for a redirect, and the provider's page shows
      // a code to paste instead.
      return step.port === 0
        ? {
            title: `Signing in to ${title}`,
            detail: `Open this address in any browser, sign in to ${title}, and paste the code it shows:`,
            link: step.url,
            paste: { hint: "Paste the code the page shows", action: "Use code" },
            notes,
          }
        : {
            title: `Signing in to ${title}`,
            detail: step.opened
              ? `Finish signing in to ${title} in your browser, which opened this address:`
              : `Open this address in a browser and sign in to ${title}:`,
            link: step.url,
            paste: { hint: "Browser on another machine? Paste the address it ended on", action: "Use address" },
            notes,
          }
    case "DeviceCode":
      return {
        title: `Signing in to ${title}`,
        detail: `Open ${step.url} and enter this code:`,
        code: step.code,
        codePage: step.url,
        notes,
      }
  }
}

/** What a finished sign-in says. */
export const signInDone = (event: LoginEvent): { readonly text: string; readonly error: boolean } | undefined =>
  event._tag === "Done"
    ? { text: `${event.isNew ? "Connected" : "Updated"} ${event.account.name}.`, error: false }
    : event._tag === "Failed"
      ? { text: `Sign-in failed: ${event.message}`, error: true }
      : undefined

// --- The proxy ------------------------------------------------------------------

/**
 * Whether the event stream is up: all the dashboard knows of the proxy. The
 * proxy serves the page, so while the stream is down the dashboard waits for
 * it, never sure it stopped.
 */
export type Live =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Running"; readonly version: string }
  | { readonly _tag: "Reconnecting" }

/** The proxy's state as a short label with its tone, the same in the masthead and in Settings. */
export const shownProxy = (live: Live): { readonly text: string; readonly tone: Tone } =>
  live._tag === "Running"
    ? { text: `Running ${live.version}`, tone: "good" }
    : live._tag === "Reconnecting"
      ? { text: "Reconnecting…", tone: "warn" }
      : { text: "Connecting…", tone: "muted" }

/**
 * Why a change can't be made from this page now: it may only look, or
 * slopmax is not answering (the stream dropped). Undefined when it can be,
 * or while the stream is still connecting (a placeholder shows then).
 */
export const cannotChange = (unanswered: boolean, readOnly: boolean): string | undefined =>
  readOnly ? readOnlyShort : unanswered ? "slopmax is not answering" : undefined

/**
 * How an agent is wired, and whether that is through slopmax. A connected
 * agent's row says so in its label, so its line adds nothing; one not
 * installed says what connecting it does now.
 */
export const agentLine = (agent: AgentWiring): { readonly text?: string; readonly connected: boolean } =>
  agent.wired
    ? { connected: true }
    : !agent.installed
      ? {
          text: "Not installed on this machine. Connecting writes its settings now, so it goes through slopmax once installed.",
          connected: false,
        }
      : agent.wiredTo !== undefined
        ? { text: `Goes to ${agent.wiredTo}`, connected: false }
        : { text: "Goes straight to its provider", connected: false }

/** The agents installed on this machine first, in the order the API lists them. */
export const agentsInOrder = (agents: ReadonlyArray<AgentWiring>): ReadonlyArray<AgentWiring> => [
  ...agents.filter((agent) => agent.installed),
  ...agents.filter((agent) => !agent.installed),
]

/** Whether any agent goes through slopmax. */
export const anyWired = (agents: ReadonlyArray<AgentWiring>): boolean => agents.some((agent) => agent.wired)

// --- Notices a browser has shown ----------------------------------------------------

/** How many notices a browser remembers having shown. */
export const toldSize = 200

/** What names a notice for telling it once: its kind, account and moment. */
export const toldId = (notice: Notice): string =>
  `${notice.kind}|${notice.account ?? ""}|${notice.until === undefined ? "" : DateTime.formatIso(notice.until)}`

/** The notices not yet told, and the told list with them added (newest kept). */
export const tell = (
  told: ReadonlyArray<string>,
  notices: ReadonlyArray<Notice>,
): { readonly fresh: ReadonlyArray<Notice>; readonly told: ReadonlyArray<string> } => {
  const fresh = notices.filter((notice, i) => {
    const id = toldId(notice)
    return !told.includes(id) && notices.findIndex((other) => toldId(other) === id) === i
  })
  return { fresh, told: [...told, ...fresh.map(toldId)].slice(-toldSize) }
}
