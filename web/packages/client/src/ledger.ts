// The usage ledger: one record per request slopmax answered, and one per
// usage window that ran out, appended a line at a time to `usage/YYYY-MM.ndjson`.
// The summaries, the history charts and "left on the table" are read from it;
// their shapes are here so the CLI, the API and the UI share them.
import { Schema } from "effect"
import { AccountId, AgentId, Instant, NonNegativeInt, ProviderId, Span, withDefault } from "./ids.ts"

const count = NonNegativeInt.pipe(withDefault(0))

/** Requests and the tokens they moved. */
export class Usage extends Schema.Class<Usage>("Usage")({
  requests: count,
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
}) {
  static readonly zero: Usage = Schema.decodeUnknownSync(Usage)({})

  plus(that: Usage): Usage {
    // Sums of counts already checked are whole and never negative: the checks are skipped, as every answer adds one.
    return new Usage(
      {
        requests: this.requests + that.requests,
        input: this.input + that.input,
        output: this.output + that.output,
        cacheRead: this.cacheRead + that.cacheRead,
        cacheWrite: this.cacheWrite + that.cacheWrite,
      },
      { disableChecks: true },
    )
  }

  /** Every token, read from cache or not. */
  get tokens(): number {
    return this.input + this.output + this.cacheRead + this.cacheWrite
  }
}

/** Who sent a request: an agent, or slopmax itself warming a window. */
export const RequestSender = Schema.Union([AgentId, Schema.Literal("slopmax")])
export type RequestSender = typeof RequestSender.Type

export const LedgerRecord = Schema.TaggedUnion({
  /** A request slopmax answered, whatever the outcome. */
  Request: {
    at: Instant,
    /** The account that answered, or the last one tried; absent when none was free. */
    account: Schema.optionalKey(AccountId),
    provider: ProviderId,
    model: Schema.optionalKey(Schema.String),
    status: Schema.Int,
    usage: Usage.pipe(withDefault({})),
    /** From the request to the end of the answer. */
    ms: NonNegativeInt,
    /** From the request to the first byte of the answer. */
    firstByteMs: Schema.optionalKey(NonNegativeInt),
    /** Accounts tried; more than one means a failover rescued the request. */
    attempts: Schema.Int.pipe(withDefault(1)),
    agent: Schema.optionalKey(RequestSender),
    session: Schema.optionalKey(Schema.String),
    via: Schema.Literals(["http", "socket"]).pipe(withDefault("http")),
    /** The machine that sent it: a client key's name or a tailnet machine; left out for the hub's own key. */
    machine: Schema.optionalKey(Schema.String),
  },
  /** A usage window that reset, with how much of it had been used: the rest was thrown away. */
  WindowEnded: {
    at: Instant,
    account: AccountId,
    provider: ProviderId,
    plan: Schema.optionalKey(Schema.String),
    span: Span,
    model: Schema.optionalKey(Schema.String),
    used: Schema.Number,
  },
})
export type LedgerRecord = typeof LedgerRecord.Type
export type RequestRecord = typeof LedgerRecord.cases.Request.Type
export type WindowEndedRecord = typeof LedgerRecord.cases.WindowEnded.Type

export const SummaryRange = Schema.Literals(["today", "7d", "30d", "all"]).annotate({
  message: "range is today, 7d, 30d, or all",
})
export type SummaryRange = typeof SummaryRange.Type
export const SummaryBy = Schema.Literals(["day", "model", "account", "machine"]).annotate({
  message: "by is day, model, account, or machine",
})
export type SummaryBy = typeof SummaryBy.Type
export const HistoryRange = Schema.Literals(["today", "7d", "30d"]).annotate({ message: "range is today, 7d, or 30d" })
export type HistoryRange = typeof HistoryRange.Type

const amount = Schema.Finite.pipe(withDefault(0))

/** What a set of requests came to. */
export class Totals extends Schema.Class<Totals>("Totals")({
  /** Answers only; failures and housekeeping are not requests here. */
  requests: count,
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  /** Dollars at API prices, for the answers whose model has a price. */
  cost: amount,
  /** Answers whose model has no price. */
  unpriced: count,
  failed: count,
}) {
  static readonly zero: Totals = Schema.decodeUnknownSync(Totals)({})

  get tokens(): number {
    return this.input + this.output + this.cacheRead + this.cacheWrite
  }
}

export class SummaryRow extends Schema.Class<SummaryRow>("SummaryRow")({
  /**
   * The local day (`2026-10-31`), the model (`-` when none), the account's
   * name, or the machine's (`this machine`, or `hub` read from another
   * machine, for the hub's own key).
   */
  key: Schema.String,
  totals: Totals,
}) {}

/** `slopmax usage` and `GET /usage`: totals since the range's start, in rows by day, model, account or machine. */
export class Summary extends Schema.Class<Summary>("Summary")({
  range: SummaryRange,
  by: SummaryBy,
  since: Instant,
  /** Sorted by key. */
  rows: Schema.Array(SummaryRow),
  total: Totals,
}) {}

export class LeftAccount extends Schema.Class<LeftAccount>("LeftAccount")({
  name: Schema.String,
  provider: ProviderId,
  windows: NonNegativeInt,
  /** Mean percent unused. */
  unused: Schema.Number,
  dollars: Schema.Number,
}) {}

