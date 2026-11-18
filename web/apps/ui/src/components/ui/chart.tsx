// shadcn/ui's Chart over Recharts. Two changes:
//
// - The series colors reach CSS as custom properties in the container's own
//   `style` (`--color-<key>`) instead of an injected <style> element, which
//   the dashboard's content security policy refuses. So a series takes a
//   `color` (a CSS value such as `var(--chart-1)`, which follows the theme),
//   not a per-theme `theme` map.
// - ChartArea, ChartLine and ChartBar: Recharts' Area, Line and Bar with
//   slopmax's look as their defaults (an ordered dither in the series' color
//   under smooth curves and in bars, after Dither Kit's, and the columns not
//   under the pointer stepping back), so every chart draws alike. Use them in
//   place of Recharts' own. ChartMeter is the same dither as a bar across,
//   for a list's rows.
import * as React from "react"
import { cn } from "cn"
import * as RechartsPrimitive from "recharts"
import type { TooltipValueType } from "recharts"

const INITIAL_DIMENSION = { width: 320, height: 200 } as const
type TooltipNameType = number | string

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    icon?: React.ComponentType
    color?: string
  }
>

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }

  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
  initialDimension?: {
    width: number
    height: number
  }
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className,
        )}
        style={{ ...colorVariables(config), ...style }}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

/** Each series' color as `--color-<key>`, for the container's style. */
const colorVariables = (config: ChartConfig): Record<`--${string}`, string> =>
  Object.fromEntries(
    Object.entries(config).flatMap(([key, item]) => (item.color === undefined ? [] : [[`--color-${key}`, item.color]])),
  )

const ChartTooltip = RechartsPrimitive.Tooltip

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<"div"> & {
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: "line" | "dot" | "dashed"
    nameKey?: string
    labelKey?: string
  } & Omit<RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>, "accessibilityLayer">) {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }

    const [item] = payload
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value = !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label

    if (labelFormatter) {
      return <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>
    }

    if (!value) {
      return null
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`
            const itemConfig = getPayloadConfigFromPayload(config, item, key)
            const indicatorColor = color ?? item.payload?.fill ?? item.color

            return (
              <div
                key={index}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn("shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)", {
                            "h-2.5 w-2.5": indicator === "dot",
                            "w-1": indicator === "line",
                            "w-0 border-[1.5px] border-dashed bg-transparent": indicator === "dashed",
                            "my-0.5": nestLabel && indicator === "dashed",
                          })}
                          style={
                            {
                              "--color-bg": indicatorColor,
                              "--color-border": indicatorColor,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
                      </div>
                      {item.value != null && (
                        <span className="font-mono font-medium text-foreground tabular-nums">
                          {typeof item.value === "number" ? item.value.toLocaleString() : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean
  nameKey?: string
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div className={cn("flex items-center justify-center gap-4", verticalAlign === "top" ? "pb-3" : "pt-3", className)}>
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)

          return (
            <div
              key={index}
              className={cn("flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground")}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor: item.color,
                  }}
                />
              )}
              {itemConfig?.label}
            </div>
          )
        })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// slopmax's series: Recharts' Area, Line and Bar with the house look as
// their defaults, so every chart draws the same way. Each takes its color
// from the config by its `dataKey` (`--color-<key>`).

/** The series' color, from the container's custom properties. */
const seriesColor = (key: string) => `var(--color-${key})`

/** A paint server's id, unique on the page (`useId` gives colons, which `url(#…)` refuses). */
function usePaintId(name: string) {
  return `${name}-${React.useId().replace(/:/g, "")}`
}

// The dither. An ordered (Bayer) dither in the series' color: cells on a
// fixed grid, lit where the fill's density beats the matrix's threshold, so
// a fill thins from solid at its foot to a scatter at its top edge. A cell
// that isn't lit still shows as a faint tint of the color, so the fill
// keeps its shape where it thins out, on light and dark alike. The density runs over 17 steps, each a 4×4-cell pattern; the cells
// sit on the page's grid, so neighbouring bars line up.

/** A dither cell's side, in px. */
const CELL = 2
/** The 4×4 Bayer matrix as thresholds in (0, 1). */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16))
/** The density steps, 0 (nothing lit) to 16 (all lit). */
const STEPS = 16
/** A cell's opacity at `density`, lit or not: lit cells near full at every density, unlit ones a tint. */
const cellOpacity = (density: number, lit: boolean) => (lit ? 0.75 + 0.25 * density : 0.1 + 0.08 * density)

