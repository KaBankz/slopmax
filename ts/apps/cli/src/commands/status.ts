// `slopmax status`: the accounts, their usage windows, and when limits
// reset, from the running proxy or from disk.
import { Effect, Schema } from "effect"

import {
  background,
  type Config,
  type Failure,
  fmt,
  human,
  limits,
  ProviderId,
  provider,
  report,
  type Store,
  text,
  time,
} from "@slopmax/core"

import * as ui from "../ui.ts"
import { anyhow } from "./background.ts"

type Report = report.Report
type AccountReport = report.AccountReport
type PoolReport = report.PoolReport
type Window = limits.Window
type Timestamp = time.Timestamp

export interface StatusArgs {
  readonly refresh: boolean
  readonly watch: boolean
  readonly json: boolean
}

const encodeReport = Schema.encodeSync(report.ReportSchema)

/** `serde_json::to_string_pretty` of the report. */
export const json = (r: Report): string => JSON.stringify(encodeReport(r), null, 2)

export const run: (config: Config, store: Store, args: StatusArgs) => Effect.Effect<void, Failure> = Effect.fn(
  "status.run",
)(function* (config: Config, store: Store, args: StatusArgs) {
  const daemon = yield* background.Daemon.make(config)
  let refresh = args.refresh
  for (;;) {
    const r =
      (yield* daemon.report(refresh)) ?? (yield* report.offline(config, store, refresh).pipe(Effect.mapError(anyhow)))
    if (args.json) {
      yield* ui.println(json(r))
      return
    }
    const shown = render(r, yield* time.Timestamp.now)
    if (!args.watch) {
      yield* ui.print(shown)
      return
    }
    yield* ui.print(`\x1b[2J\x1b[H${shown}`)
    refresh = false
    yield* Effect.sleep("5 seconds")
  }
})

const BAR = 10
const PLAN = 9
/** Width of a usage cell: bar, percentage, and reset countdown. */
const CELL = BAR + 12

const index = (n: number): string => ui.dim(String(n).padStart(2))

/** Renders the report as a table grouped by provider. */
export const render = (r: Report, now: Timestamp): string => {
  if (r.accounts.length === 0) {
    return (
      "No accounts yet. Connect one with `slopmax login claude` or `slopmax login codex`,\n" +
      "or bring existing logins over with `slopmax import`.\n"
    )
  }
  let out = ""
  const nameWidth = Math.min(36, Math.max(7, ...r.accounts.map((a) => ui.visibleWidth(a.name))))
  let n = 0
  for (const id of ProviderId.ALL) {
    const accounts = r.accounts.filter((a) => a.provider === id)
    if (accounts.length === 0) continue
    if (!provider.Spec.isSubscription(ProviderId.spec(id))) {
      const [rows, last] = metered(id, accounts, n, nameWidth, now)
      out += rows
      n = last
      continue
    }
    out +=
      `\n${ui.bold(ui.pad(id.toUpperCase(), nameWidth + 4))}  ${ui.dim(ui.pad("PLAN", PLAN))}  ` +
      `${ui.dim(ui.pad("5H", CELL))}  ${ui.dim(ui.pad("WEEK", CELL))}  ${ui.dim("STATUS")}\n`
    for (const account of accounts) {
      n += 1
      const name = text.take(account.name, nameWidth)
      out +=
        `${index(n)} ${ui.pad(name, nameWidth + 1)}  ${ui.pad(account.plan ?? "—", PLAN)}  ` +
        `${windowCell(report.AccountReport.window(account, "5h"), now)}  ` +
        `${windowCell(report.AccountReport.longWindow(account), now)}  ${statusCell(account, now)}\n`
      out += scopedRows(report.AccountReport.scopedWindows(account), nameWidth, now)
    }
    const pool = r.pools.find((p) => p.provider === id)
    out += poolRow(pool, nameWidth, now)
    const next = pool?.next
    if (next !== undefined) {
      const name = accounts.find((a) => a.id === next.account)?.name ?? next.account
      out += `   ${ui.dim(`next session → ${name}, ${next.why}`)}\n`
    }
  }
  if (r.nudges.length > 0) {
    out += "\n"
    for (const nudge of r.nudges) out += `${ui.yellow("•")} ${nudge.message}\n`
  }
  const where = r.live ? "proxy running" : "proxy not running (last known state)"
  out += `\n${ui.dim(`strategy ${r.strategy} · ${where}`)}\n`
  return out
}

