// `slopmax status`: every account, its usage windows and when they reset,
// one table per provider, with a row for each subscription's pool. The
// report comes from the running proxy, which knows its live sessions, or is
// built from the files when none runs.
import { Lock, offlineReport } from "@slopmax/core"
import {
  type AccountView,
  conditionTone,
  isSubscription,
  longWindow,
  noteTone,
  type PoolView,
  providerOrder,
  Report,
  toneOfUse,
  type Window,
  windowLabel,
  windowOf,
} from "@slopmax/domain"
import { conditionText, noteText, percent, until } from "@slopmax/domain/format"
import { DateTime, Effect, Option, Ref, Schema, Stream } from "effect"
import { CliFailure } from "../failure.ts"
import { bar, cut, ellipsis, padEnd, padStart, type Paint, Print } from "../print.ts"
import { apiFailure, runningClient } from "../reach.ts"

/** The widths of the table's columns. */
const barWidth = 10
const planWidth = 9
const cellWidth = barWidth + 12
const modelsWidth = 46

/** The name column: as wide as the widest name, within reason. */
export const nameWidth = (accounts: ReadonlyArray<AccountView>): number =>
  Math.min(36, Math.max(7, ...accounts.map((account) => [...account.name].length)))

/** A window's use as a cell: a bar, the percent in its tone, and the time to its reset. */
export const windowCell = (
  window: { readonly used: number; readonly resetsAt?: DateTime.Utc | undefined } | undefined,
  now: DateTime.Utc,
  paint: Paint,
): string => {
  if (window === undefined) return padEnd(paint.dim("—"), cellWidth)
  const resets = window.resetsAt
  const used = resets !== undefined && DateTime.isLessThanOrEqualTo(resets, now) ? 0 : window.used
  const tone = toneOfUse(used)
  const shown = paint.tone(tone, padStart(percent(used), 4))
  const ahead = resets !== undefined && DateTime.isGreaterThan(resets, now)
  const countdown = used > 0 && ahead ? ` ${paint.dim(until(resets, now))}` : ""
  return padEnd(`${bar(used, barWidth, tone, paint)}${shown}${countdown}`, cellWidth)
}

/** Where an account stands: its condition and its notes, each in its tone. */
export const statusCell = (account: AccountView, now: DateTime.Utc, paint: Paint): string =>
  [
    paint.tone(conditionTone(account.condition), conditionText(account.condition, now)),
    ...account.notes.map((note) => paint.tone(noteTone(note), noteText(note))),
  ].join(paint.dim(" · "))

/** Rows for the windows that cover one model, under the column of their length. */
const scopedRows = (windows: ReadonlyArray<Window>, width: number, now: DateTime.Utc, paint: Paint) =>
  windows.map((window) => {
    const column = width + 4 + 2 + planWidth + 2 + (window.span === "5h" ? 0 : cellWidth + 2)
    return `   ${padEnd(paint.dim(`└ ${windowLabel(window)}`), column - 3)}${windowCell(window, now, paint)}`
  })

const subscriptionRows = (
  accounts: ReadonlyArray<readonly [number, AccountView]>,
  pool: PoolView | undefined,
  width: number,
  now: DateTime.Utc,
  paint: Paint,
): ReadonlyArray<string> => {
  const { bold, dim } = paint
  const rows: Array<string> = []
  for (const [index, account] of accounts) {
    const shared = account.windows.filter((window) => window.model === undefined)
    rows.push(
      [
        `${dim(padStart(String(index), 2))} ${padEnd(cut(account.name, width), width + 1)}`,
        padEnd(account.plan ?? "—", planWidth),
        windowCell(windowOf(shared, "5h"), now, paint),
        windowCell(longWindow(shared), now, paint),
        statusCell(account, now, paint),
      ].join("  "),
    )
    rows.push(
      ...scopedRows(
        account.windows.filter((window) => window.model !== undefined),
        width,
        now,
        paint,
      ),
    )
  }
  if (pool !== undefined && pool.accounts > 1) {
    rows.push(
      [
        `   ${padEnd(bold("pool"), width + 1)}`,
        padEnd(dim(`${pool.accounts} accts`), planWidth),
        windowCell(windowOf(pool.windows, "5h"), now, paint),
        windowCell(longWindow(pool.windows), now, paint),
        dim("what the agents see"),
      ].join("  "),
    )
    rows.push(...scopedRows(pool.scoped, width, now, paint))
  }
  const next = pool?.next
  if (next !== undefined) {
    const name = accounts.find(([, account]) => account.id === next.account)?.[1].name ?? next.account
    rows.push(`   ${dim(`next session → ${name}, ${next.why}`)}`)
  }
  return rows
}

const meteredRows = (
  accounts: ReadonlyArray<readonly [number, AccountView]>,
  width: number,
  now: DateTime.Utc,
  paint: Paint,
): ReadonlyArray<string> =>
  accounts.map(([index, account]) =>
    [
      `${paint.dim(padStart(String(index), 2))} ${padEnd(cut(account.name, width), width + 1)}`,
      padEnd("per token", planWidth),
      padEnd(ellipsis(account.models.join(", "), modelsWidth), modelsWidth),
      statusCell(account, now, paint),
    ].join("  "),
  )

