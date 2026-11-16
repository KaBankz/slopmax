// The Requests page as words: what it lists (live off the event stream, or
// a range of the ledger, filtered), each row, the facts of one request in
// its sheet, the totals line, and the CSV it exports. Pure.
import {
  agentFacts,
  type HistoryRange,
  providerFacts,
  type RequestEnd,
  type RequestOutcome,
  type RequestPage,
  type RequestRecord,
  type RequestRow,
  type RequestSender,
} from "@slopmax/client"
import { compact, grouped } from "@slopmax/client/format"
import { DateTime } from "effect"
import { isFailure, secs } from "./live.ts"
import { count, dollars } from "./words.ts"

/** What the page lists: the live feed, or a range of the ledger. */
export type Listing = "live" | HistoryRange

export interface RequestFilter {
  readonly span: Listing
  readonly account?: string
  readonly model?: string
  readonly agent?: RequestSender
  readonly outcome: RequestOutcome
}

export const allRequests: RequestFilter = { span: "live", outcome: "all" }

export const listings: ReadonlyArray<{ readonly value: Listing; readonly title: string }> = [
  { value: "live", title: "Live" },
  { value: "today", title: "Today" },
  { value: "7d", title: "7 days" },
  { value: "30d", title: "30 days" },
]

export const outcomes: ReadonlyArray<{ readonly value: RequestOutcome; readonly title: string }> = [
  { value: "all", title: "Any outcome" },
  { value: "answered", title: "Answered" },
  { value: "failed", title: "Failed" },
  { value: "rescued", title: "Saved by failover" },
]

/** Rows read at first, and added by each "Show more". */
export const pageSize = 100

/** A filter with some of its parts changed; an `undefined` part means any. */
export const refine = (
  filter: RequestFilter,
  patch: { readonly [K in keyof RequestFilter]?: RequestFilter[K] | undefined },
): RequestFilter => {
  const account = "account" in patch ? patch.account : filter.account
  const model = "model" in patch ? patch.model : filter.model
  const agent = "agent" in patch ? patch.agent : filter.agent
  return {
    span: patch.span ?? filter.span,
    outcome: patch.outcome ?? filter.outcome,
    ...(account === undefined ? {} : { account }),
    ...(model === undefined ? {} : { model }),
    ...(agent === undefined ? {} : { agent }),
  }
}

/** Whether a filter narrows the list beyond its span. */
export const narrowed = (filter: RequestFilter): boolean =>
  filter.account !== undefined || filter.model !== undefined || filter.agent !== undefined || filter.outcome !== "all"

/** Who sent a request, in words. */
export const senderTitle = (agent: RequestSender | undefined): string =>
  agent === undefined ? "Other" : agent === "slopmax" ? "Warmup" : agentFacts[agent].title

const formats = new Map<string, Intl.DateTimeFormat>()

