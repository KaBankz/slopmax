// The pieces every page is built from, each a composition of shadcn/ui
// components: a tone's dot and label, meters (Progress), the pool's
// segmented bar, panels (Card), sections, rows (Item), figures (Card, with
// a trend line),
// empty states (Empty), placeholders (Skeleton) and failures (Alert).
import type { Tone } from "@slopmax/client"
import { cva } from "class-variance-authority"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import type { LucideIcon } from "lucide-react"
import { CircleAlert } from "lucide-react"
import { type ReactNode, useId } from "react"
import mark from "../logo.svg"
import type { Overview } from "../view/groups.ts"
import type { Change, Stat as StatView } from "../view/usage.ts"
import { failureText, poolBarTip, segmentsShown, sentence, sentenceCase } from "../view/words.ts"
import { Spark } from "./charts.tsx"
import { Tip } from "./tip.tsx"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert.tsx"
import { Button } from "./ui/button.tsx"
import { Card } from "./ui/card.tsx"
import { Empty as EmptyRoot, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx"
import { Progress } from "./ui/progress.tsx"
import { Skeleton as SkeletonBar } from "./ui/skeleton.tsx"

export { Kbd } from "./ui/kbd.tsx"

const dotVariants = cva("inline-block size-1.5 shrink-0 rounded-full", {
  variants: {
    tone: {
      good: "bg-success",
      muted: "bg-muted-foreground",
      accent: "bg-muted-foreground",
      warn: "bg-warning",
      bad: "bg-destructive",
    },
  },
})

export function Dot({ tone }: { readonly tone: Tone }) {
  return <span aria-hidden className={dotVariants({ tone })} />
}

const labelVariants = cva("inline-flex min-w-0 items-center gap-1.5", {
  variants: {
    tone: {
      good: "text-foreground",
      muted: "text-muted-foreground",
      accent: "text-muted-foreground",
      warn: "text-warning",
      bad: "text-destructive",
    },
  },
})

const labelText = cva("", {
  variants: { wrap: { true: "min-w-0", false: "truncate" } },
})

/**
 * Words in a tone: good ones after a green dot, warnings and failures in
 * their color with a dot. One line, cut short where there is no room,
 * unless `wrap` lets it run on.
 */
export function Label({
  tone,
  text,
  raw = false,
  wrap = false,
}: {
  readonly tone: Tone
  readonly text: string
  readonly raw?: boolean
  readonly wrap?: boolean
}) {
  const dotted = tone === "good" || tone === "warn" || tone === "bad"
  const words = raw ? text : sentence(text)
  return (
    <span className={labelVariants({ tone })}>
      {dotted && <Dot tone={tone} />}
      <span className={labelText({ wrap })}>{words}</span>
    </span>
  )
}

/** A Progress tone for a state: warnings and failures in their color, the rest the primary color. */
const meterTone = (tone: Tone): "default" | "warning" | "destructive" =>
  tone === "warn" ? "warning" : tone === "bad" ? "destructive" : "default"

/** A thin Progress bar filled to `fraction`, with a tick where an even spend would have reached. */
export function Meter({
  fraction,
  tone,
  marker,
}: {
  readonly fraction: number
  readonly tone: Tone
  /** Where an even spend would have reached, 0 to 1. */
  readonly marker?: number
}) {
  return (
    <Progress
      aria-hidden
      dither
      value={Math.min(100, Math.max(0, fraction * 100))}
      tone={meterTone(tone)}
      marker={marker === undefined ? undefined : marker * 100}
      className="w-full"
    />
  )
}

const segmentVariants = cva("min-w-1 grow-(--weight) basis-0", {
  variants: { idle: { true: "opacity-40", false: "" } },
})

/**
 * The pool's bar: one segment per account, as wide as its share, each filled
 * to its own use. Past {@link segmentsShown} accounts it is one bar filled to
 * the pool's use, which stays readable however many accounts there are.
 */
export function SegmentedBar({ window, weighted }: { readonly window: Overview; readonly weighted: boolean }) {
  const segments = window.shares
  const label = poolBarTip(segments.length, weighted)
  if (segments.length > segmentsShown) {
    return (
      <div role="img" aria-label={label} className="w-full py-1">
        <Meter fraction={window.gauge.fraction} tone={window.gauge.tone} />
      </div>
    )
  }
  const total = segments.reduce((sum, s) => sum + s.weight, 0)
  return (
    <div role="img" aria-label={label} className="flex w-full items-center gap-1 py-1">
      {segments.map((segment) => (
        <div
          key={segment.id}
          className={segmentVariants({ idle: segment.idle })}
          style={{
            "--weight": String(total > 0 ? Math.max(0.0001, segment.weight / total) : 1),
          }}
        >
          <Meter fraction={segment.fraction} tone={segment.tone} />
        </div>
      ))}
    </div>
  )
}

/** A Card that holds rows edge to edge. */
export function Panel({ children }: { readonly children: ReactNode }) {
  return <Card size="flush">{children}</Card>
}

/** A titled part of a page, with tools at its right. */
export function Section({
  title,
  trailing,
  headingId,
  layout = "stacked",
  children,
}: {
  readonly title: string
  readonly trailing?: ReactNode
  readonly headingId?: string
  readonly layout?: "stacked" | "split"
  readonly children: ReactNode
}) {
  const generatedHeading = useId()
  const id = headingId ?? generatedHeading
  return (
    <section
      aria-labelledby={id}
      data-layout={layout}
      className="flex min-w-0 flex-col gap-3 @4xl:data-[layout=split]:grid @4xl:data-[layout=split]:grid-cols-[minmax(10rem,1fr)_minmax(0,3.5fr)] @4xl:data-[layout=split]:items-start @4xl:data-[layout=split]:gap-x-8"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2
          id={id}
          tabIndex={headingId === undefined ? undefined : -1}
          className="scroll-mt-5 rounded-sm font-heading text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {title}
        </h2>
        {trailing}
      </div>
      {layout === "split" ? <div className="min-w-0">{children}</div> : children}
    </section>
  )
}

/** A row in a Panel: a rule above all but the first. */
export function Row({ children }: { readonly children: ReactNode }) {
  return <div className="flex items-center gap-4 border-t px-4 py-3 text-sm first:border-t-0">{children}</div>
}

/** A setting: an Item with its title over what it does, its control at the right. */
export function SettingRow({
  title,
  detail,
  children,
}: {
  readonly title: string
  readonly detail?: ReactNode
  readonly children?: ReactNode
}) {
  return (
    <div className="border-t first:border-t-0">
      <Item size="row">
        {/* At least this wide, so in a narrow window the controls take the next line rather than squeeze the words. */}
        <ItemContent className="min-w-0 basis-48">
          <ItemTitle>{title}</ItemTitle>
          {detail !== undefined && <ItemDescription>{detail}</ItemDescription>}
        </ItemContent>
        {children !== undefined && <ItemActions>{children}</ItemActions>}
      </Item>
    </div>
  )
}

/**
 * An account's name in a narrow column: the address gives way first, so a
 * label that tells two logins of one address apart (`a@b.dev (Work)`) stays.
 */
export function AccountName({ name }: { readonly name: string }) {
  const parts = /^(.*\S)\s+(\([^()]*\))$/.exec(name)
  if (parts === null)
    return (
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
    )
  // The label shrinks only once the address is gone, and even then stays inside the column.
  return (
    <span className="flex min-w-0" title={name}>
      <span className="truncate">{parts[1]}</span>
      <span className="max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-pre"> {parts[2]}</span>
    </span>
  )
}

/** A comparison with the previous value available from pointer or keyboard focus. */
export function StatChange({ change }: { readonly change: Change }) {
  return (
    <Tip content={change.tip}>
      <span tabIndex={0} aria-description={change.tip} className="font-medium tabular-nums">
        {change.direction === "flat" ? "Steady" : `${change.direction === "up" ? "Up" : "Down"} ${change.text}`}{" "}
        {change.versus}
      </span>
    </Tip>
  )
}

const sparkInks = ["spark-1", "spark-2", "spark-3", "spark-4"] as const

/** A group of comparable figures on a single surface, with their dithered trends. */
export function Stats({ stats }: { readonly stats: ReadonlyArray<StatView> }) {
  return (
    <Panel>
      <dl className="grid grid-cols-1 gap-px bg-border @lg:grid-cols-2 @4xl:grid-cols-4">
        {stats.map(({ title, value, note, change, trend }) => (
          <div key={title} className="flex min-w-0 flex-col gap-2.5 bg-card p-5 sm:p-6">
            <dt className="text-sm font-medium text-muted-foreground">{title}</dt>
            <dd className="font-heading text-3xl leading-none font-semibold tracking-tight tabular-nums">{value}</dd>
            <dd className="flex flex-1 flex-col justify-between gap-3 text-xs">
              <div className="space-y-1">
                {change !== undefined && (
                  <p>
                    <StatChange change={change} />
                  </p>
                )}
                <p className="text-muted-foreground">{note}</p>
              </div>
              {trend !== undefined && <Spark points={trend.points} ink={sparkInks[trend.series - 1] ?? "meter"} />}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** Nothing to show yet: what the page will hold, and how to get there. */
export function Empty({
  title,
  detail,
  icon: Icon,
  children,
}: {
  readonly title: string
  readonly detail: string
  readonly icon?: LucideIcon
  readonly children?: ReactNode
}) {
  return (
    <EmptyRoot>
      <EmptyHeader>
        {Icon !== undefined && (
          <EmptyMedia variant="icon">
            <Icon aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      {children !== undefined && (
        <EmptyContent>
          <div className="flex gap-2">{children}</div>
        </EmptyContent>
      )}
    </EmptyRoot>
  )
}

/** A placeholder shaped like content, while it loads. */
export function Skeleton({ lines = 3 }: { readonly lines?: number }) {
  return (
    <Card aria-hidden>
      <div className="flex flex-col gap-3 px-4">
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonBar key={i} className="h-4 first:w-1/3 last:w-2/3" />
        ))}
      </div>
    </Card>
  )
}

/** The option-key mark, sized consistently for the masthead and gate. */
export function Logo({ size = "md" }: { readonly size?: "md" | "lg" }) {
  const pixels = size === "lg" ? 36 : 20
  return <img src={mark} alt="" width={pixels} height={pixels} className="shrink-0" />
}

/** What went wrong reading something, with a way to try again: a destructive Alert. */
export function Failed({
  title,
  detail,
  onRetry,
}: {
  readonly title: string
  readonly detail: string
  readonly onRetry?: () => void
}) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{sentenceCase(detail)}</AlertDescription>
      {onRetry !== undefined && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

/**
 * Something the API answers: its content once there (kept while it is read
 * again), a placeholder until then, and what went wrong if it could not be read.
 */
export function Loaded<A, E>({
  result,
  title = "Could not read it",
  loading,
  onRetry,
  children,
}: {
  readonly result: AsyncResult.AsyncResult<A, E>
  readonly title?: string
  readonly loading?: ReactNode
  readonly onRetry?: () => void
  readonly children: (value: A) => ReactNode
}) {
  const value = AsyncResult.value(result)
  if (Option.isSome(value)) return <>{children(value.value)}</>
  if (AsyncResult.isFailure(result)) {
    return <Failed title={title} detail={failureText(result.cause)} {...(onRetry === undefined ? {} : { onRetry })} />
  }
  return <>{loading ?? <Skeleton />}</>
}