/** Weekly and monthly quota that resets threw away, and what that part of each plan cost. */
export class LeftOnTheTable extends Schema.Class<LeftOnTheTable>("LeftOnTheTable")({
  windows: NonNegativeInt,
  /** Mean percent unused across those windows. */
  unused: Schema.Number,
  dollars: Schema.Number,
  /** Windows on plans without a known price. */
  unpriced: NonNegativeInt,
  /** Most dollars first, then most unused. */
  accounts: Schema.Array(LeftAccount),
}) {
  static readonly none: LeftOnTheTable = new LeftOnTheTable({
    windows: 0,
    unused: 0,
    dollars: 0,
    unpriced: 0,
    accounts: [],
  })
}

/** One bar of the history chart: an hour of today, or a day of the week or month. */
export class HistoryBucket extends Schema.Class<HistoryBucket>("HistoryBucket")({
  /** `14:00`, or `Oct 31`. */
  label: Schema.String,
  /** Tokens per provider, in the order of `History.providers`. */
  tokens: Schema.Array(Schema.Number),
  requests: NonNegativeInt,
  failed: NonNegativeInt,
  /** Answers a failover rescued. */
  rescued: NonNegativeInt,
  sessions: NonNegativeInt,
  cost: Schema.Number,
  /** The share of input read from cache, 0 to 1, when anything was read. */
  cached: Schema.optionalKey(Schema.Number),
  /** Milliseconds to the first byte, median and slowest twentieth. */
  firstByte: Schema.optionalKey(Schema.Tuple([Schema.Number, Schema.Number])),
}) {}

export class NamedTotals extends Schema.Class<NamedTotals>("NamedTotals")({
  name: Schema.String,
  totals: Totals,
}) {}

export class AccountTotals extends Schema.Class<AccountTotals>("AccountTotals")({
  name: Schema.String,
  provider: ProviderId,
  totals: Totals,
}) {}

export class Speed extends Schema.Class<Speed>("Speed")({
  model: Schema.String,
  provider: ProviderId,
  /** The median output speed. */
  tokensPerSecond: Schema.Number,
}) {}

/** `GET /history`: what went through slopmax over a range, shaped for the app's charts. */
export class History extends Schema.Class<History>("History")({
  range: HistoryRange,
  buckets: Schema.Array(HistoryBucket),
  /** Providers that answered anything in the range, in registry order. */
  providers: Schema.Array(ProviderId),
  total: Totals,
  /** Answers a failover rescued. */
  rescued: NonNegativeInt,
  /** Failures no account was free for. */
  unplaced: NonNegativeInt,
  /** Dollars billed to API keys. */
  billed: Schema.Number,
  left: LeftOnTheTable,
  /** Dollars the cache saved at API prices. */
  cacheSaved: Schema.Number,
  cached: Schema.optionalKey(Schema.Number),
  sessions: NonNegativeInt,
  /** Median milliseconds to the first byte. */
  firstByte: Schema.optionalKey(Schema.Number),
  /** A month at this pace, in dollars at API prices (the 7-day range only). */
  monthly: Schema.optionalKey(Schema.Number),
  /** Requests by local weekday (Monday first) and hour: 7 rows of 24. */
  activity: Schema.Array(Schema.Array(NonNegativeInt)),
  models: Schema.Array(NamedTotals),
  accounts: Schema.Array(AccountTotals),
  /** `Claude Code`, `Codex`, `Warmups`, `Other`, most tokens first. */
  agents: Schema.Array(NamedTotals),
  /** Fastest first. */
  speeds: Schema.Array(Speed),
}) {}

/** How a streamed answer ended, when not by completing. */
export const RequestEnd = Schema.Literals(["upstream-error", "client-gone", "stalled", "cut"])
export type RequestEnd = typeof RequestEnd.Type

/** Which requests `GET /requests` lists by how they went; `rescued` were answered by another account after the first could not. */
export const RequestOutcome = Schema.Literals(["all", "answered", "failed", "rescued"])
export type RequestOutcome = typeof RequestOutcome.Type

/** One request of the ledger, with what it was worth. */
export class RequestRow extends Schema.Class<RequestRow>("RequestRow")({
  record: LedgerRecord.cases.Request,
  /** Dollars at API prices, for a model with a known price. */
  cost: Schema.optionalKey(Schema.Number),
  end: Schema.optionalKey(RequestEnd),
}) {}

/** Every account, model and agent that appears in a range, to filter it by. */
export class RequestFacets extends Schema.Class<RequestFacets>("RequestFacets")({
  accounts: Schema.Array(AccountId),
  models: Schema.Array(Schema.String),
  agents: Schema.Array(RequestSender),
}) {}

/** `GET /requests`: a page of the ledger's requests, newest first, and the totals of every match. */
export class RequestPage extends Schema.Class<RequestPage>("RequestPage")({
  range: HistoryRange,
  since: Instant,
  rows: Schema.Array(RequestRow),
  offset: NonNegativeInt,
  matched: NonNegativeInt,
  failed: NonNegativeInt,
  rescued: NonNegativeInt,
  tokens: NonNegativeInt,
  cost: Schema.Number,
  facets: RequestFacets,
}) {}