const formatIn = (zone: DateTime.TimeZone, withDay: boolean): Intl.DateTimeFormat => {
  const timeZone = DateTime.zoneToString(zone)
  const key = `${withDay} ${timeZone}`
  let format = formats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      ...(withDay ? { month: "short", day: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formats.set(key, format)
  }
  return format
}

/** `14:03:22`, or `Nov 14, 14:03:22` for a request on another day than `now`. */
export const when = (at: DateTime.Utc, now: DateTime.Utc, zone: DateTime.TimeZone): string => {
  const day = (t: DateTime.Utc) => DateTime.formatIsoDate(DateTime.setZone(t, zone))
  return DateTime.formatIntl(at, formatIn(zone, day(at) !== day(now)))
}

const ends: { readonly [K in RequestEnd]: string } = {
  "upstream-error": "The provider broke the answer off",
  "client-gone": "The agent hung up first",
  stalled: "The provider went quiet for too long",
  cut: "slopmax stopped while it streamed",
}

/** One row of the table. */
export interface RowView {
  readonly key: string
  readonly time: string
  readonly who: string
  readonly model: string
  readonly account: string
  readonly status: string
  readonly failed: boolean
  /** `after failover`, `WebSocket`, how it ended. */
  readonly notes: ReadonlyArray<string>
  readonly tokens: string
  readonly cost: string
  readonly took: string
}

const tokensOf = (record: RequestRecord) =>
  record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite

export const rowView = (
  row: RequestRow,
  index: number,
  name: (id: string) => string,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): RowView => {
  const record = row.record
  const tokens = tokensOf(record)
  return {
    key: `${DateTime.toEpochMillis(record.at)}-${index}`,
    time: when(record.at, now, zone),
    who: senderTitle(record.agent),
    model: record.model ?? "—",
    account: record.account === undefined ? "No account free" : name(record.account),
    status: String(record.status),
    failed: isFailure(record.status) || (row.end !== undefined && row.end !== "client-gone"),
    notes: [
      ...(record.attempts > 1 && !isFailure(record.status) ? ["after failover"] : []),
      ...(record.via === "socket" ? ["WebSocket"] : []),
      ...(row.end === undefined ? [] : [row.end === "client-gone" ? "interrupted" : "broken off"]),
    ],
    tokens: tokens === 0 ? "—" : compact(tokens),
    cost: row.cost === undefined || tokens === 0 ? "—" : dollars(row.cost),
    took: record.firstByteMs === undefined ? secs(record.ms) : `${secs(record.firstByteMs)} · ${secs(record.ms)}`,
  }
}

/** A fact of one request, for its sheet. */
export interface Fact {
  readonly title: string
  readonly value: string
  readonly mono?: boolean
}

const statusWords = (status: number): string => {
  if (status < 400) return "answered"
  if (status === 401 || status === 403) return "refused the sign-in"
  if (status === 429) return "rate limited"
  if (status === 529 || status === 503) return "overloaded"
  if (status >= 500) return "the provider failed"
  return "refused"
}

/** Everything known of one request, grouped for its sheet. */
export const facts = (
  row: RequestRow,
  name: (id: string) => string,
  zone: DateTime.TimeZone,
): ReadonlyArray<{ readonly title: string; readonly facts: ReadonlyArray<Fact> }> => {
  const r = row.record
  const at = DateTime.formatIntl(
    r.at,
    new Intl.DateTimeFormat("en-US", {
      timeZone: DateTime.zoneToString(zone),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    }),
  )
  return [
    {
      title: "Request",
      facts: [
        { title: "When", value: at },
        { title: "Sent by", value: senderTitle(r.agent) },
        { title: "Model", value: r.model ?? "—", mono: true },
        { title: "Provider", value: providerFacts[r.provider].title },
        { title: "Account", value: r.account === undefined ? "None was free" : name(r.account) },
        ...(r.session === undefined ? [] : [{ title: "Session", value: r.session, mono: true }]),
        { title: "Connection", value: r.via === "socket" ? "WebSocket" : "HTTP" },
      ],
    },
    {
      title: "Outcome",
      facts: [
        { title: "Status", value: `${r.status}, ${statusWords(r.status)}` },
        {
          title: "Accounts tried",
          value:
            r.attempts === 1
              ? "1"
              : isFailure(r.status)
                ? `${r.attempts}, none could answer`
                : `${r.attempts}, failover saved it`,
        },
        ...(row.end === undefined ? [] : [{ title: "Ended", value: ends[row.end] }]),
        ...(r.firstByteMs === undefined ? [] : [{ title: "First byte", value: secs(r.firstByteMs) }]),
        { title: "Total", value: secs(r.ms) },
      ],
    },
    {
      title: "Tokens",
      facts: [
        { title: "Input", value: grouped(r.usage.input) },
        { title: "Output", value: grouped(r.usage.output) },
        { title: "Cache read", value: grouped(r.usage.cacheRead) },
        { title: "Cache write", value: grouped(r.usage.cacheWrite) },
        { title: "At API prices", value: row.cost === undefined ? "No known price" : dollars(row.cost) },
      ],
    },
  ]
}

/** `1,204 requests · 12 failed · 3 saved by failover · 48.2M tokens · $412.20 at API prices`. */
export const totalsLine = (page: RequestPage): string =>
  [
    count(page.matched, "request"),
    ...(page.failed > 0 ? [`${grouped(page.failed)} failed`] : []),
    ...(page.rescued > 0 ? [`${grouped(page.rescued)} saved by failover`] : []),
    `${compact(page.tokens)} tokens`,
    `${dollars(page.cost)} at API prices`,
  ].join(" · ")

const cell = (value: string | number | undefined): string => {
  const text = value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The rows as CSV, one line each, times in UTC, with a header. */
export const csv = (rows: ReadonlyArray<RequestRow>, name: (id: string) => string): string => {
  const header = [
    "time",
    "agent",
    "provider",
    "model",
    "account",
    "status",
    "attempts",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "cost_usd",
    "first_byte_ms",
    "total_ms",
    "session",
    "via",
    "end",
  ]
  const lines = rows.map((row) => {
    const r = row.record
    return [
      DateTime.formatIso(r.at),
      r.agent ?? "",
      r.provider,
      r.model,
      r.account === undefined ? "" : name(r.account),
      r.status,
      r.attempts,
      r.usage.input,
      r.usage.output,
      r.usage.cacheRead,
      r.usage.cacheWrite,
      row.cost === undefined ? "" : row.cost.toFixed(6),
      r.firstByteMs,
      r.ms,
      r.session,
      r.via,
      row.end,
    ]
      .map(cell)
      .join(",")
  })
  return `${[header.join(","), ...lines].join("\n")}\n`
}

/** `slopmax-requests-2026-11-16.csv`. */
export const csvName = (now: DateTime.Utc, zone: DateTime.TimeZone): string =>
  `slopmax-requests-${DateTime.formatIsoDate(DateTime.setZone(now, zone))}.csv`
