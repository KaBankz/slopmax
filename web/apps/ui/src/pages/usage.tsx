// What went through slopmax over a range: the Usage page (tokens, requests,
// value, models, agents, machines, when you work, accounts, quota left on
// the table)
// and the Performance page (reliability, cache, speed, first byte).
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { History, HistoryRange } from "@slopmax/client"
import { compact, fixed, grouped, providerTitle } from "@slopmax/client/format"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { go, groupsAtom, historyAtom, machinesAtom, rangeAtom, requestFilterAtom, requestLimitAtom } from "../atoms.ts"
import {
  Columns,
  Heatmap,
  type Ink,
  Legend,
  Lines,
  RequestColumns,
  requestInks,
  Share,
  SplitBar,
  Swatch,
} from "../components/charts.tsx"
import { HealthCard, RecentFailures } from "../components/health.tsx"
import { Loaded, Section, Skeleton, StatChange, Stats } from "../components/parts.tsx"
import { providerInk, ProviderMark } from "../components/provider-mark.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Separator } from "../components/ui/separator.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableNumber,
  TableRow,
} from "../components/ui/table.tsx"
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
  secondsTick,
  tokensTick,
  tokensTip,
  zeroAxis,
} from "../view/charts.ts"
import { Pages } from "../view/pages.ts"
import { pageSize } from "../view/requests.ts"
import {
  accountRows,
  agentRows,
  type BarRow,
  isQuiet,
  leftAccountValue,
  machineRows,
  modelRows,
  perRequest,
  performanceStats,
  previousMetric,
  speedRows,
  type Stat,
  tokenMix,
  type UsageMetric,
  usageMetrics,
  usageStats,
} from "../view/usage.ts"
import { dollars, leftLine } from "../view/words.ts"

// Alternate shades so adjacent token segments stay distinguishable.
const mixInks: ReadonlyArray<Ink> = ["chart-1", "chart-4", "chart-3", "chart-2"]
const valueInk: Ink = "chart-1"