/**
 * Rows for pay-per-token accounts, which have models instead of windows.
 * Returns them and the last row number used.
 */
const metered = (
  id: ProviderId,
  accounts: ReadonlyArray<AccountReport>,
  start: number,
  nameWidth: number,
  now: Timestamp,
): readonly [string, number] => {
  const width = CELL * 2 + 2
  let n = start
  let out =
    `\n${ui.bold(ui.pad(id.toUpperCase(), nameWidth + 4))}  ${ui.dim(ui.pad("BILLING", PLAN))}  ` +
    `${ui.dim(ui.pad("MODELS", width))}  ${ui.dim("STATUS")}\n`
  for (const account of accounts) {
    n += 1
    const name = text.take(account.name, nameWidth)
    let models = account.models.join(", ")
    if (text.width(models) > width) models = `${text.take(models, width - 1)}…`
    out +=
      `${index(n)} ${ui.pad(name, nameWidth + 1)}  ${ui.pad("per token", PLAN)}  ` +
      `${ui.pad(models, width)}  ${statusCell(account, now)}\n`
  }
  return [out, n]
}

/** Windows that cover one model, each under its column. */
const scopedRows = (windows: ReadonlyArray<Window>, nameWidth: number, now: Timestamp): string => {
  let out = ""
  for (const scoped of windows) {
    // Under the matching column: the row prefix is the index and name,
    // then the plan, then each usage cell.
    const fiveHourColumn = nameWidth + 4 + 2 + PLAN + 2
    const column = scoped.span === "5h" ? fiveHourColumn : fiveHourColumn + CELL + 2
    const label = `└ ${limits.Window.label(scoped)}`
    out += `   ${ui.dim(ui.pad(label, column - 3))}${windowCell(scoped, now)}\n`
  }
  return out
}

/** The pool as the agents see it, when it has more than one account. */
const poolRow = (pool: PoolReport | undefined, nameWidth: number, now: Timestamp): string => {
  if (pool === undefined || pool.accounts <= 1) return ""
  return (
    `   ${ui.pad(ui.bold("pool"), nameWidth + 1)}  ${ui.pad(ui.dim(`${pool.accounts} accts`), PLAN)}  ` +
    `${windowCell(report.PoolReport.window(pool, "5h"), now)}  ` +
    `${windowCell(report.PoolReport.longWindow(pool), now)}  ${ui.dim("what the agents see")}\n` +
    scopedRows(report.PoolReport.scopedWindows(pool), nameWidth, now)
  )
}

const windowCell = (window: Window | undefined, now: Timestamp): string => {
  if (window === undefined) return ui.pad(ui.dim("—"), CELL)
  const used = limits.Window.usedAt(window, now)
  const upcoming = used > 0 ? limits.Window.upcomingReset(window, now) : undefined
  const reset = upcoming === undefined ? "" : human.until(upcoming, now)
  const percent = `${fmt.fixed(used, 0).padStart(3)}%`
  const cell = `${ui.bar(used, BAR)} ${ui.byLevel(used, percent)} ${ui.dim(reset)}`
  return ui.pad(cell, CELL)
}

const statusCell = (account: AccountReport, now: Timestamp): string => {
  const condition = report.AccountReport.condition(account, now)
  const parts = [
    ui.toned(report.Condition.tone(condition), report.Condition.describe(condition, now)),
    ...report.AccountReport.notes(account, now).map((note) =>
      ui.toned(report.Note.tone(note), report.Note.describe(note)),
    ),
  ]
  return parts.join(ui.dim(" · "))
}
