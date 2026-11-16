// The fixture pools over time: a week of Claude and ChatGPT readings as the
// daemon would have recorded them, each account filling through working
// hours and starting over at its resets, then projected as the daemon
// projects them. Every time is relative to `now`, and the wobble repeats,
// so tests pin it and the dev server draws the same week every time.
import {
  AccountDetail,
  AccountId,
  Burn,
  FirstOut,
  HealthCell,
  PoolDetail,
  ResetMark,
  type Span,
  type SubscriptionId,
  Trend,
  TrendPoint,
  WindowSpend,
} from "@slopmax/client"
import { DateTime } from "effect"

const minute = 60_000
const hour = 60 * minute
const spanMs: { readonly [K in Span]: number } = { "5h": 5 * hour, "7d": 7 * 24 * hour, "30d": 30 * 24 * hour }

interface WindowSpec {
  readonly span: Span
  readonly used: number
  /** Minutes until it resets. */
  readonly resetsIn: number
  /** Dollars at API prices a percent of it buys. */
  readonly perPercent: number
}

interface AccountSpec {
  readonly id: string
  readonly share: number
  readonly windows: ReadonlyArray<WindowSpec>
  /** Failures in the last day's half hours, by cell. */
  readonly failures?: Readonly<Record<number, number>>
}

const specs: { readonly [K in SubscriptionId]?: ReadonlyArray<AccountSpec> } = {
  claude: [
    {
      id: "claude-1a2b3c4d",
      share: 0.66,
      windows: [
        { span: "5h", used: 62, resetsIn: 100, perPercent: 1.42 },
        { span: "7d", used: 48, resetsIn: 4_560, perPercent: 33.8 },
      ],
    },
    {
      id: "claude-5e6f7a8b",
      share: 0.25,
      windows: [
        { span: "5h", used: 18, resetsIn: 230, perPercent: 0.36 },
        { span: "7d", used: 81, resetsIn: 1_560, perPercent: 8.5 },
      ],
      failures: { 31: 1 },
    },
    {
      id: "claude-9c0d1e2f",
      share: 0.09,
      windows: [
        { span: "5h", used: 100, resetsIn: 52, perPercent: 0.12 },
        { span: "7d", used: 64, resetsIn: 6_200, perPercent: 2.4 },
      ],
      failures: { 44: 3, 45: 6, 46: 2 },
    },
  ],
  codex: [
    {
      id: "codex-3a4b5c6d",
      share: 1,
      windows: [
        { span: "5h", used: 34, resetsIn: 170, perPercent: 0.9 },
        { span: "7d", used: 55, resetsIn: 1_190, perPercent: 11.2 },
      ],
    },
  ],
}

/** A repeatable wobble in 0..1. */
const noise = (n: number): number => Math.abs((Math.sin(n * 12.9898) * 43_758.5453) % 1)

/** The working day's shape by hour, kept by zone and hour: reading a local hour is the slow part. */
const dayShape = new Map<string, number>()

/** How busy the hour at `t` is: the working day, a quieter evening, little at night. */
const activity = (t: number, zone: DateTime.TimeZone): number => {
  const key = `${DateTime.zoneToString(zone)} ${Math.floor(t / hour)}`
  let base = dayShape.get(key)
  if (base === undefined) {
    const local = DateTime.setZone(DateTime.makeUnsafe(t), zone)
    const h = DateTime.getPart(local, "hour")
    const weekend = [0, 6].includes(DateTime.getPart(local, "weekDay"))
    base = (h >= 9 && h < 19 ? 1 : h >= 19 && h < 24 ? 0.35 : h >= 7 ? 0.3 : 0.03) * (weekend ? 0.4 : 1)
    dayShape.set(key, base)
  }
  return base * (0.7 + 0.6 * noise(Math.floor(t / (20 * minute))))
}