/** Snaps a coordinate to the dither grid. */
const snap = (v: number) => Math.round(v / CELL) * CELL

/** The 4×4 cells of one density step, for a tile. */
function StepCells({ step, color }: { step: number; color: string }) {
  const density = step / STEPS
  return (
    <>
      {BAYER.flatMap((row, j) =>
        row.map((threshold, i) => (
          <rect
            key={`${i}:${j}`}
            x={i * CELL}
            y={j * CELL}
            width={CELL}
            height={CELL}
            fill={color}
            fillOpacity={cellOpacity(density, density > threshold)}
            shapeRendering="crispEdges"
          />
        )),
      )}
    </>
  )
}

/** One pattern per density step, `${id}-<step>`, in the series' color. */
function DitherSteps({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      {Array.from({ length: STEPS + 1 }, (_, step) => (
        <pattern key={step} id={`${id}-${step}`} patternUnits="userSpaceOnUse" width={4 * CELL} height={4 * CELL}>
          <StepCells step={step} color={color} />
        </pattern>
      ))}
    </defs>
  )
}

/**
 * The fill under a curve as one tall pattern over the plot: thin at the
 * plot's top, solid at its floor, so the dither deepens as values fall
 * toward it, the same at every x.
 */
function DitherColumn({ id, color }: { id: string; color: string }) {
  const plot = RechartsPrimitive.usePlotArea()
  if (!plot || plot.height <= 0) return null
  const top = snap(plot.y)
  const rows = Math.max(1, Math.round(plot.height / CELL))
  return (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" x={0} y={top} width={4 * CELL} height={rows * CELL}>
        {Array.from({ length: rows }, (_, r) => {
          const density = (r + 0.5) / rows
          const thresholds = BAYER[(snap(plot.y) / CELL + r) & 3] ?? []
          return thresholds.map((threshold, i) => (
            <rect
              key={`${r}:${i}`}
              x={i * CELL}
              y={r * CELL}
              width={CELL}
              height={CELL}
              fill={color}
              fillOpacity={cellOpacity(density, density > threshold)}
              shapeRendering="crispEdges"
            />
          ))
        })}
      </pattern>
    </defs>
  )
}

/**
 * A curve over its fill: smooth, 2px, round joins, a dot only under the
 * pointer, no entry animation. The fill is the dither (`texture="dither"`, the
 * default) or the color fading out toward the floor (`"fade"`).
 */