/** What `slopmax status` prints for a report, line by line. */
export const renderReport = (report: Report, now: DateTime.Utc, paint: Paint): ReadonlyArray<string> => {
  const { bold, dim, yellow } = paint
  if (report.accounts.length === 0) {
    return [
      "No accounts yet. Connect one with `slopmax login claude` or `slopmax login codex`,",
      "or bring existing logins over with `slopmax import`.",
    ]
  }
  const width = nameWidth(report.accounts)
  const lines: Array<string> = []
  let index = 0
  for (const provider of providerOrder) {
    const accounts = report.accounts
      .filter((account) => account.provider === provider)
      .map((account) => {
        index += 1
        return [index, account] as const
      })
    if (accounts.length === 0) continue
    lines.push("")
    const title = bold(padEnd(provider.toUpperCase(), width + 4))
    if (isSubscription(provider)) {
      lines.push(
        [
          title,
          dim(padEnd("PLAN", planWidth)),
          dim(padEnd("5H", cellWidth)),
          dim(padEnd("WEEK", cellWidth)),
          dim("STATUS"),
        ].join("  "),
      )
      const pool = report.pools.find((view) => view.provider === provider)
      lines.push(...subscriptionRows(accounts, pool, width, now, paint))
    } else {
      lines.push(
        [title, dim(padEnd("BILLING", planWidth)), dim(padEnd("MODELS", modelsWidth)), dim("STATUS")].join("  "),
      )
      lines.push(...meteredRows(accounts, width, now, paint))
    }
  }
  if (report.nudges.length > 0) {
    lines.push("")
    for (const nudge of report.nudges) lines.push(`${yellow("•")} ${nudge.message}`)
  }
  lines.push("")
  lines.push(
    dim(`strategy ${report.strategy} · ${report.live ? "proxy running" : "proxy not running (last known state)"}`),
  )
  return lines
}

/** The report as `--json` prints it: the domain's shape, two-space indented. */
export const reportJson = (report: Report): string => JSON.stringify(Schema.encodeSync(Report)(report), null, 2)

/**
 * The report: the running proxy's (after fresh readings with `refresh`),
 * else built from the files, reading usage first with `refresh` unless a
 * proxy is starting and holds the home.
 */
export const currentReport = (refresh: boolean) =>
  Effect.gen(function* () {
    const client = yield* runningClient
    if (Option.isSome(client)) {
      return yield* (refresh ? client.value.system.refresh() : client.value.system.status()).pipe(
        Effect.mapError(apiFailure),
      )
    }
    if (!refresh) return yield* offlineReport({ refresh: false })
    const done = yield* (yield* Lock).tryWith("serve")(offlineReport({ refresh: true }))
    return Option.isSome(done) ? done.value : yield* offlineReport({ refresh: false })
  })

export interface StatusInput {
  readonly refresh: boolean
  readonly watch: boolean
  readonly json: boolean
}

/** Clears the terminal and puts the cursor at the top. */
const clearScreen = "\x1b[2J\x1b[H"

const draw = (report: Report) =>
  Effect.gen(function* () {
    const print = yield* Print
    const now = yield* DateTime.now
    for (const line of renderReport(report, now, print.paint)) yield* print.out(line)
  })

/** How often the display is drawn again while no proxy says when it changes. */
const offlinePeriod = "5 seconds"

export const status = Effect.fn("cli.status")(function* (input: StatusInput) {
  const print = yield* Print
  if (input.watch && input.json) return yield* new CliFailure({ message: "--json cannot be combined with --watch" })
  const first = yield* currentReport(input.refresh)
  if (input.json) {
    yield* print.out(reportJson(first))
    return
  }
  if (!input.watch) {
    yield* draw(first)
    return
  }
  const redraw = (report: Report) => Effect.andThen(print.out(clearScreen), draw(report))
  yield* redraw(first)
  // The last report a proxy sent, once one has: when that proxy stops, it
  // stays on screen marked as the last known state, which is fresher than
  // what this process read from the files when the watch began.
  const lastLive = yield* Ref.make(first.live ? Option.some(first) : Option.none<Report>())
  const drawStopped = Effect.flatMap(
    Ref.get(lastLive),
    Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (report) => Effect.as(redraw(new Report({ ...report, live: false })), true),
    }),
  )
  const tick = Effect.gen(function* () {
    const client = yield* runningClient
    if (Option.isSome(client)) {
      // A running proxy says when its report changes; nothing polls it.
      yield* client.value.events.watch().pipe(
        Effect.flatMap((events) =>
          events.pipe(
            Stream.filter((event) => event._tag === "Status"),
            Stream.tap((event) => Effect.andThen(Ref.set(lastLive, Option.some(event.report)), redraw(event.report))),
            Stream.runDrain,
          ),
        ),
        // A proxy that went away mid-stream ends the watch just as one that stopped cleanly.
        Effect.ignore,
      )
      yield* drawStopped
    }
    yield* Effect.sleep(offlinePeriod)
    if (Option.isNone(yield* runningClient) && (yield* drawStopped)) return
    yield* redraw(yield* currentReport(false))
  })
  // Watches until interrupted, following a proxy whenever one runs.
  return yield* Effect.forever(tick)
})
