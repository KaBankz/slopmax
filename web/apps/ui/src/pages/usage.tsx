// What went through slopmax over a range: the Usage page (tokens, requests,
// value, models, agents, when you work, accounts, quota left on the table)
// and the Performance page (reliability, cache, speed, first byte).
import { useAtomValue } from "@effect/atom-react"
import type { History, HistoryRange } from "@slopmax/client"
import { compact, grouped, providerTitle } from "@slopmax/client/format"
import { ChartColumn } from "lucide-react"
import type { ReactNode } from "react"
import { historyAtom, rangeAtom } from "../atoms.ts"
import { Columns, Heatmap, type Ink, Legend, Lines, SplitBar, Swatch } from "../components/charts.tsx"
import { Empty, Loaded, Meter, Panel, Section, Skeleton, Stats } from "../components/parts.tsx"
import {
  cacheAxis,
  cacheTip,
  costTip,
  countTick,
  firstByteTip,
  labelEvery,
  moneyTick,
  percentTick,
  reliabilityTip,
  requestsTip,
  secondsTick,
  tokensTick,
  tokensTip,
  zeroAxis,
} from "../view/charts.ts"
import {
  accountRows,
  agentRows,
  type BarRow,
  isQuiet,
  modelRows,
  perRequest,
  performanceStats,
  speedRows,
  tokenMix,
  usageStats,
} from "../view/usage.ts"
import { dollars, leftLine } from "../view/words.ts"

const providerInks: ReadonlyArray<Ink> = ["series-1", "series-2", "series-3", "series-4"]

/** A chart's panel: its title and legend over the plot. */
function ChartPanel({
  title,
  legend,
  children,
}: {
  readonly title: string
  readonly legend?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <Panel>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{title}</h3>
          {legend}
        </div>
        {children}
      </div>
    </Panel>
  )
}