function ChartArea({
  dataKey,
  texture = "dither",
  ...props
}: Omit<React.ComponentProps<typeof RechartsPrimitive.Area>, "dataKey" | "ref"> & {
  dataKey: string
  texture?: "dither" | "fade"
}) {
  const paint = usePaintId(`area-${dataKey}`)
  const color = seriesColor(dataKey)
  return (
    <>
      {texture === "dither" ? (
        <DitherColumn id={paint} color={color} />
      ) : (
        <defs>
          <linearGradient id={paint} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      <RechartsPrimitive.Area
        dataKey={dataKey}
        type="monotone"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill={`url(#${paint})`}
        dot={false}
        activeDot={{ r: 3, strokeWidth: 0 }}
        isAnimationActive={false}
        {...props}
      />
    </>
  )
}

/** A curve alone, in the same hand as ChartArea: for a projection or a series that should not fill. */
function ChartLine({
  dataKey,
  ...props
}: Omit<React.ComponentProps<typeof RechartsPrimitive.Line>, "dataKey" | "ref"> & { dataKey: string }) {
  const color = seriesColor(dataKey)
  return (
    <RechartsPrimitive.Line
      dataKey={dataKey}
      type="monotone"
      stroke={color}
      strokeWidth={2}
      strokeLinejoin="round"
      strokeLinecap="round"
      dot={false}
      activeDot={{ r: 3, strokeWidth: 0, fill: color }}
      isAnimationActive={false}
      {...props}
    />
  )
}

/** How a bar is drawn: `dither`, the dither under a soft cap; `solid`, flat with rounded tops. */
type ChartBarVariant = "dither" | "solid"

type BarShape = RechartsPrimitive.BarShapeProps

/**
 * Where the pointer is: on this bar's column, on another's (this one steps
 * back), or off the chart. `datum` is the bar's row of the chart's data.
 */
function usePointer(datum: unknown): "here" | "elsewhere" | "away" {
  const active = RechartsPrimitive.useActiveTooltipDataPoints()
  if (active === undefined || active.length === 0) return "away"
  return active.includes(datum) ? "here" : "elsewhere"
}

/** A rectangle's path with its top corners rounded by `r`. */
const topRounded = (x: number, y: number, width: number, height: number, r: number) => {
  const radius = Math.max(0, Math.min(r, width / 2, height))
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`
}

/**
 * A bar dithered from its column's top to its foot: bands of rows at each
 * density step, sparse at the top and solid at the foot, under a soft
 * rounded cap. A stacked part takes its rows' density from the whole
 * column (`column`, the column's top in px), so a stack fades as one. The
 * column under the pointer thickens; the others step back.
 */
function DitherBar({
  x,
  y,
  width,
  height,
  fill,
  payload,
  stackedBarStart,
  paint,
  column,
}: BarShape & { paint: string; column?: number | undefined }) {
  const pointer = usePointer(payload)
  if (height <= 0) return null
  const left = snap(x)
  const right = Math.max(left + CELL, snap(x + width))
  const top = snap(y)
  const bottom = snap(y + height)
  const foot = column === undefined ? bottom : snap(stackedBarStart)
  const head = column === undefined ? top : snap(column)
  const depth = Math.max(CELL, foot - head)
  const lift = pointer === "here" ? 2 : 0
  const bands: Array<{ from: number; to: number; step: number }> = []
  for (let row = top; row < bottom; row += CELL) {
    const density = (row + CELL / 2 - head) / depth
    const step = Math.max(0, Math.min(STEPS, Math.round(density * STEPS) + lift))
    const last = bands.at(-1)
    if (last && last.step === step) last.to = row + CELL
    else bands.push({ from: row, to: row + CELL, step })
  }
  return (
    <g opacity={pointer === "elsewhere" ? 0.5 : 1}>
      {bands.map((band) => (
        <rect
          key={band.from}
          x={left}
          y={band.from}
          width={right - left}
          height={band.to - band.from}
          fill={`url(#${paint}-${band.step})`}
        />
      ))}
      <path
        d={topRounded(left, top - CELL / 2, right - left, 3, 2)}
        fill={fill}
        fillOpacity={pointer === "here" ? 1 : 0.85}
      />
    </g>
  )
}

function SolidBar({ x, y, width, height, fill, payload, top }: BarShape & { top: boolean }) {
  const pointer = usePointer(payload)
  if (height <= 0) return null
  return (
    <path d={topRounded(x, y, width, height, top ? 4 : 0)} fill={fill} opacity={pointer === "elsewhere" ? 0.5 : 1} />
  )
}

/** The sum of a row's values under `keys`. */
const stackTotal = (datum: unknown, keys: ReadonlyArray<string>) =>
  keys.reduce((sum, key) => {
    const value: unknown = typeof datum === "object" && datum !== null ? Reflect.get(datum, key) : undefined
    return sum + (typeof value === "number" ? value : 0)
  }, 0)

/**
 * A bar series in the house look (`dither` unless told otherwise), with the
 * columns not under the pointer stepping back. `top` says this series is the
 * stack's last (or stands alone), whose corners round in the `solid` look.
 * A stacked series names its stack's keys in `stack`, so the dither runs
 * over the whole column.
 */
