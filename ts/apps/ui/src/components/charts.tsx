// Hand-drawn charts, no chart library: stacked and grouped columns, lines,
// the "When you work" grid, and the token mix. Series are neutral greys, so
// color means state alone (a failure is red). Heights and positions reach
// CSS as custom properties; every class is static.
import { cva } from "class-variance-authority"
import type { ReactNode } from "react"
import { pct } from "../lib/style.ts"
import { type Axis, activityTip, busiest, shade, shadeScale, tickValues, weekdays } from "../view/charts.ts"
import { Tip } from "./ui/tooltip.tsx"

/** A series' color: the neutral ramp, the meter, or a state. */
export type Ink = "series-1" | "series-2" | "series-3" | "series-4" | "meter" | "bad" | "warn"

const fill = cva("", {
  variants: {
    ink: {
      "series-1": "bg-series-1",
      "series-2": "bg-series-2",
      "series-3": "bg-series-3",
      "series-4": "bg-series-4",
      meter: "bg-meter",
      bad: "bg-danger",
      warn: "bg-warning",
    },
  },
})

const stroke = cva("fill-none", {
  variants: {
    ink: {
      "series-1": "stroke-series-1",
      "series-2": "stroke-series-2",
      "series-3": "stroke-series-3",
      "series-4": "stroke-series-4",
      meter: "stroke-meter",
      bad: "stroke-danger",
      warn: "stroke-warning",
    },
  },
})

/** The series a chart shows, for its legend. */
export function Legend({ items }: { readonly items: ReadonlyArray<{ readonly ink: Ink; readonly title: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-small text-muted-foreground">
      {items.map((item) => (
        <span key={item.title} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`size-2 rounded-xs ${fill({ ink: item.ink })}`} />
          {item.title}
        </span>
      ))}
    </div>
  )
}

const heights = { sm: "h-32", md: "h-40", lg: "h-48" } as const

const plotHeight = cva("relative", { variants: { size: heights } })

/** A chart's frame: a value axis with gridlines at the left, the plot, and bucket labels beneath. */
function Frame({
  scale,
  tick,
  labels,
  every,
  size,
  children,
}: {
  readonly scale: Axis
  readonly tick: (value: number) => string
  readonly labels: ReadonlyArray<string>
  readonly every: number
  readonly size: keyof typeof heights
  readonly children: ReactNode
}) {
  const ticks = tickValues(scale)
  const span = scale.top - scale.bottom || 1
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex">
        <div className={`relative w-10 shrink-0 ${plotHeight({ size })}`}>
          {ticks.map((value) => (
            <span
              key={value}
              className="absolute right-2 bottom-(--at) translate-y-1/2 text-axis text-faint tabular"
              style={{ "--at": pct((value - scale.bottom) / span) }}
            >
              {tick(value)}
            </span>
          ))}
        </div>
        <div className={`min-w-0 flex-1 ${plotHeight({ size })}`}>
          {ticks.map((value) => (
            <div
              key={value}
              aria-hidden
              className="absolute inset-x-0 bottom-(--at) h-px bg-separator"
              style={{ "--at": pct((value - scale.bottom) / span) }}
            />
          ))}
          {children}
        </div>
      </div>
      <div className="flex pl-10">
        {labels.map((label, i) => (
          <span key={`${label}-${i}`} className="min-w-0 flex-1 text-center text-axis whitespace-nowrap text-faint">
            {i % every === 0 ? label : ""}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface ColumnBucket {
  readonly label: string
  readonly parts: ReadonlyArray<{ readonly value: number; readonly ink: Ink }>
  readonly tip: string
}

/** Columns over the buckets, stacked or side by side, each slot with its tooltip. */
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
  readonly size?: keyof typeof heights
  readonly grouped?: boolean
}) {
  const span = scale.top - scale.bottom || 1
  return (
    <Frame scale={scale} tick={tick} labels={buckets.map((b) => b.label)} every={every} size={size}>
      <div className="absolute inset-0 flex">
        {buckets.map((bucket, i) => (
          <Tip key={`${bucket.label}-${i}`} content={bucket.tip}>
            <div className="group flex h-full min-w-0 flex-1 items-end justify-center hover:bg-hover">
              {grouped ? (
                <div className="flex h-full w-4/5 max-w-6 items-end justify-center gap-px">
                  {bucket.parts.map((part, j) => (
                    <div
                      key={j}
                      className={`h-(--h) min-w-0 flex-1 rounded-t-xs ${fill({ ink: part.ink })}`}
                      style={{ "--h": pct(part.value / span) }}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex h-full w-3/5 max-w-5 flex-col-reverse items-stretch justify-start gap-px">
                  {bucket.parts
                    .filter((part) => part.value > 0)
                    .map((part, j) => (
                      <div
                        key={j}
                        className={`h-(--h) min-h-0.5 shrink-0 first:rounded-b-none last:rounded-t-xs ${fill({ ink: part.ink })}`}
                        style={{ "--h": pct(part.value / span) }}
                      />
                    ))}
                </div>
              )}
            </div>
          </Tip>
        ))}
      </div>
    </Frame>
  )
}

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
  readonly size?: keyof typeof heights
}) {
  const n = Math.max(1, labels.length)
  const span = scale.top - scale.bottom || 1
  const x = (i: number) => ((i + 0.5) / n) * 100
  const y = (v: number) => 100 - Math.min(1, Math.max(0, (v - scale.bottom) / span)) * 100
  return (
    <Frame scale={scale} tick={tick} labels={labels} every={every} size={size}>
      <svg
        aria-hidden
        className="absolute inset-0 size-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {series.map((line, k) => {
          const segments: Array<string> = []
          line.values.forEach((value, i) => {
            const before = line.values[i - 1]
            if (value === undefined) return
            segments.push(`${before === undefined || i === 0 ? "M" : "L"}${x(i)} ${y(value)}`)
          })
          return (
            <path
              key={k}
              d={segments.join(" ")}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              className={stroke({ ink: line.ink })}
            />
          )
        })}
      </svg>
      {series.map((line, k) =>
        line.values.map((value, i) =>
          value !== undefined && line.values[i - 1] === undefined && line.values[i + 1] === undefined ? (
            <span
              key={`${k}-${i}`}
              aria-hidden
              className={`absolute bottom-(--y) left-(--x) size-1 -translate-x-1/2 translate-y-1/2 rounded-full ${fill({ ink: line.ink })}`}
              style={{ "--x": `${x(i)}%`, "--y": `${100 - y(value)}%` }}
            />
          ) : null,
        ),
      )}
      <div className="absolute inset-0 flex">
        {labels.map((label, i) => (
          <Tip key={`${label}-${i}`} content={tips[i] ?? label}>
            <div className="h-full min-w-0 flex-1 hover:bg-hover" />
          </Tip>
        ))}
      </div>
    </Frame>
  )
}