/** Work done from `from` to `to`, summed in ten-minute steps. */
const work = (from: number, to: number, zone: DateTime.TimeZone): number => {
  let sum = 0
  for (let t = from; t < to; t += 10 * minute) sum += activity(t, zone) * Math.min(10 * minute, to - t)
  return sum
}

/** An account's use of a window at `t`: the current window filling to its use now, earlier ones to a past peak. */
const usedAt = (window: WindowSpec, t: number, now: number, zone: DateTime.TimeZone): number => {
  const length = spanMs[window.span]
  const next = now + window.resetsIn * minute
  const k = Math.max(0, Math.floor((next - t) / length))
  const end = next - k * length
  const start = end - length
  if (k === 0) {
    const whole = work(start, now, zone)
    return whole === 0 ? 0 : (window.used * work(start, t, zone)) / whole
  }
  const peak = window.span === "5h" ? 35 + 60 * noise(end / hour) : 70 + 28 * noise(end / hour)
  return (peak * work(start, t, zone)) / work(start, end, zone)
}

const round = (n: number) => Math.round(n * 10) / 10

/** Percent an hour a line rose over the last `hours`, its drops left out. */
const pace = (line: ReadonlyArray<readonly [number, number]>, now: number, hours: number): number | undefined => {
  const within = line.filter(([t]) => t >= now - hours * hour)
  const first = within[0]
  if (first === undefined || within.length < 2) return undefined
  let rise = 0
  for (let i = 1; i < within.length; i++) rise += Math.max(0, (within[i]?.[1] ?? 0) - (within[i - 1]?.[1] ?? 0))
  return rise / ((now - first[0]) / hour)
}

/** The daemon's projection: filling at `burn`, flat at 100 while spent, given back at each reset. */
const project = (
  now: number,
  used: number,
  burn: number,
  resets: ReadonlyArray<{ readonly t: number; readonly back: number }>,
  until: number,
) => {
  const points: Array<readonly [number, number]> = [[now, used]]
  let at = now
  let level = used
  let runsOut: number | undefined
  let dryUntil: number | undefined
  const advance = (to: number) => {
    if (level < 100 && burn > 0) {
      const full = at + ((100 - level) / burn) * hour
      if (full < to) {
        points.push([full, 100])
        runsOut ??= full
        level = 100
      } else level += (burn * (to - at)) / hour
    }
    at = to
    points.push([to, round(level)])
  }
  for (const reset of resets) {
    advance(reset.t)
    if (level >= 100 && runsOut !== undefined && dryUntil === undefined) dryUntil = reset.t
    level = Math.max(0, level - reset.back)
    points.push([reset.t, round(level)])
  }
  advance(until)
  return { points, runsOut, dryUntil }
}

const instant = (t: number) => DateTime.makeUnsafe(Math.round(t))

