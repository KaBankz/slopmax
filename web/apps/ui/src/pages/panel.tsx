// The menu bar's panel: a small card under the tray icon with how things
// stand, what wants a look, each pool, today, and the app's commands. It
// fits its content's height, telling the desktop's main process as it grows.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Tone } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useRef } from "react"
import {
  attentionAtom,
  canChangeAtom,
  groupsAtom,
  historyAtom,
  openWindow,
  panelHeight,
  proxyAtom,
  quit,
  refresh,
  shownReportAtom,
} from "../atoms.ts"
import { Hours } from "../components/charts.tsx"
import { Dot, Kbd, Label, Logo, SegmentedBar } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { Tip } from "../components/ui/tooltip.tsx"
import { standing } from "../view/attention.ts"
import { requestsLine } from "../view/live.ts"
import { hourly, isQuiet, todayLine } from "../view/usage.ts"
import { resetsLine } from "../view/words.ts"

/** The command key's sign where the app runs: ⌘ on macOS, Ctrl elsewhere. */
const mod = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"

function Part({
  children,
  onOpen,
  label,
}: {
  readonly children: ReactNode
  readonly onOpen?: () => void
  readonly label?: string
}) {
  if (onOpen === undefined)
    return <div className="flex flex-col gap-2 border-t border-separator px-3.5 py-2.5">{children}</div>
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className="flex w-full cursor-default flex-col gap-2 border-t border-separator px-3.5 py-2.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {children}
    </button>
  )
}

function Command({
  title,
  keys,
  onRun,
}: {
  readonly title: string
  readonly keys: string
  readonly onRun: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={title}
      onClick={onRun}
      className="flex h-7 w-full cursor-default items-center justify-between rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:bg-selected"
    >
      <span>{title}</span>
      <Kbd>{keys}</Kbd>
    </button>
  )
}

export function PanelPage() {
  const shown = useAtomValue(shownReportAtom)
  const proxy = useAtomValue(proxyAtom)
  const items = useAtomValue(attentionAtom)
  const all = useAtomValue(groupsAtom)
  const canChange = useAtomValue(canChangeAtom)
  const today = useAtomValue(historyAtom("today"))
  const open = useAtomSet(openWindow)
  const stop = useAtomSet(quit)
  const again = useAtomSet(refresh)
  const fit = useAtomSet(panelHeight)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = root.current
    if (element === null || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => fit(Math.ceil(element.getBoundingClientRect().height)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])

  const report = Option.getOrUndefined(shown)
  const pools = all.filter((g) => g.subscription && g.overview.length > 0)
  const status: { readonly text: string; readonly tone: Tone } =
    proxy._tag === "Running"
      ? report === undefined
        ? { text: "Running", tone: "good" }
        : { text: standing(report).headline, tone: standing(report).tone }
      : proxy._tag === "Stopped"
        ? { text: "The proxy is stopped", tone: "bad" }
        : { text: "Starting the proxy…", tone: "muted" }
  const named = new Set(items.map((item) => item.account))
  const history = AsyncResult.value(today)

  return (
    <div
      ref={root}
      className="flex w-85 flex-col overflow-hidden rounded-2xl border bg-popover text-body shadow-popover"
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <Logo />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold">slopmax</span>
          <span className="truncate text-small">
            <Label tone={status.tone} text={status.text} raw />
          </span>
        </div>
        <Tip content="Refresh usage">
          <Button variant="ghost" size="icon" aria-label="Refresh usage" disabled={!canChange} onClick={() => again()}>
            <RefreshCw />
          </Button>
        </Tip>
      </div>
      {items.length > 0 && (
        <Part onOpen={() => open("overview")} label="Needs attention">
          <span className="text-small font-medium text-muted-foreground">Needs attention</span>
          {items.slice(0, 3).map((item) => (
            <span key={`${item.account}-${item.text}`} className="flex min-w-0 items-center gap-2 text-small">
              <Dot tone={item.tone} />
              <span className="min-w-0 shrink truncate font-medium">{item.who}</span>
              <span className="text-faint">·</span>
              <span className="shrink-0 text-muted-foreground">{item.what}</span>
            </span>
          ))}
          {items.length > 3 && <span className="text-caption text-faint">+{items.length - 3} more</span>}
        </Part>
      )}
      {pools.length === 0 ? (
        <Part>
          <span className="text-small text-muted-foreground">No accounts yet. Open slopmax to add one.</span>
        </Part>
      ) : (
        pools.map((group) => (
          <Part key={group.provider} onOpen={() => open(group.provider)} label={`${group.title} accounts`}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{group.title}</span>
              <span className="text-caption text-muted-foreground">
                {group.ready} of {group.enabled} ready
              </span>
            </span>
            {group.overview.map((window) => (
              <span key={window.title} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2.5">
                  <span className="w-23 shrink-0 truncate text-small text-muted-foreground">{window.title}</span>
                  <span className="min-w-0 flex-1">
                    <SegmentedBar window={window} weighted={group.weighted} />
                  </span>
                  <span className="w-8.5 shrink-0 text-right text-small font-medium tabular">
                    {window.gauge.percent}
                  </span>
                </span>
                <span className="pl-25.5 text-caption text-faint tabular">
                  {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
                </span>
              </span>
            ))}
            {group.rows
              .filter((row) => (row.status.tone === "warn" || row.status.tone === "bad") && !named.has(row.id))
              .map((row) => (
                <span key={row.id} className="flex min-w-0 items-center gap-2 text-small">
                  <span className="min-w-0 truncate">{row.name}</span>
                  <Label tone={row.status.tone} text={row.status.text} />
                </span>
              ))}
            {group.credits !== undefined && <span className="text-small text-muted-foreground">{group.credits}</span>}
            <span className="text-small">
              <Label tone={group.nextShort.tone} text={group.nextShort.text} raw />
            </span>
          </Part>
        ))
      )}
      {Option.isSome(history) && (
        <Part onOpen={() => open("usage")} label="Today's usage">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-medium">Today</span>
            <span className="text-caption text-muted-foreground">{requestsLine(history.value.total.requests)}</span>
          </span>
          {!isQuiet(history.value) && (
            <>
              <span className="text-small text-muted-foreground">{todayLine(history.value)}</span>
              <Hours values={hourly(history.value)} size="sm" />
            </>
          )}
        </Part>
      )}
      <div role="menu" className="flex flex-col border-t border-separator p-1">
        <Command title="Open slopmax" keys={`${mod}O`} onRun={() => open("overview")} />
        <Command title="Settings…" keys={`${mod},`} onRun={() => open("settings")} />
        <Command title="Quit slopmax" keys={`${mod}Q`} onRun={() => stop()} />
      </div>
    </div>
  )
}
