// The charts, on shadcn/ui's Chart (Recharts): stacked and grouped columns,
// lines, a pool's use over time with where it is
// heading, a figure's trend line, and a list row's bar; plus two small
// compositions Recharts has no shape for, the "When you work" grid and the
// token mix. Series take the
// theme's chart colors, and state colors where they mean a state (a failure
// is destructive).
import type { History } from "@slopmax/client"
import { cva } from "class-variance-authority"
import type { DateTime } from "effect"
import { AreaChart, BarChart, CartesianGrid, ComposedChart, ReferenceLine, XAxis, YAxis } from "recharts"
import {
  type Axis,
  activityTip,
  countTick,
  labelEvery,
  type Level,
  levelScale,
  levels,
  requestsTip,
  rhythm,
  type SparkPoint,
  tickValues,
  weekdays,
  zeroAxis,
} from "../view/charts.ts"
import { tickLabel, type TrendView } from "../view/forecast.ts"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import {
  ChartArea,
  ChartBar,
  type ChartConfig,
  ChartContainer,
  ChartLine,
  ChartMeter,
  ChartTooltip,
} from "./ui/chart.tsx"

/** A series' color: one of the theme's chart colors, a trend line's, the primary color, or a state. */
export type Ink =
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "provider-grok"
  | "provider-claude"
  | "provider-codex"
  | "provider-xai"
  | "provider-openai"
  | "activity"
  | "provider-anthropic"
  | "meter"
  | "bad"
  | "warn"

/** The CSS color of an ink, which follows the theme. */
const color = (ink: Ink): string => {
  switch (ink) {
    case "meter":
      return "var(--primary)"
    case "bad":
      return "var(--destructive)"
    case "warn":
      return "var(--warning)"
    default:
      return `var(--${ink})`
  }
}

const fill = cva("", {
  variants: {
    ink: {
      "chart-1": "bg-chart-1",
      "chart-2": "bg-chart-2",
      "chart-3": "bg-chart-3",
      "chart-4": "bg-chart-4",
      "provider-grok": "bg-provider-grok",
      "provider-claude": "bg-provider-claude",
      "provider-codex": "bg-provider-codex",
      "provider-xai": "bg-provider-xai",
      "provider-openai": "bg-provider-openai",
      activity: "bg-activity",
      "provider-anthropic": "bg-provider-anthropic",
      meter: "bg-primary",
      bad: "bg-destructive",
      warn: "bg-warning",
    },
  },
})

/** The series a chart shows, for its legend. */
export function Legend({ items }: { readonly items: ReadonlyArray<{ readonly ink: Ink; readonly title: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.title} className="inline-flex items-center gap-1.5">
          <Swatch ink={item.ink} />
          {item.title}
        </span>
      ))}
    </div>
  )
}

const heights = cva("w-full", {
  variants: { size: { sm: "h-36", md: "h-44", lg: "h-44 sm:h-56" } },
})

/** A row of chart data: the bucket's label, its tooltip, and a value per series (`s0`, `s1`, …). */
interface Datum {
  readonly label: string
  readonly tip: string
  readonly [series: `s${number}`]: number | undefined
}

/** The tooltip's words, from the datum under the pointer, in shadcn's tooltip box. */
function TipContent({ active, payload }: { readonly active?: boolean; readonly payload?: ReadonlyArray<unknown> }) {
  if (active !== true || payload === undefined) return null
  const first: unknown = payload[0]
  if (typeof first !== "object" || first === null || !("payload" in first)) return null
  const datum: unknown = first.payload
  if (typeof datum !== "object" || datum === null || !("tip" in datum) || typeof datum.tip !== "string") return null
  return (
    <div className="grid min-w-32 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs whitespace-pre-line shadow-xl">
      {datum.tip}
    </div>
  )
}

/** The config for series `s0`, `s1`, … in these inks. */
const configFor = (inks: ReadonlyArray<Ink>): ChartConfig =>
  Object.fromEntries(inks.map((ink, i) => [`s${i}`, { color: color(ink) }]))

