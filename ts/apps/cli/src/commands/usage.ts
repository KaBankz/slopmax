// `slopmax usage`: token totals and API-equivalent cost from the ledger,
// by day, model, or account.
import { Effect, Result, Schema } from "effect"

import {
  Account,
  type Config,
  Failure,
  fmt,
  Home,
  human,
  paths,
  type Store,
  summary,
  text,
  time,
  waste,
} from "@slopmax/core"

import * as ui from "../ui.ts"

const encodeLeft = Schema.encodeSync(waste.LeftSchema)

const s = (n: number): string => (n === 1 ? "" : "s")

// `{:>w}`: right-aligned in `w` characters.
const right = (cell: string, w: number): string => text.padStart(cell, w)

/**
 * Prints usage since the start of `range` (`today`, `7d`, `30d`, `all`),
 * grouped `by` day, model, or account.
 */
export const run: (
  config: Config,
  store: Store,
  range: string,
  by: string,
  json: boolean,
) => Effect.Effect<void, Failure> = Effect.fn("usage.run")(function* (
  config: Config,
  store: Store,
  range: string,
  by: string,
  json: boolean,
) {
  const since = summary.since(range, yield* time.Timestamp.now)
  if (since === undefined) {
    return yield* Effect.fail(
      new Failure({ message: `unknown range ${text.debug(range)}; use today, 7d, 30d, or all` }),
    )
  }
  const listed = yield* Effect.result(store.list())
  const names = new Map<string, string>(
    (Result.isSuccess(listed) ? listed.success : []).map((a) => [a.id, Account.name(a)] as const),
  )
  const r = yield* summary.build(yield* paths.usageDir, since, by, config.prices, names)
  const lapsed = yield* waste.read((yield* Home.current).windows(), since)
  const left = waste.left(lapsed, config.planPrices, names)

  if (json) {
    yield* ui.println(summary.Summary.json(r, 2, [["left_on_the_table", encodeLeft(left)]]))
    return
  }
  const title = range === "today" ? "today" : range === "all" ? "all time" : `the last ${range.replace(/d+$/, "")} days`
  const total = r.total
  if (total.requests === 0 && total.failed === 0) {
    yield* ui.println(`No requests recorded for ${title}.`)
    return
  }
  const width = Math.max(5, ...[...r.rows.keys()].map(ui.visibleWidth))
  yield* ui.println(
    `\n${ui.bold(ui.pad(by.toUpperCase(), width))}  ${right(ui.dim("REQ"), 6)}  ${right(ui.dim("INPUT"), 8)}  ` +
      `${right(ui.dim("OUTPUT"), 8)}  ${right(ui.dim("CACHE READ"), 10)}  ${right(ui.dim("CACHE WRITE"), 11)}  ` +
      `${right(ui.dim("API COST"), 9)}`,
  )
  const line = (label: string, t: summary.Totals): string =>
    `${ui.pad(label, width)}  ${right(String(t.requests), 6)}  ${right(human.compact(t.input), 8)}  ` +
    `${right(human.compact(t.output), 8)}  ${right(human.compact(t.cacheRead), 10)}  ` +
    `${right(human.compact(t.cacheWrite), 11)}  ${right(summary.Totals.costLabel(t), 9)}`
  for (const [label, totals] of r.rows) yield* ui.println(line(label, totals))
  yield* ui.println(ui.bold(line("total", total)))
  let note =
    `Usage for ${title}. API cost is what these requests would cost at API list ` +
    "prices (Anthropic's as of 2026-09, and any set in config.toml)."
  if (total.unpriced > 0) {
    const n = total.unpriced
    note +=
      `\n+ leaves out ${n} request${s(n)} to models without a price; set one under ` +
      `[prices] in ${yield* paths.configFile}.`
  }
  if (total.failed > 0) {
    const n = total.failed
    note +=
      `\n${n} request${s(n)} failed (the provider answered with an error, or no account ` +
      `could take it) and ${n === 1 ? "is" : "are"} left out.`
  }
  yield* ui.println(`\n${ui.dim(note)}`)
  yield* printLeft(left)
})

/**
 * What the weeks that reset left unused, and what that part of the plans
 * cost.
 */
const printLeft = (left: waste.Left): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (left.windows === 0) return
    const windows = `${left.windows} weekly window${s(left.windows)}`
    yield* ui.println(
      `\n${ui.bold("Left on the table:")} ${ui.bold(`$${fmt.fixed(left.dollars, 2)}`)}, ` +
        `${fmt.fixed(left.unused, 0)}% unused on average, across ${windows}`,
    )
    for (const account of left.accounts.filter((a) => a.unused >= 0.5)) {
      yield* ui.println(
        `  ${ui.pad(account.name, 28)}  ${right(`$${fmt.fixed(account.dollars, 2)}`, 7)}  ` +
          ui.dim(`${fmt.fixed(account.unused, 0)}% unused over ${account.windows}`),
      )
    }
    let note =
      "What each plan costs for the part of its weekly quota a reset threw away. " +
      "`slopmax status` shows what is left this week."
    if (left.unpriced > 0) note += " Plans without a known price are left out; set them under [plan_prices]."
    yield* ui.println(ui.dim(note))
  })
