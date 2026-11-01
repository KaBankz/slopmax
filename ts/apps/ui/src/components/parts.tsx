// The pieces every page is built from: a tone's dot and label, meters, the
// pool's segmented bar, panels, sections, rows, figures, and empty states.
import type { Tone } from "@slopmax/domain"
import { cva } from "class-variance-authority"
import { Option } from "effect"
import type { LucideIcon } from "lucide-react"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { pct } from "../lib/style.ts"
import type { Overview } from "../view/groups.ts"
import { capitalize, failureText, poolBarTip, segmentsShown, sentence } from "../view/words.ts"
import { Button } from "./ui/button.tsx"
import { Tip } from "./ui/tooltip.tsx"

const dotVariants = cva("inline-block size-1.5 shrink-0 rounded-full", {
  variants: {
    tone: {
      good: "bg-success",
      muted: "bg-faint",
      accent: "bg-faint",
      warn: "bg-warning",
      bad: "bg-danger",
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
      bad: "text-danger",
    },
  },
})

const labelText = cva("", { variants: { wrap: { true: "min-w-0", false: "truncate" } } })

/**
 * Words in a tone: good ones after a green dot, warnings and failures in
 * their color with a dot. One line, cut short where there is no room,
 * unless `wrap` lets it run on (and shows the whole of it on hover either way).
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
    <span className={labelVariants({ tone })} title={words}>
      {dotted && <Dot tone={tone} />}
      <span className={labelText({ wrap })}>{words}</span>
    </span>
  )
}

const fillVariants = cva("absolute inset-y-0 left-0 w-(--fill) min-w-0.5 rounded-xs", {
  variants: {
    tone: {
      good: "bg-meter",
      muted: "bg-meter",
      accent: "bg-meter",
      warn: "bg-warning",
      bad: "bg-danger",
    },
  },
})

/** A 4-tall bar filled to `fraction`; warnings and failures in their color, the rest neutral. */
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
    <div
      className="relative h-1 w-full rounded-xs bg-track"
      style={{ "--fill": pct(fraction), "--at": pct(marker ?? 0) }}
    >
      {fraction > 0 && <div className={fillVariants({ tone })} />}
      {marker !== undefined && (
        <div
          aria-hidden
          className="absolute -top-1 left-(--at) h-3 w-0.5 -translate-x-1/2 rounded-xs bg-muted-foreground"
        />
      )}
    </div>
  )
}

const segmentVariants = cva("h-1 min-w-1 grow-(--weight) basis-0", {
  variants: { idle: { true: "opacity-40", false: "" } },
})

/**
 * The pool's bar: one segment per account, as wide as its share, each filled
 * to its own use. Past {@link segmentsShown} accounts it is one bar filled to
 * the pool's use, which stays readable however many accounts there are.
 */
export function SegmentedBar({ window, weighted }: { readonly window: Overview; readonly weighted: boolean }) {
  const segments = window.shares
  const tip = poolBarTip(segments.length, weighted)
  if (segments.length > segmentsShown) {
    return (
      <Tip content={tip}>
        <div className="w-full py-1">
          <Meter fraction={window.gauge.fraction} tone={window.gauge.tone} />
        </div>
      </Tip>
    )
  }
  const total = segments.reduce((sum, s) => sum + s.weight, 0)
  return (
    <Tip content={tip}>
      <div className="flex w-full items-center gap-1 py-1">
        {segments.map((segment) => (
          <div
            key={segment.id}
            className={segmentVariants({ idle: segment.idle })}
            style={{ "--weight": String(total > 0 ? Math.max(0.0001, segment.weight / total) : 1) }}
          >
            <Meter fraction={segment.fraction} tone={segment.tone} />
          </div>
        ))}
      </div>
    </Tip>
  )
}

/** A bordered card on the page's background. */
export function Panel({ children }: { readonly children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border bg-background">{children}</div>
}

/** A titled part of a page, with tools at its right. */
export function Section({
  title,
  trailing,
  children,
}: {
  readonly title: string
  readonly trailing?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-heading font-semibold">{title}</h2>
        {trailing}
      </div>
      {children}
    </section>
  )
}

/** A row in a panel: a hairline above all but the first. */
export function Row({ children }: { readonly children: ReactNode }) {
  return <div className="flex items-center gap-4 border-t border-separator px-4 py-3 first:border-t-0">{children}</div>
}

/** A setting: its title over what it does, its control at the right. */
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
    <div className="flex min-h-14 items-center gap-4 border-t border-separator px-4 py-3 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="font-medium">{title}</div>
        {detail !== undefined && <div className="text-small text-muted-foreground">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

/** A figure: its caption, the number, and a faint note. */
export function Stat({
  title,
  value,
  note,
}: {
  readonly title: string
  readonly value: string
  readonly note: string
}) {
  return (
    <div className="flex min-w-32 flex-1 flex-col gap-1 border-l border-separator px-4 py-3.5 first:border-l-0">
      <div className="text-small text-muted-foreground">{title}</div>
      <div className="text-figure font-semibold tabular">{value}</div>
      <div className="truncate text-caption text-faint">{note}</div>
    </div>
  )
}

/** Figures side by side in one panel. */
export function Stats({
  stats,
}: {
  readonly stats: ReadonlyArray<{ readonly title: string; readonly value: string; readonly note: string }>
}) {
  return (
    <Panel>
      <div className="flex flex-wrap">
        {stats.map((stat) => (
          <Stat key={stat.title} {...stat} />
        ))}
      </div>
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
    <Panel>
      <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        {Icon !== undefined && (
          <span className="mb-1.5 flex size-9 items-center justify-center rounded-full bg-well text-muted-foreground">
            <Icon aria-hidden className="size-4.5" />
          </span>
        )}
        <div className="font-medium">{title}</div>
        <div className="max-w-md text-small text-muted-foreground">{detail}</div>
        {children !== undefined && <div className="mt-3 flex gap-2">{children}</div>}
      </div>
    </Panel>
  )
}

/** A placeholder shaped like content, while it loads. */
export function Skeleton({ lines = 3 }: { readonly lines?: number }) {
  return (
    <Panel>
      <div aria-hidden className="flex flex-col gap-3 p-4">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="h-3 animate-pulse rounded-sm bg-track first:w-1/3 last:w-2/3" />
        ))}
      </div>
    </Panel>
  )
}

/** slopmax's logo: a pink tile with three rising bars. */
export function Logo({ size = "md" }: { readonly size?: "sm" | "md" | "lg" }) {
  const box = size === "sm" ? "size-4" : size === "md" ? "size-5" : "size-10"
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={box}>
      <rect width="64" height="64" rx="14" className="fill-brand" />
      <rect x="14" y="34" width="9" height="16" rx="2" className="fill-brand-foreground" />
      <rect x="27.5" y="24" width="9" height="26" rx="2" className="fill-brand-foreground" />
      <rect x="41" y="14" width="9" height="36" rx="2" className="fill-brand-foreground" />
    </svg>
  )
}

/** A keyboard shortcut, faint. */
export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="font-sans text-caption text-faint">{children}</kbd>
}

/** What went wrong reading something, with a way to try again. */
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
    <Panel>
      <div role="alert" className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        <div className="font-medium text-danger">{title}</div>
        <div className="max-w-md text-small text-muted-foreground">{capitalize(detail)}</div>
        {onRetry !== undefined && (
          <div className="mt-3">
            <Button onClick={onRetry}>Try again</Button>
          </div>
        )}
      </div>
    </Panel>
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
