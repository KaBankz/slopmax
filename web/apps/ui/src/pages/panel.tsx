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
import { Card } from "../components/ui/card.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item.tsx"
import { Separator } from "../components/ui/separator.tsx"
import { Tip } from "../components/tip.tsx"
import { standing } from "../view/attention.ts"
import { requestsLine } from "../view/live.ts"
import { hourly, isQuiet, todayLine } from "../view/usage.ts"
import { resetsLine } from "../view/words.ts"

/** The command key's sign where the app runs: ⌘ on macOS, Ctrl elsewhere. */
const mod = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"

/**
 * A part of the panel under a rule: an Item, a button when it opens a window.
 * Item lights only links on hover, so a wrapper lights the button edge to edge.
 */
function Part({
  children,
  onOpen,
  label,
}: {
  readonly children: ReactNode
  readonly onOpen?: () => void
  readonly label?: string
}) {
  return (
    <>
      <Separator />
      {onOpen === undefined ? (
        <Item>
          <ItemContent>{children}</ItemContent>
        </Item>
      ) : (
        <div className="hover:bg-accent">
          <Item render={<button type="button" />} aria-label={label} onClick={onOpen}>
            <ItemContent className="text-left">{children}</ItemContent>
          </Item>
        </div>
      )}
    </>
  )
}

/** One of the app's commands at the panel's foot, with its shortcut. */
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
    <Button variant="ghost" role="menuitem" aria-label={title} onClick={onRun} className="w-full justify-between">
      <span>{title}</span>
      <Kbd>{keys}</Kbd>
    </Button>
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
    <Card ref={root} size="flush" className="w-85">
      <Item>
        <ItemMedia>
          <Logo />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>slopmax</ItemTitle>
          <span className="truncate text-xs">
            <Label tone={status.tone} text={status.text} raw />
          </span>
        </ItemContent>
        <ItemActions>
          <Tip content="Refresh usage">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh usage"
              disabled={!canChange}
              onClick={() => again()}
            >
              <RefreshCw />
            </Button>
          </Tip>
        </ItemActions>
      </Item>
      {items.length > 0 && (
        <Part onOpen={() => open("overview")} label="Needs attention">
          <span className="text-xs font-medium text-muted-foreground">Needs attention</span>
          {items.slice(0, 3).map((item) => (
            <span key={`${item.account}-${item.text}`} className="flex min-w-0 items-center gap-2 text-xs">
              <Dot tone={item.tone} />
              <span className="min-w-0 shrink truncate font-medium">{item.who}</span>
              <span className="text-muted-foreground">·</span>
              <span className="shrink-0 text-muted-foreground">{item.what}</span>
            </span>
          ))}
          {items.length > 3 && <span className="text-xs text-muted-foreground">+{items.length - 3} more</span>}
        </Part>
      )}
      {pools.length === 0 ? (
        <Part>
          <ItemDescription>No accounts yet. Open slopmax to add one.</ItemDescription>
        </Part>
      ) : (
        pools.map((group) => (
          <Part key={group.provider} onOpen={() => open(group.provider)} label={`${group.title} accounts`}>
            <span className="flex items-baseline justify-between gap-2">
              <ItemTitle>{group.title}</ItemTitle>
              <span className="text-xs text-muted-foreground">
                {group.ready} of {group.enabled} ready
              </span>
            </span>
            {group.overview.map((window) => (
              <span key={window.title} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2.5">
                  <span className="w-23 shrink-0 truncate text-xs text-muted-foreground">{window.title}</span>
                  <span className="min-w-0 flex-1">
                    <SegmentedBar window={window} weighted={group.weighted} />
                  </span>
                  <span className="w-8.5 shrink-0 text-right text-xs font-medium tabular-nums">
                    {window.gauge.percent}
                  </span>
                </span>
                <span className="pl-25.5 text-xs text-muted-foreground tabular-nums">
                  {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
                </span>
              </span>
            ))}
            {group.rows
              .filter((row) => (row.status.tone === "warn" || row.status.tone === "bad") && !named.has(row.id))
              .map((row) => (
                <span key={row.id} className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="min-w-0 truncate">{row.name}</span>
                  <Label tone={row.status.tone} text={row.status.text} />
                </span>
              ))}
            {group.credits !== undefined && <span className="text-xs text-muted-foreground">{group.credits}</span>}
            <span className="text-xs">
              <Label tone={group.nextShort.tone} text={group.nextShort.text} raw />
            </span>
          </Part>
        ))
      )}
      {Option.isSome(history) && (
        <Part onOpen={() => open("usage")} label="Today's usage">
          <span className="flex items-baseline justify-between gap-2">
            <ItemTitle>Today</ItemTitle>
            <span className="text-xs text-muted-foreground">{requestsLine(history.value.total.requests)}</span>
          </span>
          {!isQuiet(history.value) && (
            <>
              <span className="text-xs text-muted-foreground">{todayLine(history.value)}</span>
              <Hours values={hourly(history.value)} size="sm" />
            </>
          )}
        </Part>
      )}
      <Separator />
      <div role="menu" className="flex flex-col p-1">
        <Command title="Open slopmax" keys={`${mod}O`} onRun={() => open("overview")} />
        <Command title="Settings…" keys={`${mod},`} onRun={() => open("settings")} />
        <Command title="Quit slopmax" keys={`${mod}Q`} onRun={() => stop()} />
      </div>
    </Card>
  )
}
