// The sidebar: every page in order, a row per provider with accounts, and at
// its foot how the proxy stands. The arrow keys move through the pages while
// the list has focus; its edge drags to resize it, and dragging it far left
// hides it.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ProviderId, Tone } from "@slopmax/domain"
import { cva } from "class-variance-authority"
import { Option } from "effect"
import {
  Activity,
  Bot,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  PanelLeft,
  Settings,
  Stethoscope,
  Users,
  Zap,
} from "lucide-react"
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react"
import { hostAtom } from "../api.ts"
import {
  attentionAtom,
  go,
  liveAtom,
  prefsAtom,
  proxyAtom,
  routeAtom,
  savePrefs,
  shownReportAtom,
  sidebarInstantAtom,
} from "../atoms.ts"
import { worstTone } from "../view/attention.ts"
import { proxyLabel } from "../view/live.ts"
import { clampWidth, dragSidebar, movePage, type Page, pageOrder, Pages, pageTitle, samePage } from "../view/pages.ts"
import { Dot, Logo } from "./parts.tsx"
import { Button } from "./ui/button.tsx"
import { Tip } from "./ui/tooltip.tsx"

const icons: { readonly [K in Page["_tag"]]: LucideIcon } = {
  Overview: LayoutDashboard,
  Provider: Users,
  Usage: ChartColumn,
  Performance: Zap,
  Requests: Activity,
  Agents: Bot,
  Access: KeyRound,
  Diagnostics: Stethoscope,
  Settings,
}

export const pageIcon = (page: Page): LucideIcon => icons[page._tag]

const rowVariants = cva(
  "flex h-7.5 w-full shrink-0 cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-body outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      selected: {
        true: "bg-selected font-medium text-foreground",
        false: "text-muted-foreground hover:bg-hover hover:text-foreground",
      },
    },
  },
)

function Heading({ children }: { readonly children: string }) {
  return <div className="shrink-0 px-2.5 pt-4 pb-1 text-small font-medium text-faint">{children}</div>
}

function Row({
  page,
  current,
  trailing,
  onSelect,
}: {
  readonly page: Page
  readonly current: Page
  readonly trailing?: { readonly tone: Tone } | { readonly count: number }
  readonly onSelect: (page: Page) => void
}) {
  const Icon = pageIcon(page)
  const selected = samePage(page, current)
  return (
    <button
      type="button"
      data-page={page._tag === "Provider" ? page.provider : page._tag}
      aria-current={selected ? "page" : undefined}
      tabIndex={selected ? 0 : -1}
      className={rowVariants({ selected })}
      onPointerDown={() => onSelect(page)}
      onClick={() => onSelect(page)}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{pageTitle(page)}</span>
      {trailing !== undefined &&
        ("tone" in trailing ? (
          <Dot tone={trailing.tone} />
        ) : (
          <span className="text-caption text-faint tabular">{trailing.count}</span>
        ))}
    </button>
  )
}

/** How the proxy stands, at the sidebar's foot; it opens Settings. */
function ProxyFoot({ address }: { readonly address: string }) {
  const host = useAtomValue(hostAtom)
  const live = useAtomValue(liveAtom)
  const proxy = useAtomValue(proxyAtom)
  const web = Option.isSome(host) && host.value.kind === "web"
  // The web dashboard can only tell whether its stream is up.
  const label =
    web && live._tag === "Reconnecting"
      ? { text: "Reconnecting…", tone: "warn" as const }
      : web && live._tag === "Connecting"
        ? { text: "Connecting…", tone: "muted" as const }
        : proxyLabel(proxy)
  return (
    <button
      type="button"
      aria-label={`Proxy: ${label.text}`}
      onClick={() => go(Pages.settings)}
      className="flex w-full cursor-default items-center gap-2.5 border-t border-separator px-4 py-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <Dot tone={label.tone === "accent" ? "muted" : label.tone} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-small font-medium">{label.text}</span>
        <span className="truncate text-caption text-faint tabular">{address}</span>
      </span>
    </button>
  )
}

const paneVariants = cva("h-full shrink-0 overflow-hidden border-r border-border w-(--shown)", {
  variants: { instant: { true: "", false: "slide" }, hidden: { true: "border-r-0", false: "" } },
})

