// The fixture ledger's requests over the last month, and `GET /requests`
// answered from them as the daemon answers: filtered, newest first, a page
// at a time, with the totals of every match and what the range offers to
// filter by. Every time is relative to `now`; the wobble repeats.
import {
  AccountId,
  type HistoryRange,
  LedgerRecord,
  RequestFacets,
  type RequestOutcome,
  RequestPage,
  RequestRow,
  type RequestSender,
  Usage,
} from "@slopmax/client"
import { DateTime } from "effect"

const noise = (n: number): number => Math.abs((Math.sin(n * 78.233) * 43_758.5453) % 1)

const accounts = [
  { id: "claude-1a2b3c4d", provider: "claude", models: ["claude-opus-5-5", "claude-fable-5-1"], weight: 5 },
  { id: "claude-5e6f7a8b", provider: "claude", models: ["claude-opus-5-5", "claude-haiku-5-5"], weight: 2 },
  { id: "claude-9c0d1e2f", provider: "claude", models: ["claude-haiku-5-5"], weight: 1 },
  { id: "codex-3a4b5c6d", provider: "codex", models: ["gpt-6-sol", "gpt-6-mini"], weight: 3 },
] as const

const price: Readonly<Record<string, readonly [number, number, number]>> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-fable-5-1": [3, 15, 0.3],
  "claude-haiku-5-5": [1, 5, 0.1],
  "gpt-6-sol": [2.5, 15, 0.25],
  "gpt-6-mini": [0.3, 1.2, 0.03],
}

interface Kept {
  readonly row: RequestRow
  readonly failed: boolean
  readonly rescued: boolean
  readonly tokens: number
}

/** About four hundred requests a day, oldest first. */
export const fixtureRequests = (now: DateTime.Utc): ReadonlyArray<Kept> => {
  const end = DateTime.toEpochMillis(now)
  const every = 3.5 * 60_000
  const kept: Array<Kept> = []
  const total = Math.floor((30 * 86_400_000) / every)
  for (let i = total; i >= 1; i--) {
    const t = end - i * every + Math.round(noise(i) * every * 0.8)
    const n = noise(i * 7)
    const account = accounts[Math.floor(noise(i * 3) * 11) % accounts.length] ?? accounts[0]
    const model = account.models[Math.floor(noise(i * 5) * account.models.length)] ?? account.models[0]
    const status = n < 0.02 ? 529 : n < 0.03 ? 429 : 200
    const attempts = status === 200 && noise(i * 11) < 0.04 ? 2 : status === 200 ? 1 : 3
    const failed = status !== 200
    const input = failed ? 0 : Math.round(300 + noise(i * 13) * 4_000)
    const output = failed ? 0 : Math.round(80 + noise(i * 17) * 2_400)
    const cacheRead = failed ? 0 : Math.round(noise(i * 19) * 90_000)
    const cacheWrite = failed ? 0 : Math.round(noise(i * 23) * 4_000)
    const [pin, pout, pcache] = price[model] ?? [0, 0, 0]
    const cost = (input * pin + output * pout + cacheRead * pcache + cacheWrite * pin * 1.25) / 1_000_000
    const agent: RequestSender =
      account.provider === "codex" ? "codex" : noise(i * 29) < 0.03 ? "slopmax" : "claude-code"
    const ms = Math.round(1_500 + noise(i * 31) * 40_000)
    const record = LedgerRecord.cases.Request.make({
      at: DateTime.makeUnsafe(t),
      account: AccountId.make(account.id),
      provider: account.provider,
      model,
      status,
      usage: new Usage({ requests: 1, input, output, cacheRead, cacheWrite }),
      ms,
      ...(failed ? {} : { firstByteMs: Math.round(300 + noise(i * 37) * 1_800) }),
      attempts,
      agent,
      session: `session-${Math.floor(i / 40)}`,
      ...(account.provider === "claude" && noise(i * 47) < 0.3 ? { machine: "laptop" } : {}),
      via: account.provider === "codex" && noise(i * 41) < 0.5 ? "socket" : "http",
    })
    const interrupted = !failed && noise(i * 43) < 0.01
    kept.push({
      row: new RequestRow({
        record,
        ...(failed ? {} : { cost }),
        ...(interrupted ? { end: "client-gone" as const } : {}),
      }),
      failed,
      rescued: !failed && attempts > 1,
      tokens: input + output + cacheRead + cacheWrite,
    })
  }
  return kept
}

const days: { readonly [K in HistoryRange]: number } = { today: 0, "7d": 6, "30d": 29 }

/** `GET /requests` over the fixture ledger. */
export const fixtureRequestPage = (
  now: DateTime.Utc,
  quiet: boolean,
  query: {
    readonly range: HistoryRange
    readonly account?: string
    readonly model?: string
    readonly agent?: RequestSender
    readonly outcome: RequestOutcome
    readonly offset?: number
    readonly limit?: number
  },
): RequestPage => {
  const zone = DateTime.zoneMakeLocal()
  const since = DateTime.subtract(DateTime.startOf(DateTime.setZone(now, zone), "day"), { days: days[query.range] })
  const inRange = (quiet ? [] : fixtureRequests(now))
    .filter((kept) => DateTime.isGreaterThanOrEqualTo(kept.row.record.at, since))
    .toReversed()
  const takes = (kept: Kept) =>
    (query.account === undefined || kept.row.record.account === query.account) &&
    (query.model === undefined || kept.row.record.model === query.model) &&
    (query.agent === undefined || kept.row.record.agent === query.agent) &&
    (query.outcome === "all" ||
      (query.outcome === "failed" ? kept.failed : query.outcome === "rescued" ? kept.rescued : !kept.failed))
  const matched = inRange.filter(takes)
  const offset = query.offset ?? 0
  const limit = Math.min(1_000, Math.max(1, query.limit ?? 100))
  const answered = matched.filter((kept) => !kept.failed)
  return new RequestPage({
    range: query.range,
    since: DateTime.toUtc(since),
    rows: matched.slice(offset, offset + limit).map((kept) => kept.row),
    offset,
    matched: matched.length,
    failed: matched.length - answered.length,
    rescued: matched.filter((kept) => kept.rescued).length,
    tokens: answered.reduce((sum, kept) => sum + kept.tokens, 0),
    cost: answered.reduce((sum, kept) => sum + (kept.row.cost ?? 0), 0),
    facets: new RequestFacets({
      accounts: [...new Set(inRange.flatMap((kept) => kept.row.record.account ?? []))].toSorted(),
      models: [...new Set(inRange.flatMap((kept) => kept.row.record.model ?? []))].toSorted(),
      agents: (["claude-code", "codex", "slopmax"] as const).filter((agent) =>
        inRange.some((kept) => kept.row.record.agent === agent),
      ),
    }),
  })
}