/** Two panels side by side, one over the other where there is no room. */
function Pair({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">{children}</div>
}

/** The history for the chosen range, with its empty and loading states. */
function WithHistory({ children }: { readonly children: (history: History, range: HistoryRange) => ReactNode }) {
  const range = useAtomValue(rangeAtom)
  const history = useAtomValue(historyAtom(range))
  return (
    <Loaded
      result={history}
      title="Could not read the ledger"
      loading={
        <div className="flex flex-col gap-4" aria-label="Reading the ledger…">
          <Skeleton lines={2} />
          <Skeleton lines={6} />
        </div>
      }
    >
      {(found) =>
        // A history for another range is not shown while this one is read.
        found.range !== range ? (
          <Skeleton lines={6} />
        ) : isQuiet(found) ? (
          <Empty
            icon={ChartColumn}
            title={range === "today" ? "Nothing yet today" : "Nothing in this range"}
            detail="Requests show here once an agent sends them through slopmax."
          />
        ) : (
          children(found, range)
        )
      }
    </Loaded>
  )
}

function Bars({
  rows,
  mono = false,
  requests = false,
}: {
  readonly rows: ReadonlyArray<BarRow>
  readonly mono?: boolean
  readonly requests?: boolean
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-3 text-small">
          <span className={mono ? "w-40 shrink-0 truncate font-mono text-caption" : "w-28 shrink-0 truncate"}>
            {row.name}
          </span>
          <span className="min-w-0 flex-1">
            <Meter fraction={row.fraction} tone="muted" />
          </span>
          <span className="w-14 shrink-0 text-right tabular">{row.tokens}</span>
          {requests && <span className="w-28 shrink-0 text-right text-muted-foreground tabular">{row.requests}</span>}
          <span className="w-16 shrink-0 text-right text-muted-foreground tabular">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

function TokenMix({ history }: { readonly history: History }) {
  const mix = tokenMix(history.total)
  const per = perRequest(history.total)
  return (
    <div className="flex flex-col gap-3.5">
      <SplitBar
        parts={mix.map((part) => ({
          share: part.share,
          ink: providerInks[part.series - 1] ?? "meter",
          title: part.title,
        }))}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-small">
        {mix.map((part) => (
          <span key={part.title} className="flex items-center gap-2">
            <Swatch ink={providerInks[part.series - 1] ?? "meter"} />
            <span className="flex-1 text-muted-foreground">{part.title}</span>
            <span className="tabular">{compact(part.tokens)}</span>
          </span>
        ))}
      </div>
      <div className="h-px bg-separator" />
      <div className="grid grid-cols-2 gap-x-4 text-small">
        <span className="flex justify-between gap-2">
          <span className="text-muted-foreground">Context per request</span>
          <span className="tabular">{per.context}</span>
        </span>
        <span className="flex justify-between gap-2">
          <span className="text-muted-foreground">Output per request</span>
          <span className="tabular">{per.output}</span>
        </span>
      </div>
    </div>
  )
}

function AccountsTable({ history }: { readonly history: History }) {
  const { rows, unplaced, total } = accountRows(history)
  const head = "w-16 shrink-0 text-right"
  return (
    <Panel>
      <div className="flex items-center gap-3 border-b border-separator px-4 py-2 text-small text-muted-foreground">
        <span className="w-65 shrink-0">Account</span>
        <span className="min-w-0 flex-1">Share of tokens</span>
        <span className={head}>Tokens</span>
        <span className="w-18 shrink-0 text-right">Requests</span>
        <span className="w-14 shrink-0 text-right">Failed</span>
        <span className="w-20 shrink-0 text-right">API value</span>
      </div>
      {rows.map((row) => (
        <div
          key={`${row.provider}-${row.name}`}
          className="flex items-center gap-3 border-t border-separator px-4 py-2.5 text-small first:border-t-0"
        >
          <span className="flex w-65 shrink-0 items-baseline gap-2 truncate">
            <span className="truncate">{row.name}</span>
            <span className="text-caption text-muted-foreground">{row.provider}</span>
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1">
              <Meter fraction={row.fraction} tone="muted" />
            </span>
            <span className="w-10 shrink-0 text-right text-muted-foreground tabular">{row.share}</span>
          </span>
          <span className={`${head} tabular`}>{row.tokens}</span>
          <span className="w-18 shrink-0 text-right tabular">{row.requests}</span>
          <span className="w-14 shrink-0 text-right text-muted-foreground tabular">{row.failed}</span>
          <span className="w-20 shrink-0 text-right tabular">{row.value}</span>
        </div>
      ))}
      {unplaced > 0 && (
        <div className="flex items-center gap-3 border-t border-separator px-4 py-2.5 text-small text-muted-foreground">
          <span className="flex w-65 shrink-0 flex-col">
            <span>No account could take it</span>
            <span className="text-caption text-faint">Every account was limited or out of rotation</span>
          </span>
          <span className="min-w-0 flex-1" />
          <span className={head} />
          <span className="w-18 shrink-0" />
          <span className="w-14 shrink-0 text-right tabular">{grouped(unplaced)}</span>
          <span className="w-20 shrink-0" />
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-separator px-4 py-2.5 text-small font-medium">
        <span className="w-65 shrink-0">Total</span>
        <span className="min-w-0 flex-1" />
        <span className={`${head} tabular`}>{total.tokens}</span>
        <span className="w-18 shrink-0 text-right tabular">{total.requests}</span>
        <span className="w-14 shrink-0 text-right tabular">{total.failed}</span>
        <span className="w-20 shrink-0 text-right tabular">{total.value}</span>
      </div>
    </Panel>
  )
}

function LeftOnTheTable({ history }: { readonly history: History }) {
  const left = history.left
  if (left.windows === 0) {
    return (
      <Panel>
        <div className="px-4 py-3.5 text-small text-muted-foreground">No weekly window reset in this range</div>
      </Panel>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Panel>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3.5 pb-3">
          <span className="text-figure font-semibold tabular">{dollars(left.dollars)}</span>
          <span className="text-small text-muted-foreground">{leftLine(left.windows, left.unused)}</span>
          <span className="flex-1" />
          {left.unpriced > 0 && (
            <span className="text-caption text-faint">
              {left.unpriced === 1 ? "1 weekly window" : `${left.unpriced} weekly windows`} on plans without a known
              price left out
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 border-y border-separator px-4 py-2 text-small text-muted-foreground">
          <span className="min-w-0 flex-1">Account</span>
          <span className="w-30 shrink-0">Unused at reset</span>
          <span className="w-28 shrink-0 text-right">Weekly windows</span>
          <span className="w-16 shrink-0 text-right">Unused</span>
          <span className="w-18 shrink-0 text-right">Left</span>
        </div>
        {left.accounts.map((account) => (
          <div
            key={`${account.provider}-${account.name}`}
            className="flex items-center gap-3 border-t border-separator px-4 py-2.5 text-small first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate">{account.name}</span>
              <span className="text-caption text-muted-foreground">{providerTitle(account.provider)}</span>
            </span>
            <span className="w-30 shrink-0">
              <Meter fraction={account.unused / 100} tone="muted" />
            </span>
            <span className="w-28 shrink-0 text-right tabular">{account.windows}</span>
            <span className="w-16 shrink-0 text-right text-muted-foreground tabular">
              {percentTick(account.unused)}
            </span>
            <span className="w-18 shrink-0 text-right tabular">{dollars(account.dollars)}</span>
          </div>
        ))}
      </Panel>
      <p className="text-caption text-faint">
        The share of each plan's weekly fee that resets threw away, at plan list prices or planPrices in config.json.
      </p>
    </div>
  )
}

function UsageBody({ history, range }: { readonly history: History; readonly range: HistoryRange }) {
  const every = labelEvery(range)
  const tokensMost = Math.max(0, ...history.buckets.map((b) => b.tokens.reduce((s, n) => s + n, 0)))
  const requestsMost = Math.max(0, ...history.buckets.map((b) => b.requests + b.failed))
  const costMost = Math.max(0, ...history.buckets.map((b) => b.cost))
  return (
    <>
      <Stats stats={usageStats(history)} />
      <ChartPanel
        title="Tokens"
        legend={
          <Legend
            items={history.providers.map((provider, i) => ({
              ink: providerInks[i] ?? "meter",
              title: providerTitle(provider),
            }))}
          />
        }
      >
        <Columns
          size="lg"
          every={every}
          scale={zeroAxis(tokensMost, 1)}
          tick={tokensTick}
          buckets={history.buckets.map((bucket) => ({
            label: bucket.label,
            tip: tokensTip(history, bucket),
            parts: bucket.tokens.map((value, i) => ({ value, ink: providerInks[i] ?? "meter" })),
          }))}
        />
      </ChartPanel>
      <Pair>
        <ChartPanel
          title="Requests"
          legend={
            <Legend
              items={[
                { ink: "meter", title: "Answered" },
                { ink: "bad", title: "Failed" },
              ]}
            />
          }
        >
          <Columns
            size="sm"
            every={every}
            scale={zeroAxis(requestsMost, 1)}
            tick={countTick}
            buckets={history.buckets.map((bucket) => ({
              label: bucket.label,
              tip: requestsTip(bucket),
              parts: [
                { value: bucket.requests, ink: "meter" },
                { value: bucket.failed, ink: "bad" },
              ],
            }))}
          />
        </ChartPanel>
        <ChartPanel title="API value">
          <Columns
            size="sm"
            every={every}
            scale={zeroAxis(costMost, 0.01)}
            tick={moneyTick}
            buckets={history.buckets.map((bucket) => ({
              label: bucket.label,
              tip: costTip(bucket),
              parts: [{ value: bucket.cost, ink: "meter" }],
            }))}
          />
        </ChartPanel>
      </Pair>
      <Pair>
        <ChartPanel title="Models">
          <Bars rows={modelRows(history)} mono />
        </ChartPanel>
        <ChartPanel title="Token mix">
          <TokenMix history={history} />
        </ChartPanel>
      </Pair>
      <ChartPanel title="Agents">
        <Bars rows={agentRows(history)} requests />
      </ChartPanel>
      {range !== "today" && (
        <ChartPanel title="When you work">
          <Heatmap activity={history.activity} />
        </ChartPanel>
      )}
      <Section title="Accounts">
        <AccountsTable history={history} />
      </Section>
      <Section title="Left on the table">
        <LeftOnTheTable history={history} />
      </Section>
    </>
  )
}

export function UsagePage() {
  return <WithHistory>{(history, range) => <UsageBody history={history} range={range} />}</WithHistory>
}

function PerformanceBody({ history, range }: { readonly history: History; readonly range: HistoryRange }) {
  const every = labelEvery(range)
  const labels = history.buckets.map((b) => b.label)
  const cached = history.buckets.map((b) => (b.cached === undefined ? undefined : b.cached * 100))
  const slowest = Math.max(0, ...history.buckets.map((b) => (b.firstByte?.[1] ?? 0) / 1000))
  const byteAxis = zeroAxis(slowest, 0.1)
  const step = (byteAxis.top - byteAxis.bottom) / (byteAxis.ticks - 1)
  const speeds = speedRows(history)
  const reliabilityMost = Math.max(0, ...history.buckets.map((b) => Math.max(b.rescued, b.failed)))
  return (
    <>
      <Stats stats={performanceStats(history)} />
      <Pair>
        <ChartPanel
          title="Reliability"
          legend={
            <Legend
              items={[
                { ink: "meter", title: "Saved by failover" },
                { ink: "bad", title: "Failed" },
              ]}
            />
          }
        >
          <Columns
            size="sm"
            grouped
            every={every}
            scale={zeroAxis(reliabilityMost, 1)}
            tick={countTick}
            buckets={history.buckets.map((bucket) => ({
              label: bucket.label,
              tip: reliabilityTip(bucket),
              parts: [
                { value: bucket.rescued, ink: "meter" },
                { value: bucket.failed, ink: "bad" },
              ],
            }))}
          />
        </ChartPanel>
        <ChartPanel title="Input from cache">
          <Lines
            labels={labels}
            every={every}
            scale={cacheAxis(cached.flatMap((v) => (v === undefined ? [] : [v])))}
            tick={percentTick}
            tips={history.buckets.map(cacheTip)}
            series={[{ ink: "meter", values: cached }]}
          />
        </ChartPanel>
      </Pair>
      <Pair>
        <ChartPanel title="Output speed">
          {speeds.length === 0 ? (
            <span className="text-small text-muted-foreground">No answers long enough to time yet.</span>
          ) : (
            <div className="flex flex-col gap-2.5">
              {speeds.map((row) => (
                <div key={row.model} className="flex items-center gap-3 text-small">
                  <span className="min-w-0 flex-1 truncate font-mono text-caption">{row.model}</span>
                  <span className="w-20 shrink-0 text-muted-foreground">{row.provider}</span>
                  <span className="w-20 shrink-0 text-right tabular">{row.speed}</span>
                </div>
              ))}
            </div>
          )}
        </ChartPanel>
        <ChartPanel
          title="Time to first byte"
          legend={
            <Legend
              items={[
                { ink: "meter", title: "Median" },
                { ink: "series-3", title: "Slowest 5%" },
              ]}
            />
          }
        >
          <Lines
            labels={labels}
            every={every}
            scale={byteAxis}
            tick={secondsTick(step)}
            tips={history.buckets.map(firstByteTip)}
            series={[
              {
                ink: "series-3",
                values: history.buckets.map((b) => (b.firstByte === undefined ? undefined : b.firstByte[1] / 1000)),
              },
              {
                ink: "meter",
                values: history.buckets.map((b) => (b.firstByte === undefined ? undefined : b.firstByte[0] / 1000)),
              },
            ]}
          />
        </ChartPanel>
      </Pair>
    </>
  )
}

export function PerformancePage() {
  return <WithHistory>{(history, range) => <PerformanceBody history={history} range={range} />}</WithHistory>
}