/** Small columns for the hours of a day, without an axis: the overview's and the panel's Today. */
export function Hours({
  values,
  size = "md",
}: {
  readonly values: ReadonlyArray<number>
  readonly size?: "sm" | "md"
}) {
  const most = Math.max(1, ...values)
  return (
    <div className="flex flex-col gap-1">
      <div className={size === "md" ? "flex h-14 items-end gap-px" : "flex h-7 items-end gap-px"}>
        {values.map((value, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
            {value > 0 ? (
              <div
                className="h-(--h) min-h-1 w-3/5 max-w-3.5 rounded-t-xs bg-meter"
                style={{ "--h": pct(value / most) }}
              />
            ) : (
              <div className="h-1 w-3/5 max-w-3.5 rounded-xs bg-track" />
            )}
          </div>
        ))}
      </div>
      {size === "md" && (
        <div className="flex text-axis text-faint">
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

/** The week by hour: a cell per weekday and hour, darker the busier. */
export function Heatmap({ activity }: { readonly activity: ReadonlyArray<ReadonlyArray<number>> }) {
  const most = Math.max(0, ...activity.flat())
  const peak = busiest(activity)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {activity.map((hours, day) => (
          <div key={day} className="flex items-center gap-0.5">
            <span className="w-8 shrink-0 text-axis text-faint">{weekdays[day]}</span>
            {hours.map((n, hour) => (
              <Tip key={hour} content={activityTip(day, hour, n)}>
                <div className="h-4 min-w-0 flex-1 rounded-xs bg-track">
                  {n > 0 && (
                    <div
                      className="size-full rounded-xs bg-foreground opacity-(--shade)"
                      style={{ "--shade": String(shade(n, most)) }}
                    />
                  )}
                </div>
              </Tip>
            ))}
          </div>
        ))}
        <div className="flex pl-8.5 text-axis text-faint">
          {["00:00", "06:00", "12:00", "18:00"].map((label) => (
            <span key={label} className="flex-1">
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-small text-muted-foreground">
        <span>{peak ?? ""}</span>
        <span className="inline-flex items-center gap-1">
          Less
          {shadeScale.map((level) => (
            <span
              key={level}
              aria-hidden
              className="size-2.5 rounded-xs bg-foreground opacity-(--shade)"
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
    <div className="flex h-2 w-full gap-px overflow-hidden rounded-xs">
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
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-xs ${fill({ ink })}`} />
}