function ChartBar({
  dataKey,
  variant = "dither",
  top = true,
  stack,
  ...props
}: Omit<React.ComponentProps<typeof RechartsPrimitive.Bar>, "dataKey" | "ref" | "shape"> & {
  dataKey: string
  variant?: ChartBarVariant
  top?: boolean
  stack?: ReadonlyArray<string>
}) {
  const paint = usePaintId(`bar-${dataKey}`)
  const color = seriesColor(dataKey)
  const scale = RechartsPrimitive.useYAxisScale()
  const columnTop = (datum: unknown) =>
    stack === undefined || scale === undefined ? undefined : scale(stackTotal(datum, stack))
  return (
    <>
      {variant === "dither" && <DitherSteps id={paint} color={color} />}
      <RechartsPrimitive.Bar
        dataKey={dataKey}
        fill={color}
        isAnimationActive={false}
        activeBar={false}
        shape={(p: BarShape) =>
          variant === "dither" ? (
            <DitherBar {...p} paint={paint} column={columnTop(p.payload)} />
          ) : (
            <SolidBar {...p} top={top} />
          )
        }
        {...(stack === undefined ? {} : { stackId: stack.join("+") })}
        {...props}
      />
    </>
  )
}

/** A rectangle's path with its right corners rounded by `r`. */
const rightRounded = (x: number, y: number, width: number, height: number, r: number) => {
  const radius = Math.max(0, Math.min(r, width, height / 2))
  return `M${x},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height - radius}Q${x + width},${y + height} ${x + width - radius},${y + height}H${x}Z`
}

/** How dense a meter stays at its far end, so its whole length reads. */
const METER_FLOOR = 0.25

/**
 * A bar across, in the house dither: a column on its side, solid at its
 * start and thinning toward its end under a soft cap, over a dotted track
 * in the same color. The thinning runs over the whole track, not the bar,
 * so a short bar stays solid and bars in a list fade alike. `value` is how far it reaches, 0 to 1. It only draws:
 * the figure it stands for belongs beside it, in words.
 */
function ChartMeter({ value, color, className }: { value: number; color: string; className?: string }) {
  const paint = usePaintId("meter")
  const ref = React.useRef<SVGSVGElement>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    setWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const height = 4 * CELL
  const full = Math.floor(width / CELL) * CELL
  const end = value > 0 ? Math.min(full, Math.max(2 * CELL, snap(full * Math.min(1, value)))) : 0
  const bands: Array<{ from: number; to: number; step: number }> = []
  for (let col = 0; col < end; col += CELL) {
    const density = METER_FLOOR + (1 - METER_FLOOR) * (1 - (col + CELL / 2) / full)
    const step = Math.max(0, Math.min(STEPS, Math.round(density * STEPS)))
    const last = bands.at(-1)
    if (last && last.step === step) last.to = col + CELL
    else bands.push({ from: col, to: col + CELL, step })
  }
  const track = end === 0 ? 0 : end + CELL
  return (
    <svg ref={ref} aria-hidden height={height} className={cn("block w-full overflow-visible", className)}>
      <DitherSteps id={paint} color={color} />
      <defs>
        <pattern id={`${paint}-track`} patternUnits="userSpaceOnUse" width={2 * CELL} height={2 * CELL}>
          <rect width={CELL} height={CELL} fill={color} fillOpacity={0.22} shapeRendering="crispEdges" />
        </pattern>
      </defs>
      {full > track && <rect x={track} y={0} width={full - track} height={height} fill={`url(#${paint}-track)`} />}
      {bands.map((band) => (
        <rect
          key={band.from}
          x={band.from}
          y={0}
          width={band.to - band.from}
          height={height}
          fill={`url(#${paint}-${band.step})`}
        />
      ))}
      {end > 0 && <path d={rightRounded(end - CELL / 2, 0, 3, height, 2)} fill={color} fillOpacity={0.9} />}
    </svg>
  )
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const payloadPayload =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string
  }

  return configLabelKey in config ? config[configLabelKey] : config[key]
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartArea,
  ChartLine,
  ChartBar,
  ChartMeter,
  type ChartBarVariant,
}