const axisText = { fill: "var(--muted-foreground)", fontSize: 12 }

export interface ColumnBucket {
  readonly label: string
  readonly parts: ReadonlyArray<{ readonly value: number; readonly ink: Ink }>
  readonly tip: string
}

/**
 * A value axis at the left, from the scale, and the buckets' labels beneath,
 * every `every`th. `inset` pads the ends of the label axis, for lines, whose
 * first and last points sit on the plot's edges and would cut their labels.
 */
function axes(scale: Axis, tick: (value: number) => string, labels: ReadonlyArray<string>, every: number, inset = 0) {
  return [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis
      key="x"
      dataKey="label"
      tick={axisText}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      ticks={labels.filter((_, index) => index % every === 0 || index === labels.length - 1)}
      interval="preserveStartEnd"
      minTickGap={10}
      padding={{ left: inset, right: inset }}
    />,
    <YAxis
      key="y"
      domain={[scale.bottom, scale.top]}
      ticks={[...tickValues(scale)]}
      tickFormatter={tick}
      tick={axisText}
      interval={0}
      tickLine={false}
      axisLine={false}
      width={44}
    />,
  ]
}

/** Columns over the buckets, stacked or side by side, each with its tooltip. */
export function Columns({
  buckets,
  scale,
  tick,
  every,
  size = "md",
  grouped = false,
}: {
  readonly buckets: ReadonlyArray<ColumnBucket>
  readonly scale: Axis
  readonly tick: (value: number) => string
  readonly every: number
  readonly size?: "sm" | "md" | "lg"
  readonly grouped?: boolean
}) {
  const inks = buckets[0]?.parts.map((part) => part.ink) ?? []
  const keys = inks.map((_, i) => `s${i}`)
  const data: Array<Datum> = buckets.map((bucket) => ({
    label: bucket.label,
    tip: bucket.tip,
    ...Object.fromEntries(bucket.parts.map((part, i) => [`s${i}`, part.value])),
  }))
  return (
    <div className={heights({ size })}>
      <ChartContainer config={configFor(inks)} className="aspect-auto size-full">
        <BarChart
          accessibilityLayer
          data={data}
          barCategoryGap="20%"
          margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
        >
          {axes(
            scale,
            tick,
            buckets.map((bucket) => bucket.label),
            every,
          )}
          <ChartTooltip cursor={false} content={TipContent} />
          {inks.map((_, i) => (
            <ChartBar
              key={i}
              dataKey={`s${i}`}
              top={grouped || i === inks.length - 1}
              {...(grouped ? {} : { stack: keys })}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export const requestInks = { answered: "activity", failed: "bad" } as const

/** Requests by outcome, with each stacked column showing the total for its bucket. */
export function RequestColumns({ history, size }: { readonly history: History; readonly size: "sm" | "lg" }) {
  const most = Math.max(0, ...history.buckets.map((bucket) => bucket.requests + bucket.failed))
  return (
    <figure>
      <figcaption className="sr-only">
        Answered and failed requests by {history.range === "today" ? "hour" : "day"}
      </figcaption>
      <Columns
        size={size}
        every={labelEvery(history.range)}
        scale={zeroAxis(most, 1)}
        tick={countTick}
        buckets={history.buckets.map((bucket) => ({
          label: bucket.label,
          tip: requestsTip(bucket),
          parts: [
            { value: bucket.requests, ink: requestInks.answered },
            { value: bucket.failed, ink: requestInks.failed },
          ],
        }))}
      />
    </figure>
  )
}

/** Whether a value stands alone, with no neighbor for a line to reach. */
const lone = (values: ReadonlyArray<number | undefined>, i: number): boolean =>
  values[i] !== undefined && values[i - 1] === undefined && values[i + 1] === undefined

/** Lines through each bucket with a value; a lone value shows as a dot. */
export function Lines({
  labels,
  series,
  tips,
  scale,
  tick,
  every,
  size = "sm",
  stacked = false,
}: {
  readonly labels: ReadonlyArray<string>
  readonly series: ReadonlyArray<{
    readonly ink: Ink
    readonly values: ReadonlyArray<number | undefined>
  }>
  readonly tips: ReadonlyArray<string>
  readonly scale: Axis
  readonly tick: (value: number) => string
  readonly every: number
  readonly size?: "sm" | "md" | "lg"
  readonly stacked?: boolean
}) {
  const data: Array<Datum> = labels.map((label, i) => ({
    label,
    tip: tips[i] ?? label,
    ...Object.fromEntries(series.map((line, k) => [`s${k}`, line.values[i]])),
  }))
  return (
    <div className={heights({ size })}>
      <ChartContainer config={configFor(series.map((line) => line.ink))} className="aspect-auto size-full">
        <AreaChart accessibilityLayer data={data}>
          {axes(scale, tick, labels, every, 20)}
          <ChartTooltip cursor={false} content={TipContent} />
          {series.map((line, k) => (
            <ChartArea
              key={k}
              dataKey={`s${k}`}
              {...(stacked ? { stackId: "total" } : {})}
              type={stacked ? "linear" : "monotone"}
              connectNulls={false}
              dot={(props: { readonly cx?: number; readonly cy?: number; readonly index?: number }) =>
                props.index !== undefined && lone(line.values, props.index) ? (
                  <circle key={props.index} cx={props.cx} cy={props.cy} r={2.5} fill={`var(--color-s${k})`} />
                ) : (
                  <g key={props.index} />
                )
              }
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

const percents = [0, 25, 50, 75, 100]

/**
 * A pool's use over time: what was recorded, filled, then where it is
 * heading, dashed (in the warning color when that runs it dry); the full
 * line at 100%, now, and each account's reset ahead as a faint rule.
 */
export function TrendChart({ view, zone }: { readonly view: TrendView; readonly zone: DateTime.TimeZone }) {
  const config: ChartConfig = {
    recorded: { color: "var(--primary)" },
    projected: {
      color: view.dry ? "var(--warning)" : "var(--muted-foreground)",
    },
  }
  return (
    <div className={heights({ size: "lg" })}>
      <ChartContainer config={config} className="aspect-auto size-full">
        <ComposedChart accessibilityLayer data={[...view.data]} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[view.from, view.to]}
            ticks={[...view.ticks]}
            tickFormatter={(t: number) => tickLabel(t, view.span, zone)}
            tick={axisText}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            domain={[0, 100]}
            ticks={percents}
            tickFormatter={(value: number) => `${value}%`}
            interval={0}
            tick={axisText}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <ChartTooltip cursor={{ stroke: "var(--border)" }} content={TipContent} />
          <ReferenceLine y={100} stroke="var(--destructive)" strokeOpacity={0.5} strokeDasharray="3 3" />
          {view.resets.map((reset) => (
            <ReferenceLine key={reset.t} x={reset.t} stroke="var(--border)" />
          ))}
          <ReferenceLine
            x={view.now}
            stroke="var(--muted-foreground)"
            strokeDasharray="2 3"
            label={{
              value: "Now",
              position: "insideTopLeft",
              fill: "var(--muted-foreground)",
              fontSize: 11,
            }}
          />
          <ChartArea dataKey="recorded" type="linear" />
          <ChartLine dataKey="projected" type="linear" strokeDasharray="5 4" />
        </ComposedChart>
      </ChartContainer>
    </div>
  )
}

const sparkHeights = cva("w-full", {
  variants: { size: { md: "h-12", lg: "h-24" } },
})

/**
 * A figure's trend, without axes: a line over its buckets, filled to the
 * foot in its color fading out, each point's tooltip under the pointer.
 */
export function Spark({
  points,
  ink,
  size = "md",
}: {
  readonly points: ReadonlyArray<SparkPoint>
  readonly ink: Ink
  readonly size?: "md" | "lg"
}) {
  return (
    <div className={sparkHeights({ size })}>
      <ChartContainer config={{ value: { color: color(ink) } }} className="aspect-auto size-full">
        <AreaChart data={[...points]} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
          <XAxis dataKey="label" hide />
          <YAxis hide domain={[0, "auto"]} />
          <ChartTooltip cursor={{ stroke: "var(--border)" }} content={TipContent} />
          <ChartArea dataKey="value" connectNulls />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

/** A grid cell's fill at each level: a faint well for none, then the Requests blue, deeper the busier. */
const cell = cva("rounded-xs", {
  variants: {
    level: {
      0: "bg-foreground/6",
      1: "bg-activity/30",
      2: "bg-activity/55",
      3: "bg-activity/80",
      4: "bg-activity",
    },
  },
})

const hourLabels = ["00:00", "06:00", "12:00", "18:00"]

/**
 * The week by hour, as a contribution graph: a square per weekday and hour,
 * in four levels by how busy it was, with an accessible hourly readout.
 */
export function Heatmap({ activity }: { readonly activity: ReadonlyArray<ReadonlyArray<number>> }) {
  const grid = levels(activity)
  const facts = rhythm(activity)
  return (
    <div className="flex flex-col gap-6 @3xl:flex-row @3xl:items-start">
      <div className="flex max-w-3xl min-w-0 flex-1 flex-col gap-3">
        <div aria-hidden className="grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] gap-0.75">
          {grid.map((hours, day) => [
            <span key={`d${day}`} className="self-center text-xs text-muted-foreground">
              {weekdays[day]}
            </span>,
            ...hours.map((level: Level, hour) => (
              <div key={`${day}:${hour}`} className={`aspect-square ${cell({ level })}`} />
            )),
          ])}
          <span />
          {hourLabels.map((label) => (
            <span key={label} className="col-span-6 pt-1 text-xs text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
        <div aria-hidden className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
          <span className="mr-1">Less</span>
          {levelScale.map((level) => (
            <span key={level} aria-hidden className={`size-3 ${cell({ level })}`} />
          ))}
          <span className="ml-1">More</span>
        </div>
        {facts.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>Show active hours</CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2 @lg:grid-cols-3">
                {activity.flatMap((hours, day) =>
                  hours.map((n, hour) => (n > 0 ? <li key={`${day}:${hour}`}>{activityTip(day, hour, n)}</li> : null)),
                )}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-4 @3xl:w-48 @3xl:grid-cols-1">
          {facts.map((fact) => (
            <div key={fact.title} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{fact.title}</dt>
              <dd className="text-sm font-medium tabular-nums">{fact.value}</dd>
              <dd className="text-xs text-muted-foreground">{fact.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** One bar split by share: the token mix. Each part at least a sliver, none for zero. */
export function SplitBar({
  parts,
}: {
  readonly parts: ReadonlyArray<{
    readonly share: number
    readonly ink: Ink
    readonly title: string
  }>
}) {
  return (
    <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
      {parts
        .filter((part) => part.share > 0)
        .map((part) => (
          <div
            key={part.title}
            className={`min-w-1 grow-(--share) basis-0 ${fill({ ink: part.ink })}`}
            style={{ "--share": String(part.share) }}
          />
        ))}
    </div>
  )
}

/** A row's bar in a list, as long as its share of the largest, in its series' color. */
export function Share({ fraction, ink }: { readonly fraction: number; readonly ink: Ink }) {
  return <ChartMeter value={fraction} color={color(ink)} />
}

/** A swatch of a series' color and texture. */
export function Swatch({ ink, solid = false }: { readonly ink: Ink; readonly solid?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3 shrink-0 rounded-xs ${solid ? "" : "measurement-dither"} ${fill({ ink })}`}
    />
  )
}
