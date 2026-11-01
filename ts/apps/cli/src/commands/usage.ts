// `slopmax usage`: the ledger's tokens over a period, by day, model or
// account, with what they would have cost at API prices, and the weekly
// quota that resets threw away unused.
import {
  Accounts,
  costLabel,
  currentZone,
  Home,
  Ledger,
  left,
  pricingOf,
  rangeStart,
  SettingsService,
  summary,
  windowsEnded,
} from "@slopmax/core"
import { LeftOnTheTable, Summary, type SummaryBy, type SummaryRange, type Totals } from "@slopmax/domain"
import { compact, fixed, money, percent } from "@slopmax/domain/format"
import { DateTime, Effect, Schema } from "effect"
import { padEnd, padStart, type Paint, plural, Print } from "../print.ts"

export interface UsageInput {
  readonly range: SummaryRange
  readonly by: SummaryBy
  readonly json: boolean
}

/** The period as a sentence names it. */
export const rangeTitle = (range: SummaryRange): string =>
  range === "today" ? "today" : range === "all" ? "all time" : `the last ${range === "7d" ? 7 : 30} days`

const columns = [
  ["REQ", 6],
  ["INPUT", 8],
  ["OUTPUT", 8],
  ["CACHE READ", 10],
  ["CACHE WRITE", 11],
  ["API COST", 9],
] as const

const cells = (totals: Totals): ReadonlyArray<string> => [
  String(totals.requests),
  compact(totals.input),
  compact(totals.output),
  compact(totals.cacheRead),
  compact(totals.cacheWrite),
  costLabel(totals),
]

const row = (key: string, values: ReadonlyArray<string>, width: number): string =>
  [padEnd(key, width), ...values.map((value, index) => padStart(value, columns[index]?.[1] ?? 0))].join("  ")

/** What `slopmax usage` prints for a summary and what resets threw away. */
export const renderUsage = (
  view: Summary,
  wasted: LeftOnTheTable,
  configPath: string,
  paint: Paint,
): ReadonlyArray<string> => {
  const { bold, dim } = paint
  const title = rangeTitle(view.range)
  const lines: Array<string> = []
  if (view.total.requests === 0 && view.total.failed === 0) {
    lines.push(`No requests recorded for ${title}.`)
  } else {
    const width = Math.max(5, view.by.length, ...view.rows.map((r) => [...r.key].length))
    lines.push("")
    lines.push(
      [bold(padEnd(view.by.toUpperCase(), width)), ...columns.map(([name, w]) => dim(padStart(name, w)))].join("  "),
    )
    for (const entry of view.rows) lines.push(row(entry.key, cells(entry.totals), width))
    lines.push(bold(row("total", cells(view.total), width)))
    lines.push("")
    const notes = [
      `Usage for ${title}. API cost is what these requests would cost at API list prices (and any set under prices in config.json).`,
    ]
    if (view.total.unpriced > 0) {
      notes.push(
        `+ leaves out ${plural(view.total.unpriced, "request")} to models without a price; set one under prices in ${configPath}.`,
      )
    }
    if (view.total.failed > 0) {
      notes.push(
        `${plural(view.total.failed, "request")} failed (the provider answered with an error, or no account could take it) and ${view.total.failed === 1 ? "is" : "are"} left out.`,
      )
    }
    lines.push(dim(notes.join("\n")))
  }
  if (wasted.windows > 0) {
    lines.push("")
    lines.push(
      `${bold("Left on the table:")} ${bold(money(wasted.dollars))}, ${percent(wasted.unused)} unused on average, across ${plural(wasted.windows, "weekly window")}`,
    )
    for (const account of wasted.accounts) {
      if (account.unused < 0.5) continue
      lines.push(
        `  ${padEnd(account.name, 28)}  ${padStart(money(account.dollars), 7)}  ${dim(`${fixed(account.unused, 0)}% unused over ${account.windows}`)}`,
      )
    }
    const unpriced = wasted.unpriced > 0 ? " Plans without a known price are left out; set them under planPrices." : ""
    lines.push(
      dim(
        `What each plan costs for the part of its weekly quota a reset threw away. \`slopmax status\` shows what is left this week.${unpriced}`,
      ),
    )
  }
  return lines
}

export const usage = Effect.fn("cli.usage")(function* (input: UsageInput) {
  const print = yield* Print
  const ledger = yield* Ledger
  const settings = yield* SettingsService
  const accounts = yield* Accounts
  const now = yield* DateTime.now
  const zone = yield* currentZone
  const ctx = {
    names: new Map((yield* accounts.list).map((account) => [account.id, account.name] as const)),
    pricing: pricingOf(yield* settings.get),
    now,
    zone,
  }
  const since = rangeStart(input.range, now, zone)
  const records = yield* ledger.load(since)
  const view = summary(records, input.range, input.by, ctx)
  const wasted = left(windowsEnded(records, since), ctx)
  if (input.json) {
    const body = {
      ...(yield* Schema.encodeEffect(Summary)(view)),
      leftOnTheTable: yield* Schema.encodeEffect(LeftOnTheTable)(wasted),
    }
    yield* print.out(JSON.stringify(body, null, 2))
    return
  }
  const home = yield* Home
  for (const line of renderUsage(view, wasted, home.paths.config, print.paint)) yield* print.out(line)
})
