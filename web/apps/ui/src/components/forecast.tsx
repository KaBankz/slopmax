// A pool over time, on the provider page: the forecast card (a window's use
// recorded and projected, and the four figures under it), the resets ahead
// on a lane per account, an account's last day as a strip of half hours,
// and what a window has served. Compositions of Card, ToggleGroup, Tooltip
// and the chart; the numbers come from view/forecast.ts.
import { useAtomValue } from "@effect/atom-react"
import type { PoolDetail, Span, SubscriptionId } from "@slopmax/client"
import { cva } from "class-variance-authority"
import type { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { nowAtom, poolDetailAtom, zone } from "../atoms.ts"
import { type Figure, type Health, laneDays, type Lanes, trendViews } from "../view/forecast.ts"
import type { Group } from "../view/groups.ts"
import { TrendChart } from "./charts.tsx"
import { AccountName } from "./parts.tsx"
import { Segmented } from "./segmented.tsx"
import { Tip } from "./tip.tsx"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card.tsx"

/** The pool's detail once read; nothing while it loads or when the pool has no working account. */
export function usePoolDetail(provider: SubscriptionId): Option.Option<PoolDetail> {
  return AsyncResult.value(useAtomValue(poolDetailAtom(provider)))
}

const figureValue = cva("truncate text-lg font-semibold tabular-nums", {
  variants: {
    tone: { good: "", muted: "", accent: "", warn: "text-warning", bad: "text-destructive" },
  },
})

function FigureCell({ figure }: { readonly figure: Figure }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{figure.title}</span>
      <span className={figureValue({ tone: figure.tone })}>{figure.value}</span>
      <span className="text-xs text-muted-foreground">{figure.detail}</span>
    </div>
  )
}

/** The forecast card: one window at a time, chosen above the chart. */
export function PoolForecast({ group, detail }: { readonly group: Group; readonly detail: PoolDetail }) {
  const now = useAtomValue(nowAtom)
  const names = new Map(group.rows.map((row) => [row.id, row.name]))
  const views = trendViews(detail, names, now, zone)
  const [chosen, choose] = useState<Span>(views.some((view) => view.span === "7d") ? "7d" : "5h")
  const view = views.find((v) => v.span === chosen) ?? views[0]
  if (view === undefined) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {view.title} pool · {view.used} used
        </CardTitle>
        <CardDescription>
          {view.recorded
            ? "Recorded every few minutes, then projected at the recent pace as accounts reset."
            : "slopmax records the pool every few minutes; the line fills in from here."}
        </CardDescription>
        {views.length > 1 && (
          <CardAction>
            <Segmented
              label="Window"
              value={view.span}
              options={views.map((v) => ({ value: v.span, title: v.title }))}
              onChange={choose}
            />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <TrendChart view={view} zone={zone} />
      </CardContent>
      <CardFooter>
        <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 py-1 @3xl:grid-cols-4">
          {view.figures.map((figure) => (
            <FigureCell key={figure.title} figure={figure} />
          ))}
        </div>
      </CardFooter>
    </Card>
  )
}

const markVariants = cva(
  "absolute top-1/2 left-(--at) -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
  {
    variants: {
      span: { "5h": "size-2 bg-muted-foreground", "7d": "size-3 bg-primary", "30d": "size-3 bg-primary" },
    },
  },
)

/** Every account's resets over the next week, a lane each, with the days marked. */
export function ResetLanes({ lanes }: { readonly lanes: Lanes }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Resets ahead</CardTitle>
        <CardDescription>
          The next {laneDays} days. Fill-first spends one account at a time, so resets spread apart keep the pool
          serving.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-3">
            <span className="w-36 shrink-0" />
            <div className="relative h-4 flex-1 text-xs text-muted-foreground">
              {lanes.days.map((day) => (
                <span
                  key={day.offset}
                  className="absolute left-(--at) -translate-x-1/2"
                  style={{ "--at": `${day.offset * 100}%` }}
                >
                  {day.label}
                </span>
              ))}
            </div>
          </div>
          {lanes.lanes.map((lane) => (
            <div key={lane.id} className="flex items-center gap-3">
              <span className="flex w-40 shrink-0 text-sm">
                <AccountName name={lane.name} />
              </span>
              <div className="relative h-7 flex-1 rounded-md bg-muted/60">
                {lanes.days.map((day) => (
                  <span
                    key={day.offset}
                    aria-hidden
                    className="absolute inset-y-1 left-(--at) w-px bg-border"
                    style={{ "--at": `${day.offset * 100}%` }}
                  />
                ))}
                {lane.marks.map((mark) => (
                  <Tip key={`${mark.span}-${mark.at}`} content={mark.tip}>
                    <span
                      role="img"
                      aria-label={mark.tip}
                      className={markVariants({ span: mark.span })}
                      style={{ "--at": `${mark.offset * 100}%` }}
                    />
                  </Tip>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-4 pt-1 pl-39 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-full bg-primary" />
              Weekly reset
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-muted-foreground" />
              5-hour reset
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const cellVariants = cva("h-3 min-w-0 flex-1 rounded-xs", {
  variants: {
    tone: { none: "bg-muted", good: "bg-success/70", warn: "bg-warning", bad: "bg-destructive" },
  },
})

/** An account's last day in half hours: green answered, amber some failed, red mostly failed. */
export function HealthStrip({ health }: { readonly health: Health }) {
  return (
    <Tip content={health.summary}>
      <div role="img" aria-label={health.summary} className="flex w-full max-w-56 gap-px">
        {health.cells.map((cell, i) => (
          <span key={i} className={cellVariants({ tone: cell.tone })} />
        ))}
      </div>
    </Tip>
  )
}