const trend = (accounts: ReadonlyArray<AccountSpec>, span: Span, nowAt: DateTime.Utc, zone: DateTime.TimeZone) => {
  const now = DateTime.toEpochMillis(nowAt)
  const [back, ahead, step] =
    span === "5h" ? [24 * hour, 5 * hour, 10 * minute] : [7 * 24 * hour, 3 * 24 * hour, 30 * minute]
  const windowOf = (account: AccountSpec) => account.windows.find((w) => w.span === span)
  const lineOf = (account: AccountSpec): Array<readonly [number, number]> => {
    const window = windowOf(account)
    if (window === undefined) return []
    const line: Array<readonly [number, number]> = []
    for (let t = now - back; t < now; t += step) line.push([t, usedAt(window, t, now, zone)])
    line.push([now, window.used])
    return line
  }
  const lines = accounts.map(lineOf)
  const pool: Array<readonly [number, number]> = (lines[0] ?? []).map(([t], i) => [
    t,
    round(accounts.reduce((sum, account, k) => sum + account.share * (lines[k]?.[i]?.[1] ?? 0), 0)),
  ])
  const used = pool.at(-1)?.[1] ?? 0
  const burns = [1, 3, 6].flatMap((h) => {
    const rate = pace(pool, now, h)
    return rate === undefined ? [] : [new Burn({ hours: h, rate: Math.round(rate * 100) / 100 })]
  })
  const burn = burns.find((b) => b.hours === 3)?.rate
  const marks = accounts
    .flatMap((account) => {
      const window = windowOf(account)
      if (window === undefined || window.used === 0) return []
      return [{ t: now + window.resetsIn * minute, back: round(account.share * window.used), id: account.id }]
    })
    .toSorted((a, b) => a.t - b.t)
  const length = spanMs[span]
  const sustainable =
    (100 - used + marks.filter((m) => m.t <= now + length).reduce((sum, m) => sum + m.back, 0)) / (length / hour)
  const resets = marks.filter((m) => m.t <= now + ahead)
  const projection = project(now, used, burn ?? 0, resets, now + ahead)
  const firstOut = accounts
    .flatMap((account, k) => {
      const window = windowOf(account)
      const rate = pace(lines[k] ?? [], now, 3)
      if (window === undefined || rate === undefined || rate <= 0 || window.used >= 100) return []
      const at = now + ((100 - window.used) / rate) * hour
      return at < now + window.resetsIn * minute ? [{ id: account.id, at }] : []
    })
    .toSorted((a, b) => a.at - b.at)[0]
  return new Trend({
    span,
    used,
    recorded: pool.map(([t, u]) => new TrendPoint({ at: instant(t), used: u })),
    projected: projection.points.map(([t, u]) => new TrendPoint({ at: instant(t), used: u })),
    resets: resets.map((m) => new ResetMark({ at: instant(m.t), account: AccountId.make(m.id), givesBack: m.back })),
    ...(burn === undefined ? {} : { burn }),
    burns,
    sustainable: Math.round(sustainable * 100) / 100,
    ...(projection.runsOut === undefined ? {} : { runsOutAt: instant(projection.runsOut) }),
    ...(projection.dryUntil === undefined ? {} : { dryUntil: instant(projection.dryUntil) }),
    ...(firstOut === undefined
      ? {}
      : { firstOut: new FirstOut({ account: AccountId.make(firstOut.id), at: instant(firstOut.at) }) }),
  })
}

const cellMinutes = 30
const cells = 48

/** A provider's pool over the last week, as `GET /pools/{provider}` answers. */
export const fixturePool = (
  provider: SubscriptionId,
  nowAt: DateTime.Utc,
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): PoolDetail | undefined => {
  const accounts = specs[provider]
  if (accounts === undefined) return undefined
  const now = DateTime.toEpochMillis(nowAt)
  const cell = cellMinutes * minute
  const since = Math.floor(now / cell) * cell - (cells - 1) * cell
  return new PoolDetail({
    provider,
    generatedAt: nowAt,
    trends: (["5h", "7d"] as const).map((span) => trend(accounts, span, nowAt, zone)),
    accounts: accounts.map(
      (account, k) =>
        new AccountDetail({
          id: AccountId.make(account.id),
          windows: account.windows.map((window) => {
            const resetsAt = now + window.resetsIn * minute
            const cost = Math.round(window.used * window.perPercent * 100) / 100
            return new WindowSpend({
              span: window.span,
              since: instant(resetsAt - spanMs[window.span]),
              resetsAt: instant(resetsAt),
              used: window.used,
              requests: Math.round(cost * 3.1),
              tokens: Math.round(cost * 41_000),
              cost,
              ...(window.used >= 2 ? { perPercent: window.perPercent } : {}),
            })
          }),
          health: Array.from({ length: cells }, (_, i) => {
            const mid = since + i * cell + cell / 2
            const answered = Math.round(activity(mid, zone) * (k === 0 ? 16 : 6) * noise(i + k * 97))
            return new HealthCell({ answered, failed: account.failures?.[i] ?? 0 })
          }),
        }),
    ),
    healthSince: instant(since),
    cellMinutes,
  })
}
