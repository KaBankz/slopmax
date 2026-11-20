// What went through slopmax over a range: the Usage page (tokens, requests,
// value, models, agents, machines, when you work, accounts, quota left on
// the table)
// and the Performance page (reliability, cache, speed, first byte).
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { History, HistoryRange, ProviderId } from "@slopmax/client"
import { compact, grouped, providerTitle } from "@slopmax/client/format"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
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
import { Loaded, Section, Skeleton, Stats } from "../components/parts.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx"
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
  apiPriceValue,
  isQuiet,
  leftAccountValue,
  machineRows,
  modelRows,
  perRequest,
  performanceStats,
  previousRequests,
  speedRows,
  tokenMix,
  usageStats,
} from "../view/usage.ts"
import { dollars, leftLine } from "../view/words.ts"

const mixInks: ReadonlyArray<Ink> = ["chart-1", "chart-2", "chart-3", "chart-4"]
/**
 * The columns take the colors of the figures above them: tokens in the
 * Tokens figure's pink (then the other trend colors, a provider each),
 * requests in the Requests figure's blue, API value in its orange.
 */
const tokenInks: ReadonlyArray<Ink> = ["spark-2", "spark-3", "spark-4", "spark-1"]
/** A row no one provider owns, such as Other: grey. */
const noInk: Ink = "chart-2"
/** A provider's color, as the Tokens chart gives it. */
const providerInk = (providers: ReadonlyArray<ProviderId>, provider: ProviderId | undefined): Ink =>
  (provider === undefined ? undefined : tokenInks[providers.indexOf(provider)]) ?? noInk
const valueInk: Ink = "spark-1"

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
  providers,
  mono = false,
  requests = false,
}: {
  readonly rows: ReadonlyArray<BarRow>
  /** The range's providers, whose colors the rows take. */
  readonly providers: ReadonlyArray<ProviderId>
  readonly mono?: boolean
  readonly requests?: boolean
}) {
  return (
    <div className="@container flex flex-col gap-2.5">
      {rows.map((row) => (
        // In a narrow card the bar takes a line of its own under the figures, so they stay inside it.
        <div key={row.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs @md:flex-nowrap">
          <span
            className={
              mono
                ? "min-w-0 flex-1 truncate font-mono text-xs @md:w-40 @md:flex-none"
                : "min-w-0 flex-1 truncate @md:w-28 @md:flex-none"
            }
          >
            {row.name}
          </span>
          <span className="order-last basis-full @md:order-none @md:min-w-0 @md:flex-1 @md:basis-auto">
            <Share fraction={row.fraction} ink={providerInk(providers, row.provider)} />
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
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {mix.map((part) => (
          <span key={part.title} className="flex items-center gap-2">
            <Swatch ink={mixInks[part.series - 1] ?? "meter"} />
            <span className="flex-1 text-muted-foreground">{part.title}</span>
            <span className="tabular-nums">{compact(part.tokens)}</span>
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
              <TableHead className="w-full">Account</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="hidden w-18 text-right @2xl:table-cell">Requests</TableHead>
              <TableHead className="hidden w-14 text-right @2xl:table-cell">Failed</TableHead>
              <TableHead className="text-right">
                Value<span className="sr-only @lg:not-sr-only"> at API prices</span>
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
                  <span className="flex min-w-14 flex-col gap-1 text-right tabular-nums @lg:w-28">
                    {row.tokens}
                    <Share fraction={row.fraction} ink={providerInk(history.providers, row.providerId)} />
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
          <CardTitle className="text-2xl tabular-nums">
            {left.unused > 0 && left.unpriced === left.windows
              ? "Plan prices unavailable"
              : `${dollars(left.dollars)} estimated unused value`}
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
                        {providerTitle(account.provider)} / {account.windows}{" "}
                        {account.windows === 1 ? "reset" : "resets"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex min-w-12 flex-col gap-1 text-right tabular-nums @lg:w-28">
                        {percentTick(account.unused)}
                        <Share fraction={account.unused / 100} ink={providerInk(history.providers, account.provider)} />
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
      <Bars rows={rows} providers={[]} requests />
    </ChartPanel>
  )
}

function RequestActivity({ history, range }: { readonly history: History; readonly range: HistoryRange }) {
  const setFilter = useAtomSet(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  const comparison = previousRequests(history)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Request activity</h2>
        </CardTitle>
        {comparison !== undefined && <CardDescription>{comparison}</CardDescription>}
        <CardAction>
          <Button
            variant="ghost"
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
        </CardAction>
      </CardHeader>
      <CardContent>
        <Legend
          items={[
            { ink: requestInks.answered, title: "Answered" },
            { ink: requestInks.failed, title: "Failed" },
          ]}
        />
        <RequestColumns history={history} size="sm" />
      </CardContent>
    </Card>
  )
}

function UsageBody({ history, range }: { readonly history: History; readonly range: HistoryRange }) {
  const every = labelEvery(range)
  const tokensMost = Math.max(0, ...history.buckets.map((b) => b.tokens.reduce((s, n) => s + n, 0)))
  const costMost = Math.max(0, ...history.buckets.map((b) => b.cost))
  return (
    <>
      <Stats stats={usageStats(history)} />
      <ChartPanel
        title="Tokens"
        legend={
          <Legend
            items={history.providers.map((provider, i) => ({
              ink: tokenInks[i] ?? "meter",
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
            parts: bucket.tokens.map((value, i) => ({
              value,
              ink: tokenInks[i] ?? "meter",
            })),
          }))}
        />
      </ChartPanel>
      <Pair>
        <RequestActivity history={history} range={range} />
        <ChartPanel title={apiPriceValue}>
          <Columns
            size="sm"
            every={every}
            scale={zeroAxis(costMost, 0.01)}
            tick={moneyTick}
            buckets={history.buckets.map((bucket) => ({
              label: bucket.label,
              tip: costTip(bucket),
              parts: [{ value: bucket.cost, ink: valueInk }],
            }))}
          />
        </ChartPanel>
      </Pair>
      <Pair>
        <ChartPanel title="Models">
          <Bars rows={modelRows(history)} providers={history.providers} mono />
        </ChartPanel>
        <ChartPanel title="Token mix">
          <TokenMix history={history} />
        </ChartPanel>
      </Pair>
      <ChartPanel title="Agents">
        <Bars rows={agentRows(history)} providers={history.providers} requests />
      </ChartPanel>
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
                { ink: "meter", title: "Saved by failover" },
                { ink: requestInks.failed, title: "Failed" },
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
            <span className="text-xs text-muted-foreground">No answers long enough to time yet.</span>
          ) : (
            <div className="@container flex flex-col gap-2.5">
              {speeds.map((row) => (
                <div key={row.model} className="flex items-center gap-3 text-xs">
                  <span className="w-24 shrink-0 truncate font-mono text-xs @sm:w-40">{row.model}</span>
                  <span className="min-w-0 flex-1">
                    <Share fraction={row.fraction} ink={providerInk(history.providers, row.providerId)} />
                  </span>
                  <span className="w-16 shrink-0 text-muted-foreground">{row.provider}</span>
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
                { ink: "chart-2", title: "Slowest 5%" },
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
                ink: "chart-2",
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
  return (
    <>
      <WithHistory allowEmpty={!performance}>
        {(history, range) =>
          performance ? (
            <PerformanceBody history={history} range={range} />
          ) : isQuiet(history) ? (
            <Quiet title="No requests recorded in this range" />
          ) : (
            <UsageBody history={history} range={range} />
          )
        }
      </WithHistory>
      {performance && <PerformanceHealth />}
    </>
  )
}
