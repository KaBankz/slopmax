// The live feed of requests, the sign-in card's steps, the proxy's state in
// words, and which notices a browser has already shown. Each is a small pure
// state with the functions that move it along.
import type { AgentWiring, LoginEvent, Notice, ProviderId, RequestRecord, Tone } from "@slopmax/client"
import { agentFacts, providerFacts } from "@slopmax/client"
import type { ProxyState } from "@slopmax/client/desktop"
import { compact, grouped } from "@slopmax/client/format"
import { DateTime } from "effect"

// --- Live requests -------------------------------------------------------------

/** How many requests the feed keeps, newest first. */
export const feedSize = 200

export interface FeedEntry {
  /** Unique within the feed, for React keys and the flash on arrival. */
  readonly seq: number
  readonly record: RequestRecord
}

/** Adds a request to the top of the feed, keeping the newest {@link feedSize}. */
export const pushFeed = (
  feed: ReadonlyArray<FeedEntry>,
  record: RequestRecord,
  seq: number,
): ReadonlyArray<FeedEntry> => [{ seq, record }, ...feed].slice(0, feedSize)

/** One request as the feed shows it. */
export interface FeedRow {
  readonly time: string
  readonly who: string
  readonly model: string
  readonly status: string
  readonly failed: boolean
  readonly detail: string
  readonly tokens: string
  readonly took: string
}

/** `420 ms`, `1.24 s`, `12.3 s`. */
export const secs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`

const timeFormat = new Map<string, Intl.DateTimeFormat>()

const timeOf = (at: DateTime.Utc, zone: DateTime.TimeZone): string => {
  const timeZone = DateTime.zoneToString(zone)
  let format = timeFormat.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    timeFormat.set(timeZone, format)
  }
  return DateTime.formatIntl(at, format)
}

/** A request is a failure when its status is outside 200–399. */
export const isFailure = (status: number): boolean => status < 200 || status >= 400

export const feedRow = (
  record: RequestRecord,
  accountName: (id: string) => string,
  zone: DateTime.TimeZone,
): FeedRow => {
  const failed = isFailure(record.status)
  const agent =
    record.agent === undefined ? "Other" : record.agent === "slopmax" ? "Warmup" : agentFacts[record.agent].title
  const tokens = record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite
  return {
    time: timeOf(record.at, zone),
    who: agent,
    model: record.model ?? "—",
    status: String(record.status),
    failed,
    detail: [
      record.account === undefined ? "no account free" : accountName(record.account),
      ...(record.attempts > 1 ? ["after failover"] : []),
      ...(record.via === "socket" ? ["WebSocket"] : []),
    ].join(" · "),
    tokens: tokens === 0 ? "—" : compact(tokens),
    took: record.firstByteMs === undefined ? secs(record.ms) : `${secs(record.firstByteMs)} · ${secs(record.ms)}`,
  }
}

// --- Sign-in ----------------------------------------------------------------------

export type SignInStep =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Authorize"; readonly url: string; readonly opened: boolean }
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
      return { ...signIn, step: { _tag: "Authorize", url: event.url, opened: event.opened } }
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
      return {
        title: `Signing in to ${title}`,
        detail: step.opened
          ? `Finish signing in to ${title} in your browser, which opened this address:`
          : `Open this address in a browser and sign in to ${title}:`,
        link: step.url,
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

/** The proxy's state as a short label with its tone, for the sidebar's foot and Settings. */
export const proxyLabel = (state: ProxyState): { readonly text: string; readonly tone: Tone } => {
  switch (state._tag) {
    case "Checking":
      return { text: "Looking for the proxy…", tone: "muted" }
    case "Starting":
      return { text: "Starting…", tone: "warn" }
    case "Running":
      return { text: `Running ${state.version}`, tone: "good" }
    case "Stopped":
      return { text: "Stopped", tone: "bad" }
    case "OtherVersion":
      return { text: `Running ${state.running}`, tone: "warn" }
  }
}

/**
 * What a part of the window that needs the running proxy says in its place:
 * how to get it running, or nothing while the window is still finding out
 * (a placeholder shows then, rather than a stopped proxy that is not).
 */
export const needsProxy = (state: ProxyState, doing: string): string | undefined => {
  switch (state._tag) {
    case "Stopped":
      return `Start the proxy to ${doing}`
    case "OtherVersion":
      return `Restart the proxy to ${doing}`
    case "Checking":
    case "Starting":
    case "Running":
      return undefined
  }
}

/** How an agent is wired, and whether that is through slopmax. */
export const agentLine = (agent: AgentWiring): { readonly text: string; readonly connected: boolean } =>
  agent.wired
    ? { text: "Goes through slopmax", connected: true }
    : agent.wiredTo !== undefined
      ? { text: `Goes to ${agent.wiredTo}`, connected: false }
      : { text: "Goes straight to its provider", connected: false }

/** The login service, as the Start at login setting shows it. */
export interface LoginService {
  readonly on: boolean
  readonly available: boolean
  readonly detail: string
}

export const loginService = (
  service: { readonly installed: boolean; readonly running: boolean } | undefined,
): LoginService =>
  service === undefined
    ? {
        on: false,
        available: false,
        detail: "This system has no login service slopmax can use, so the app starts the proxy while it runs.",
      }
    : {
        on: service.installed,
        available: true,
        detail:
          service.installed && !service.running
            ? "Runs the proxy whenever you log in. It is not running now."
            : "Runs the proxy whenever you log in, even while the app is closed.",
      }

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

/** `12 requests` for the panel. */
export const requestsLine = (n: number): string => (n === 0 ? "Nothing yet" : `${grouped(n)} requests`)