export function Sidebar({ address, onToggle }: { readonly address: string; readonly onToggle: () => void }) {
  const route = useAtomValue(routeAtom)
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const items = useAtomValue(attentionAtom)
  const prefs = useAtomValue(prefsAtom)
  const save = useAtomSet(savePrefs)
  const instant = useAtomValue(sidebarInstantAtom)
  const list = useRef<HTMLDivElement>(null)
  const [dragged, setDragged] = useState<number | undefined>(undefined)
  const width = dragged ?? clampWidth(prefs.sidebarWidth)
  const current = route._tag === "Page" ? route.page : Pages.overview
  const order = pageOrder(report)
  const providers = order.flatMap((page) => (page._tag === "Provider" ? [page] : []))

  const select = (page: Page) => {
    if (!samePage(page, current)) go(page)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const next = movePage(order, current, event.key === "ArrowDown" ? 1 : -1)
    select(next)
    const key = next._tag === "Provider" ? next.provider : next._tag
    list.current?.querySelector<HTMLElement>(`[data-page="${key}"]`)?.focus()
  }
  const trailing = (provider: ProviderId) => {
    const tone = worstTone(items, provider)
    if (tone !== undefined) return { tone }
    return { count: report?.accounts.filter((a) => a.provider === provider).length ?? 0 }
  }

  // Dragging the edge: the pointer's x sets the width; far enough left hides the sidebar.
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = width
    const edge = event.currentTarget
    edge.setPointerCapture(event.pointerId)
    let last = { hidden: false, width: start }
    const end = () => {
      edge.removeEventListener("pointermove", move)
      edge.removeEventListener("pointerup", end)
      setDragged(undefined)
      save({ sidebarWidth: last.width, sidebarHidden: last.hidden })
    }
    const move = (e: globalThis.PointerEvent) => {
      if ((e.buttons & 1) === 0) return end()
      last = dragSidebar({ hidden: false, width: start, instant: true }, e.clientX, start)
      if (last.hidden) return end()
      setDragged(last.width)
    }
    edge.addEventListener("pointermove", move)
    edge.addEventListener("pointerup", end)
  }

  return (
    <div
      className={paneVariants({ instant: instant || dragged !== undefined, hidden: prefs.sidebarHidden })}
      style={{ "--shown": prefs.sidebarHidden ? "0px" : `${width}px`, "--sidebar": `${width}px` }}
    >
      <nav
        aria-label="Sidebar"
        inert={prefs.sidebarHidden}
        className="relative flex h-full w-(--sidebar) flex-col bg-sidebar"
      >
        <div className="drag flex h-13 shrink-0 items-center gap-2 pr-2 pl-4 mac:pl-22">
          <Logo />
          <span className="min-w-0 flex-1 truncate text-body font-semibold">slopmax</span>
          <Tip content="Hide Sidebar">
            <Button variant="ghost" size="icon" aria-label="Hide Sidebar" className="no-drag" onClick={onToggle}>
              <PanelLeft />
            </Button>
          </Tip>
        </div>
        <div
          ref={list}
          role="list"
          onKeyDown={onKey}
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3"
        >
          <Row page={Pages.overview} current={current} onSelect={select} />
          <Heading>Accounts</Heading>
          {report === undefined ? (
            <div aria-hidden className="flex h-7.5 shrink-0 items-center px-2.5">
              <div className="h-3 w-24 animate-pulse rounded-sm bg-track" />
            </div>
          ) : providers.length === 0 ? (
            <div className="flex h-7.5 shrink-0 items-center px-2.5 text-body text-faint">None yet</div>
          ) : (
            providers.map((page) => (
              <Row
                key={page.provider}
                page={page}
                current={current}
                onSelect={select}
                trailing={trailing(page.provider)}
              />
            ))
          )}
          <Heading>Activity</Heading>
          <Row page={Pages.usage} current={current} onSelect={select} />
          <Row page={Pages.performance} current={current} onSelect={select} />
          <Row page={Pages.requests} current={current} onSelect={select} />
          <Heading>Setup</Heading>
          <Row page={Pages.agents} current={current} onSelect={select} />
          <Row page={Pages.access} current={current} onSelect={select} />
          <Row page={Pages.diagnostics} current={current} onSelect={select} />
          <Row page={Pages.settings} current={current} onSelect={select} />
        </div>
        <ProxyFoot address={address} />
        <div
          aria-hidden
          onPointerDown={startDrag}
          className="absolute inset-y-0 -right-0.75 z-10 w-1.5 cursor-col-resize"
        />
      </nav>
    </div>
  )
}
