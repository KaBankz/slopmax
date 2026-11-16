// The sidebar, on shadcn/ui's Sidebar: every page in order, a row per
// provider with accounts, and at its foot how the proxy stands. The arrow
// keys move through the pages while the list has focus; its edge drags to
// resize it, and dragging it far left hides it.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ProviderId, Tone } from "@slopmax/client"
import { Option } from "effect"
import {
  Activity,
  Bot,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Settings,
  Stethoscope,
  Users,
  Zap,
} from "lucide-react"
import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react"
import { attentionAtom, go, prefsAtom, proxyStatusAtom, routeAtom, savePrefs, shownReportAtom } from "../atoms.ts"
import { worstTone } from "../view/attention.ts"
import { clampWidth, dragSidebar, movePage, type Page, pageOrder, Pages, pageTitle, samePage } from "../view/pages.ts"
import { Dot, Logo } from "./parts.tsx"
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
} from "./ui/sidebar.tsx"

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
    <SidebarMenuItem data-page={page._tag === "Provider" ? page.provider : page._tag}>
      <SidebarMenuButton
        isActive={selected}
        aria-current={selected ? "page" : undefined}
        tabIndex={selected ? 0 : -1}
        onPointerDown={() => onSelect(page)}
        onClick={() => onSelect(page)}
      >
        <Icon aria-hidden />
        <span>{pageTitle(page)}</span>
      </SidebarMenuButton>
      {trailing !== undefined && (
        <SidebarMenuBadge>
          {"tone" in trailing ? <Dot tone={trailing.tone} /> : <span className="tabular-nums">{trailing.count}</span>}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

function Group({ label, children }: { readonly label?: string; readonly children: ReactNode }) {
  return (
    <SidebarGroup>
      {label !== undefined && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** How the proxy stands, at the sidebar's foot; it opens Settings. */
function ProxyFoot({ address }: { readonly address: string }) {
  const label = useAtomValue(proxyStatusAtom)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" aria-label={`Proxy: ${label.text}`} onClick={() => go(Pages.settings)}>
          <Dot tone={label.tone === "accent" ? "muted" : label.tone} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{label.text}</span>
            <span className="truncate text-xs text-muted-foreground tabular-nums">{address}</span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** The sidebar's width while its edge is dragged, shared by the frame and the edge. */
const DragContext = createContext<{
  readonly width: number
  readonly setDragged: (width: number | undefined) => void
}>({ width: 0, setDragged: () => {} })

/**
 * The window's frame: shadcn/ui's SidebarProvider, open unless the
 * preferences hide it, as wide as they say (or as the edge is dragged to).
 */
export function SidebarFrame({ onToggle, children }: { readonly onToggle: () => void; readonly children: ReactNode }) {
  const prefs = useAtomValue(prefsAtom)
  const [dragged, setDragged] = useState<number | undefined>(undefined)
  const width = dragged ?? clampWidth(prefs.sidebarWidth)
  return (
    <SidebarProvider
      open={!prefs.sidebarHidden}
      onOpenChange={(open) => {
        if (open === prefs.sidebarHidden) onToggle()
      }}
      style={{ "--sidebar-width": `${width}px` }}
      className="h-full min-h-0"
    >
      <DragContext.Provider value={{ width, setDragged }}>{children}</DragContext.Provider>
    </SidebarProvider>
  )
}

export function Sidebar({ address }: { readonly address: string }) {
  const route = useAtomValue(routeAtom)
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const items = useAtomValue(attentionAtom)
  const save = useAtomSet(savePrefs)
  const { width, setDragged } = useContext(DragContext)
  const list = useRef<HTMLDivElement>(null)
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
    list.current?.querySelector<HTMLElement>(`[data-page="${key}"] [data-sidebar="menu-button"]`)?.focus()
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
    <SidebarRoot aria-label="Sidebar">
      <SidebarHeader className="drag mac:mt-7">
        <div className="flex h-8 items-center gap-2 px-2">
          <Logo />
          <span className="truncate text-sm font-semibold">slopmax</span>
        </div>
      </SidebarHeader>
      <SidebarContent ref={list} onKeyDown={onKey}>
        <Group>
          <Row page={Pages.overview} current={current} onSelect={select} />
        </Group>
        <Group label="Accounts">
          {report === undefined ? (
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          ) : providers.length === 0 ? (
            <SidebarMenuItem>
              <span className="flex h-8 items-center px-2 text-sm text-muted-foreground">None yet</span>
            </SidebarMenuItem>
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
        </Group>
        <Group label="Activity">
          <Row page={Pages.usage} current={current} onSelect={select} />
          <Row page={Pages.performance} current={current} onSelect={select} />
          <Row page={Pages.requests} current={current} onSelect={select} />
        </Group>
        <Group label="Setup">
          <Row page={Pages.agents} current={current} onSelect={select} />
          <Row page={Pages.access} current={current} onSelect={select} />
          <Row page={Pages.diagnostics} current={current} onSelect={select} />
          <Row page={Pages.settings} current={current} onSelect={select} />
        </Group>
      </SidebarContent>
      <SidebarFooter>
        <ProxyFoot address={address} />
      </SidebarFooter>
      <div
        aria-hidden
        onPointerDown={startDrag}
        className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize md:block"
      />
    </SidebarRoot>
  )
}