/** A chart's Card: its title and legend over the plot. */
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          {legend}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** Two panels side by side, one over the other where there is no room. */
function Pair({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">{children}</div>
}

/** The history for the chosen range, with its empty and loading states. */
function WithHistory({
  children,
  allowEmpty = false,
}: {
  readonly children: (history: History, range: HistoryRange) => ReactNode
  readonly allowEmpty?: boolean
}) {
  const range = useAtomValue(rangeAtom)
  const history = useAtomValue(historyAtom(range))
  const again = useAtomRefresh(historyAtom(range))
  return (
    <Loaded
      result={history}
      title="Could not read the ledger"
      onRetry={again}
      loading={
        <div className="flex flex-col gap-4" role="status" aria-label="Reading the ledger…">
          <Skeleton lines={2} />
          <Skeleton lines={6} />
        </div>
      }
    >
      {(found) =>
        // A history for another range is not shown while this one is read.
        found.range !== range ? (
          <Skeleton lines={6} />
        ) : isQuiet(found) && !allowEmpty ? (
          <Quiet title={range === "today" ? "Nothing yet today" : "Nothing in this range"} />
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
  const hasProviderMarks = rows.some((row) => row.provider !== undefined)
  return (
    <div className="@container flex flex-col gap-2.5">
      {rows.map((row) => (
        // In a narrow card the bar takes a line of its own under the figures, so they stay inside it.
        <div key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs @md:flex-nowrap">
          {hasProviderMarks &&
            (row.provider === undefined ? (
              <span aria-hidden className="size-4 shrink-0" />
            ) : (
              <ProviderMark provider={row.provider} />
            ))}
          <span
            className={
              mono ? "min-w-0 flex-1 @md:w-40 @md:flex-none" : "min-w-0 flex-1 truncate @md:w-28 @md:flex-none"
            }
          >
            {mono ? <span className="block truncate font-mono">{row.name}</span> : row.name}
            {mono && row.provider !== undefined && (
              <span className="block truncate text-muted-foreground">{providerTitle(row.provider)}</span>
            )}
          </span>
          <span className="order-last basis-full @md:order-none @md:min-w-0 @md:flex-1 @md:basis-auto">
            <Share fraction={row.fraction} ink={providerInk(row.provider)} />
          </span>
          <span className="w-14 shrink-0 text-right tabular-nums">{row.tokens}</span>
          {requests && (
            <span className="w-28 shrink-0 text-right text-muted-foreground tabular-nums">{row.requests}</span>
          )}
          <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">{row.value}</span>
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
          ink: mixInks[part.series - 1] ?? "meter",
          title: part.title,
        }))}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs @2xl:grid-cols-4">
        {mix.map((part) => (
          <span key={part.title} className="flex items-center gap-2">
            <Swatch ink={mixInks[part.series - 1] ?? "meter"} solid />
            <span className="flex-1 text-muted-foreground">{part.title}</span>
            <span className="text-right tabular-nums">
              {compact(part.tokens)}
              <span className="block text-muted-foreground">{fixed(part.share * 100, 1)}%</span>
            </span>
          </span>
        ))}
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-x-4 text-xs">
        <span className="flex justify-between gap-2">
          <span className="text-muted-foreground">Context per request</span>
          <span className="tabular-nums">{per.context}</span>
        </span>
        <span className="flex justify-between gap-2">
          <span className="text-muted-foreground">Output per request</span>
          <span className="tabular-nums">{per.output}</span>
        </span>
      </div>
    </div>
  )
}

function AccountsTable({ history }: { readonly history: History }) {
  const { rows, unplaced, total } = accountRows(history)
  return (
    <Card>
      <CardContent>
        <Table aria-label="Requests and token use by account">
          <TableHeader>
            <TableRow>
              <TableHead className="w-full @2xl:w-2/5">Account</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="hidden w-18 text-right @2xl:table-cell">Requests</TableHead>
              <TableHead className="hidden w-14 text-right @2xl:table-cell">Failed</TableHead>
              <TableHead className="text-right" aria-label="Value at API prices">
                API value
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.provider}-${row.name}`}>
                <TableCell>
                  <span className="block whitespace-normal wrap-anywhere">{row.name}</span>
                  <span className="block text-xs text-muted-foreground whitespace-normal">{row.provider}</span>
                  <span className="block text-xs text-muted-foreground whitespace-normal @2xl:hidden">
                    {row.requests} requests · {row.failed} failed
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex min-w-14 flex-col gap-1 text-right tabular-nums @2xl:w-40">
                    {row.tokens}
                    <Share fraction={row.fraction} ink={providerInk(row.providerId)} />
                    <span className="text-xs text-muted-foreground">{row.share}</span>
                  </span>
                </TableCell>
                <TableCell className="hidden @2xl:table-cell">
                  <TableNumber>{row.requests}</TableNumber>
                </TableCell>
                <TableCell className="hidden @2xl:table-cell">
                  <TableNumber muted>{row.failed}</TableNumber>
                </TableCell>
                <TableCell>
                  <TableNumber>{row.value}</TableNumber>
                </TableCell>
              </TableRow>
            ))}
            {unplaced > 0 && (
              <TableRow>
                <TableCell>
                  <span className="flex flex-col text-muted-foreground whitespace-normal">
                    <span>No account could take it</span>
                    <span className="text-xs">
                      {grouped(unplaced)} requests with every account limited or out of rotation
                    </span>
                  </span>
                </TableCell>
                <TableCell />
                <TableCell className="hidden @2xl:table-cell" />
                <TableCell className="hidden @2xl:table-cell">
                  <TableNumber muted>{grouped(unplaced)}</TableNumber>
                </TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>
                Total
                <span className="block text-xs text-muted-foreground whitespace-normal @2xl:hidden">
                  {total.requests} requests · {total.failed} failed
                </span>
              </TableCell>
              <TableCell>
                <TableNumber>{total.tokens}</TableNumber>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell">
                <TableNumber>{total.requests}</TableNumber>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell">
                <TableNumber>{total.failed}</TableNumber>
              </TableCell>
              <TableCell>
                <TableNumber>{total.value}</TableNumber>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  )
}

function LeftOnTheTable({ history }: { readonly history: History }) {
  const left = history.left
  if (left.windows === 0) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardDescription>No weekly or monthly resets were recorded in this range.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Card>
        <CardHeader>
          <CardTitle>
            {left.unused > 0 && left.unpriced === left.windows ? (
              "Plan prices unavailable"
            ) : (
              <span className="flex flex-col items-start gap-1.5">
                <span className="font-display text-5xl font-normal tracking-tight wrap-anywhere lining-nums">
                  {dollars(left.dollars)}
                </span>
                <span className="text-sm font-medium text-muted-foreground">Estimated unused value</span>
              </span>
            )}
          </CardTitle>
          <CardDescription>{leftLine(left.windows, left.unused)}</CardDescription>
          {left.unused > 0 && left.unpriced > 0 && (
            <p className="text-xs text-muted-foreground">
              {left.unpriced === 1
                ? "1 reset has no known plan price."
                : `${left.unpriced} resets have no known plan price.`}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <Table aria-label="Unused subscription quota by account">
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">Account</TableHead>
                <TableHead className="text-right">Unused</TableHead>
                <TableHead className="text-right">Est. value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {left.accounts
                .toSorted((a, b) => b.unused - a.unused || b.windows - a.windows || b.dollars - a.dollars)
                .map((account) => (
                  <TableRow key={`${account.provider}-${account.name}`}>
                    <TableCell>
                      <span className="block whitespace-normal wrap-anywhere">{account.name}</span>
                      <span className="block text-xs text-muted-foreground whitespace-normal">
                        {providerTitle(account.provider)} · {account.windows}{" "}
                        {account.windows === 1 ? "reset" : "resets"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex min-w-12 flex-col gap-1 text-right tabular-nums @lg:w-28">
                        {percentTick(account.unused)}
                        <Share fraction={account.unused / 100} ink={providerInk(account.provider)} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <TableNumber>{leftAccountValue(account, left.unpriced)}</TableNumber>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Based on the last readings before weekly and monthly resets. Estimates use configured plan prices where
        available, or list prices. A weekly window is valued at 12/52 of the monthly fee.
        {left.unused > 0 &&
          left.unpriced > 0 &&
          " Values cover priced resets. A dash means the price of the unused quota is unknown."}
      </p>
    </div>
  )
}

/** Usage by the machine that sent it, once machines other than this one use slopmax. */
function Machines({ range }: { readonly range: HistoryRange }) {
  const summary = useAtomValue(machinesAtom(range))
  const rows = Option.match(AsyncResult.value(summary), {
    onNone: () => [],
    onSome: machineRows,
  })
  if (rows.length === 0) return null
  return (
    <ChartPanel title="Machines">
      <Bars rows={rows} requests />
    </ChartPanel>
  )
}

function MetricReadout({ stat }: { readonly stat: Stat }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-card py-3.5 pe-3 ps-3 sm:px-6">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{stat.title}</dt>
      <dd className="text-2xl leading-none font-normal tracking-tight tabular-nums @lg:text-3xl">{stat.value}</dd>
      <dd className="text-xs text-muted-foreground">{stat.note}</dd>
    </div>
  )
}

function ProviderTotals({ history }: { readonly history: History }) {
  const rows = history.providers
    .map((provider, index) => ({
      provider,
      tokens: history.buckets.reduce((sum, bucket) => sum + (bucket.tokens[index] ?? 0), 0),
    }))
    .toSorted((a, b) => b.tokens - a.tokens)
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  return (
    <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-2">
      <h3 className="mb-1 text-sm font-medium">Tokens by provider</h3>
      <dl>
        {rows.map(({ provider, tokens }) => (
          <div key={provider} className="flex items-baseline justify-between gap-2 border-t py-2 first:border-t-0">
            <dt className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden @3xl:inline-flex">
                <Swatch ink={providerInk(provider)} />
              </span>
              <ProviderMark provider={provider} />
              <span className="wrap-anywhere">{providerTitle(provider)}</span>
            </dt>
            <dd className="shrink-0 text-right text-sm font-medium tabular-nums">
              {compact(tokens)}
              <span className="block text-xs font-normal text-muted-foreground">
                {total === 0 ? "—" : `${fixed((tokens / total) * 100, 1)}%`}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function UsageTrend({
  history,
  range,
  metric,
  select,
}: {
  readonly history: History
  readonly range: HistoryRange
  readonly metric: UsageMetric
  readonly select: (metric: UsageMetric) => void
}) {
  const setFilter = useAtomSet(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  const [tokens, requests, value, pace] = usageStats(history)
  const figures = { tokens, requests, value }
  const selected = figures[metric]
  const comparison = previousMetric(history, metric)
  const partialPeriod = range === "today" ? "Current hour in progress" : "Today in progress"
  const providersShown = metric === "tokens" && history.providers.length > 0
  const chartTitle =
    metric === "tokens"
      ? range === "today"
        ? "Hourly tokens"
        : "Daily tokens"
      : metric === "requests"
        ? "Request outcomes"
        : "Value over time"

  return (
    <section aria-labelledby="usage-heading" className="flex min-w-0 flex-col gap-5 sm:gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="usage-heading" className="font-heading text-xl font-semibold tracking-tight">
          Usage over time
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFilter({ span: range, outcome: "all" })
            setLimit(pageSize)
            go(Pages.requests)
          }}
        >
          View requests
          <ChevronRight aria-hidden data-icon="inline-end" />
        </Button>
      </div>
      <div
        className="flex flex-wrap gap-x-1.5 gap-y-0.5 border-b sm:gap-x-5"
        role="group"
        aria-label="Usage chart metric"
      >
        {usageMetrics.map((key) => (
          <Button
            key={key}
            variant="metric"
            size="sm"
            aria-pressed={key === metric}
            aria-controls="usage-trend"
            onClick={() => select(key)}
          >
            {figures[key].title}
          </Button>
        ))}
      </div>
      <section
        id="usage-trend"
        aria-label={selected.title}
        className="grid min-w-0 gap-4 @3xl:grid-cols-[minmax(12rem,1fr)_minmax(0,2.5fr)] @3xl:gap-x-8"
      >
        <div className="flex min-w-0 flex-col items-start gap-2 @3xl:col-start-1 @3xl:row-start-1">
          <p className="text-sm font-medium text-muted-foreground">{selected.title}</p>
          <strong className="font-display text-display-number font-normal tracking-tight wrap-anywhere lining-nums">
            {selected.value}
          </strong>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {selected.change !== undefined && <StatChange change={selected.change} />}
            <span className="text-muted-foreground">{selected.note}</span>
          </div>
          {comparison !== undefined && <p className="text-xs text-muted-foreground">{comparison}</p>}
        </div>
        <figure className="min-w-0 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1">
          <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{chartTitle}</span>
            <span className="text-xs text-muted-foreground">{partialPeriod}</span>
          </figcaption>
          {providersShown && history.providers.length > 1 && (
            <div className="mb-2 @3xl:hidden">
              <Legend
                items={history.providers.map((provider) => ({
                  ink: providerInk(provider),
                  title: providerTitle(provider),
                }))}
              />
            </div>
          )}
          {metric === "requests" && (
            <div className="mb-2">
              <Legend
                items={[
                  { ink: requestInks.answered, title: "Answered" },
                  { ink: requestInks.failed, title: "Failed" },
                ]}
              />
            </div>
          )}
          <UsagePlot history={history} metric={metric} />
        </figure>
        {providersShown && <ProviderTotals history={history} />}
      </section>
      <dl className="grid grid-cols-2 gap-px border-y bg-border @2xl:grid-cols-3">
        {[...usageMetrics.filter((key) => key !== metric).map((key) => figures[key]), pace].map((stat) => (
          <MetricReadout key={stat.title} stat={stat} />
        ))}
      </dl>
    </section>
  )
}

function UsagePlot({ history, metric }: { readonly history: History; readonly metric: UsageMetric }) {
  if (metric === "requests") return <RequestColumns history={history} size="lg" />
  if (metric === "value") {
    const most = Math.max(0, ...history.buckets.map((bucket) => bucket.cost))
    return (
      <Columns
        size="lg"
        every={labelEvery(history.range)}
        scale={zeroAxis(most, 0.01)}
        tick={moneyTick}
        buckets={history.buckets.map((bucket) => ({
          label: bucket.label,
          tip: costTip(bucket),
          parts: [{ value: bucket.cost, ink: valueInk }],
        }))}
      />
    )
  }
  const most = Math.max(0, ...history.buckets.map((bucket) => bucket.tokens.reduce((sum, n) => sum + n, 0)))
  if (history.range === "today") {
    return (
      <Lines
        size="lg"
        stacked
        labels={history.buckets.map((bucket) => bucket.label)}
        tips={history.buckets.map((bucket) => tokensTip(history, bucket))}
        series={history.providers.map((provider, i) => ({
          ink: providerInk(provider),
          values: history.buckets.map((bucket) => bucket.tokens[i] ?? 0),
        }))}
        scale={zeroAxis(most, 1)}
        tick={tokensTick}
        every={labelEvery(history.range)}
      />
    )
  }
  return (
    <Columns
      size="lg"
      every={labelEvery(history.range)}
      scale={zeroAxis(most, 1)}
      tick={tokensTick}
      buckets={history.buckets.map((bucket) => ({
        label: bucket.label,
        tip: tokensTip(history, bucket),
        parts: bucket.tokens.map((value, i) => ({
          value,
          ink: providerInk(history.providers[i]),
        })),
      }))}
    />
  )
}

function UsageBody({
  history,
  range,
  metric,
  select,
}: {
  readonly history: History
  readonly range: HistoryRange
  readonly metric: UsageMetric
  readonly select: (metric: UsageMetric) => void
}) {
  return (
    <>
      <UsageTrend history={history} range={range} metric={metric} select={select} />
      <ChartPanel title="Token mix">
        <TokenMix history={history} />
      </ChartPanel>
      <Pair>
        <ChartPanel title="Models">
          <Bars rows={modelRows(history)} mono />
        </ChartPanel>
        <ChartPanel title="Agents">
          <Bars rows={agentRows(history)} requests />
        </ChartPanel>
      </Pair>
      <Machines range={range} />
      {range !== "today" && (
        <ChartPanel title="Answered client requests by weekday">
          <Heatmap activity={history.activity} />
        </ChartPanel>
      )}
      <Section title="Accounts">
        <AccountsTable history={history} />
      </Section>
    </>
  )
}

export function QuotaHistoryPage() {
  return (
    <WithHistory allowEmpty>
      {(history) => (
        <Section title="Unused subscription quota">
          <LeftOnTheTable history={history} />
        </Section>
      )}
    </WithHistory>
  )
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
                { ink: "activity", title: "Saved by failover" },
                { ink: requestInks.failed, title: "Failed" },
              ]}
            />
          }
        >
          <p className="mb-2 text-right text-xs text-muted-foreground">
            {range === "today" ? "Current hour in progress" : "Today in progress"}
          </p>
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
                { value: bucket.rescued, ink: "activity" },
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
            series={[{ ink: "chart-4", values: cached }]}
          />
        </ChartPanel>
      </Pair>
      <Pair>
        <ChartPanel title="Output speed">
          {speeds.length === 0 ? (
            <span className="text-xs text-muted-foreground">No answers long enough to time yet.</span>
          ) : (
            <div className="@container flex flex-col gap-2.5">
              {speeds.map((row) => (
                <div key={`${row.providerId}:${row.model}`} className="flex items-center gap-3 text-xs">
                  <ProviderMark provider={row.providerId} />
                  <span className="w-28 shrink-0 @sm:w-40">
                    <span className="block truncate font-mono">{row.model}</span>
                    <span className="block truncate text-muted-foreground">{row.provider}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <Share fraction={row.fraction} ink={providerInk(row.providerId)} />
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums">{row.speed}</span>
                </div>
              ))}
            </div>
          )}
        </ChartPanel>
        <ChartPanel
          title="Time to first response"
          legend={
            <Legend
              items={[
                { ink: "meter", title: "Median" },
                { ink: "chart-3", title: "Slowest 5%" },
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
                ink: "chart-3",
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

function PerformanceHealth() {
  const groups = useAtomValue(groupsAtom).filter((group) => group.subscription)
  return (
    <Section title="Request health">
      <Pair>
        {groups.length > 0 && <HealthCard groups={groups} />}
        <RecentFailures />
      </Pair>
    </Section>
  )
}

export function AnalyticsPage({ performance }: { readonly performance: boolean }) {
  const [metric, select] = useState<UsageMetric>("tokens")
  return (
    <>
      <WithHistory allowEmpty={!performance}>
        {(history, range) =>
          performance ? (
            <PerformanceBody history={history} range={range} />
          ) : isQuiet(history) ? (
            <Quiet title="No requests recorded in this range" />
          ) : (
            <UsageBody history={history} range={range} metric={metric} select={select} />
          )
        }
      </WithHistory>
      {performance && <PerformanceHealth />}
    </>
  )
}
