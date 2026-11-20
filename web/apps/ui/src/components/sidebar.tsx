// Dashboard navigation and the proxy connection in the shared shadcn sidebar.
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
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react"
import { attentionAtom, pageAtom, prefsAtom, proxyStatusAtom, savePrefs, shownReportAtom } from "../atoms.ts"
import { worstTone } from "../view/attention.ts"
import {
  clampWidth,
  dragSidebar,
  movePage,
  type Page,
  pageHash,
  pageOrder,
  Pages,
  pageTitle,
  samePage,
  sidebarWidth,
} from "../view/pages.ts"
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
  useSidebar,
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
  readonly trailing?: { readonly count: number; readonly tone?: Tone }
  readonly onSelect: (event: MouseEvent<HTMLElement>) => void
}) {
  const Icon = pageIcon(page)
  const selected = samePage(page, current)
  return (
    <SidebarMenuItem data-page={page._tag === "Provider" ? page.provider : page._tag}>
      <SidebarMenuButton
        isActive={selected}
        aria-current={selected ? "page" : undefined}
        render={<a href={pageHash(page)} />}
        onClick={onSelect}
      >
        {page._tag !== "Provider" && <Icon aria-hidden />}
        <span>{pageTitle(page)}</span>
      </SidebarMenuButton>
      {trailing !== undefined && (
        <SidebarMenuBadge>
          {trailing.tone !== undefined && (
            <>
              <Dot tone={trailing.tone} />
              <span className="sr-only">Needs attention</span>
            </>
          )}
          <span className="tabular-nums">{trailing.count}</span>
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
function ProxyFoot({
  address,
  onSelect,
}: {
  readonly address: string
  readonly onSelect: (event: MouseEvent<HTMLElement>) => void
}) {
  const label = useAtomValue(proxyStatusAtom)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          aria-label={`Proxy: ${label.text}`}
          render={<a href={pageHash(Pages.settings)} />}
          onClick={onSelect}
        >
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
  const current = useAtomValue(pageAtom)
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const items = useAtomValue(attentionAtom)
  const save = useAtomSet(savePrefs)
  const { width, setDragged } = useContext(DragContext)
  const list = useRef<HTMLDivElement>(null)
  const order = pageOrder(report)
  const { setOpenMobile } = useSidebar()
  const providers = order.flatMap((page) => (page._tag === "Provider" ? [page] : []))

  const select = (event: MouseEvent<HTMLElement>) => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) setOpenMobile(false)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const active = event.target instanceof HTMLElement ? event.target.closest<HTMLAnchorElement>("a") : null
    const here = order.find((page) => pageHash(page) === active?.hash)
    if (here === undefined) return
    event.preventDefault()
    const next = movePage(order, here, event.key === "ArrowDown" ? 1 : -1)
    list.current?.querySelector<HTMLElement>(`a[href="${pageHash(next)}"]`)?.focus()
  }
  const trailing = (provider: ProviderId) => {
    const tone = worstTone(items, provider)
    const count = report?.accounts.filter((account) => account.provider === provider).length ?? 0
    return { count, ...(tone === undefined ? {} : { tone }) }
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
      edge.removeEventListener("lostpointercapture", end)
      setDragged(undefined)
      save({ sidebarWidth: last.width, sidebarHidden: last.hidden })
    }
    const move = (e: globalThis.PointerEvent) => {
      if ((e.buttons & 1) === 0) return end()
      last = dragSidebar(e.clientX, start)
      if (last.hidden) return end()
      setDragged(last.width)
    }
    edge.addEventListener("pointermove", move)
    edge.addEventListener("pointerup", end)
    edge.addEventListener("lostpointercapture", end)
  }

  return (
    <SidebarRoot aria-label="Sidebar">
      <SidebarHeader>
        <div className="flex h-12 items-center gap-2.5 px-2">
          <Logo />
          <span className="truncate font-heading text-xl font-bold tracking-tight">slopmax</span>
        </div>
      </SidebarHeader>
      <SidebarContent ref={list} id="dashboard-navigation" role="navigation" aria-label="Dashboard" onKeyDown={onKey}>
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
        <Group label="Manage">
          <Row page={Pages.agents} current={current} onSelect={select} />
          <Row page={Pages.access} current={current} onSelect={select} />
          <Row page={Pages.diagnostics} current={current} onSelect={select} />
          <Row page={Pages.settings} current={current} onSelect={select} />
        </Group>
      </SidebarContent>
      <SidebarFooter>
        <ProxyFoot address={address} onSelect={select} />
      </SidebarFooter>
      <div
        role="separator"
        aria-label="Resize navigation"
        aria-controls="dashboard-navigation"
        aria-orientation="vertical"
        aria-valuemin={sidebarWidth.least}
        aria-valuemax={sidebarWidth.most}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          save({
            sidebarWidth: clampWidth(width + (event.key === "ArrowLeft" ? -10 : 10)),
          })
        }}
        className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize focus-visible:rounded-full focus-visible:outline-2 focus-visible:outline-ring md:block"
      />
    </SidebarRoot>
  )
}
