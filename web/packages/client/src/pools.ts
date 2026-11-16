// A subscription pool over time (`GET /pools/{provider}`): its windows' use
// as the daemon recorded it every few minutes, where that use is heading,
// what each account's current windows have served, and how its requests
// fared by half hour. The daemon works it all out; clients only draw it.
import { Schema } from "effect"
import { AccountId, Instant, NonNegativeInt, PositiveInt, ProviderId, Span } from "./ids.ts"

export class TrendPoint extends Schema.Class<TrendPoint>("TrendPoint")({
  at: Instant,
  /** Percent of the pool used. */
  used: Schema.Number,
}) {}

/** An account's window resetting ahead, and the share of the pool that gives back. */
export class ResetMark extends Schema.Class<ResetMark>("ResetMark")({
  at: Instant,
  account: AccountId,
  givesBack: Schema.Number,
}) {}

export class Burn extends Schema.Class<Burn>("Burn")({
  hours: PositiveInt,
  /** Percent of the pool an hour. */
  rate: Schema.Number,
}) {}

export class FirstOut extends Schema.Class<FirstOut>("FirstOut")({
  account: AccountId,
  at: Instant,
}) {}

/** One of the pool's windows over every request, recorded and projected. */
export class Trend extends Schema.Class<Trend>("Trend")({
  span: Span,
  used: Schema.Number,
  /** Oldest first, ending now. */
  recorded: Schema.Array(TrendPoint),
  /** From now, at `burn`, given back as accounts reset. */
  projected: Schema.Array(TrendPoint),
  resets: Schema.Array(ResetMark),
  /** Percent of the pool an hour lately (over three hours when recorded). */
  burn: Schema.optionalKey(Schema.Number),
  burns: Schema.Array(Burn),
  /** The pace that would spend what is left, and what resets give back, over one window. */
  sustainable: Schema.optionalKey(Schema.Number),
  runsOutAt: Schema.optionalKey(Instant),
  dryUntil: Schema.optionalKey(Instant),
  firstOut: Schema.optionalKey(FirstOut),
}) {}

/** What one current window has served since it began. */
export class WindowSpend extends Schema.Class<WindowSpend>("WindowSpend")({
  span: Span,
  since: Instant,
  resetsAt: Instant,
  used: Schema.Number,
  requests: NonNegativeInt,
  tokens: NonNegativeInt,
  /** Dollars at API prices. */
  cost: Schema.Number,
  /** Dollars at API prices one percent of the window bought. */
  perPercent: Schema.optionalKey(Schema.Number),
}) {}

export class HealthCell extends Schema.Class<HealthCell>("HealthCell")({
  answered: NonNegativeInt,
  failed: NonNegativeInt,
}) {}

export class AccountDetail extends Schema.Class<AccountDetail>("AccountDetail")({
  id: AccountId,
  windows: Schema.Array(WindowSpend),
  /** Oldest cell first, each `cellMinutes` long from `healthSince`. */
  health: Schema.Array(HealthCell),
}) {}

export class PoolDetail extends Schema.Class<PoolDetail>("PoolDetail")({
  provider: ProviderId,
  generatedAt: Instant,
  /** Shortest window first. */
  trends: Schema.Array(Trend),
  accounts: Schema.Array(AccountDetail),
  healthSince: Instant,
  cellMinutes: PositiveInt,
}) {}
