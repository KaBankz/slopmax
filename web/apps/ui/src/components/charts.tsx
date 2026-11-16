// The charts, on shadcn/ui's Chart (Recharts): stacked and grouped columns,
// lines, and the hours of a day; plus two small compositions Recharts has no
// shape for, the "When you work" grid and the token mix. Series take the
// theme's chart colors, and state colors where they mean a state (a failure
// is destructive).
import { cva } from "class-variance-authority"
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { type Axis, activityTip, busiest, shade, shadeScale, tickValues, weekdays } from "../view/charts.ts"
import { Tip } from "./tip.tsx"
import { type ChartConfig, ChartContainer, ChartTooltip } from "./ui/chart.tsx"

/** A series' color: one of the theme's chart colors, the primary color, or a state. */
export type Ink = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "meter" | "bad" | "warn"

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
      "chart-5": "bg-chart-5",
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

const heights = cva("w-full", { variants: { size: { sm: "h-36", md: "h-44", lg: "h-56" } } })

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
function axes(scale: Axis, tick: (value: number) => string, every: number, inset = 0) {
  return [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis
      key="x"
      dataKey="label"
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      interval={Math.max(0, every - 1)}
      padding={{ left: inset, right: inset }}
    />,
    <YAxis
      key="y"
      domain={[scale.bottom, scale.top]}
      ticks={[...tickValues(scale)]}
      tickFormatter={tick}
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
  const data: Array<Datum> = buckets.map((bucket) => ({
    label: bucket.label,
    tip: bucket.tip,
    ...Object.fromEntries(bucket.parts.map((part, i) => [`s${i}`, part.value])),
  }))
  return (
    <div className={heights({ size })}>
      <ChartContainer config={configFor(inks)} className="aspect-auto size-full">
        <BarChart accessibilityLayer data={data} barCategoryGap="20%">
          {axes(scale, tick, every)}
          <ChartTooltip cursor={false} content={TipContent} />
          {inks.map((_, i) => (
            <Bar
              key={i}
              dataKey={`s${i}`}
              fill={`var(--color-s${i})`}
              radius={grouped || i === inks.length - 1 ? [3, 3, 0, 0] : 0}
              {...(grouped ? {} : { stackId: "stack" })}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
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
}: {
  readonly labels: ReadonlyArray<string>
  readonly series: ReadonlyArray<{ readonly ink: Ink; readonly values: ReadonlyArray<number | undefined> }>
  readonly tips: ReadonlyArray<string>
  readonly scale: Axis
  readonly tick: (value: number) => string
  readonly every: number
  readonly size?: "sm" | "md" | "lg"
}) {
  const data: Array<Datum> = labels.map((label, i) => ({
    label,
    tip: tips[i] ?? label,
    ...Object.fromEntries(series.map((line, k) => [`s${k}`, line.values[i]])),
  }))
  return (
    <div className={heights({ size })}>
      <ChartContainer config={configFor(series.map((line) => line.ink))} className="aspect-auto size-full">
        <LineChart accessibilityLayer data={data}>
          {axes(scale, tick, every, 20)}
          <ChartTooltip cursor={false} content={TipContent} />
          {series.map((line, k) => (
            <Line
              key={k}
              dataKey={`s${k}`}
              type="linear"
              stroke={`var(--color-s${k})`}
              strokeWidth={2}
              dot={(props: { readonly cx?: number; readonly cy?: number; readonly index?: number }) =>
                props.index !== undefined && lone(line.values, props.index) ? (
                  <circle key={props.index} cx={props.cx} cy={props.cy} r={2.5} fill={`var(--color-s${k})`} />
                ) : (
                  <g key={props.index} />
                )
              }
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  )
}

/** Small columns for the hours of a day, without axes: the overview's and the panel's Today. */
export function Hours({
  values,
  size = "md",
}: {
  readonly values: ReadonlyArray<number>
  readonly size?: "sm" | "md"
}) {
  const data = values.map((value, hour) => ({ hour, value }))
  return (
    <div className="flex flex-col gap-1">
      <div className={size === "md" ? "h-16 w-full" : "h-8 w-full"}>
        <ChartContainer config={{ value: { color: "var(--primary)" } }} className="aspect-auto size-full">
          <BarChart data={data} barCategoryGap="25%" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Bar
              dataKey="value"
              fill="var(--color-value)"
              radius={[2, 2, 0, 0]}
              minPointSize={2}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      </div>
      {size === "md" && (
        <div className="flex text-xs text-muted-foreground">
          {["00:00", "06:00", "12:00", "18:00"].map((label) => (
            <span key={label} className="flex-1">
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** The week by hour: a cell per weekday and hour, darker the busier, each with a Tooltip. */
export function Heatmap({ activity }: { readonly activity: ReadonlyArray<ReadonlyArray<number>> }) {
  const most = Math.max(0, ...activity.flat())
  const peak = busiest(activity)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {activity.map((hours, day) => (
          <div key={day} className="flex items-center gap-0.5">
            <span className="w-8 shrink-0 text-xs text-muted-foreground">{weekdays[day]}</span>
            {hours.map((n, hour) => (
              <Tip key={hour} content={activityTip(day, hour, n)}>
                <div className="h-4 min-w-0 flex-1 rounded-xs bg-muted">
                  {n > 0 && (
                    <div
                      className="size-full rounded-xs bg-primary opacity-(--shade)"
                      style={{ "--shade": String(shade(n, most)) }}
                    />
                  )}
                </div>
              </Tip>
            ))}
          </div>
        ))}
        <div className="flex pl-8.5 text-xs text-muted-foreground">
          {["00:00", "06:00", "12:00", "18:00"].map((label) => (
            <span key={label} className="flex-1">
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{peak ?? ""}</span>
        <span className="inline-flex items-center gap-1">
          Less
          {shadeScale.map((level) => (
            <span
              key={level}
              aria-hidden
              className="size-2.5 rounded-xs bg-primary opacity-(--shade)"
              style={{ "--shade": String(level) }}
            />
          ))}
          More
        </span>
      </div>
    </div>
  )
}

/** One bar split by share: the token mix. Each part at least a sliver, none for zero. */
export function SplitBar({
  parts,
}: {
  readonly parts: ReadonlyArray<{ readonly share: number; readonly ink: Ink; readonly title: string }>
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

/** A swatch of a series' color. */
export function Swatch({ ink }: { readonly ink: Ink }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-xs ${fill({ ink })}`} />
}
