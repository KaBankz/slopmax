// The dashboard rail and the links local to a workspace.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { providerTitle } from "@slopmax/client/format"
import {
  ArrowDown,
  ArrowLeft,
  ChartNoAxesCombined,
  ChevronRight,
  Gauge,
  List,
  Plug,
  Settings,
  UsersRound,
} from "lucide-react"
import { createContext, type MouseEvent, type PointerEvent, type ReactNode, useContext, useRef, useState } from "react"
import { prefsAtom, proxyStatusAtom, savePrefs } from "../atoms.ts"
import { type ConnectionSection, destinationOf, navigationGroups, type Page, pageHash, Pages } from "../view/pages.ts"
import { Dot, Logo } from "./parts.tsx"
import { ButtonLink } from "./ui/button.tsx"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar.tsx"

const icons = {
  quota: Gauge,
  accounts: UsersRound,
  analytics: ChartNoAxesCombined,
  requests: List,
  connections: Plug,
  settings: Settings,
}

const sidebarBounds = { min: 192, max: 304 }

function followsLink(event: MouseEvent<HTMLElement>): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

export function focusConnectionSection(section: ConnectionSection): boolean {
  const heading = document.getElementById(`connection-${section}`)
  if (heading === null) return false
  heading.scrollIntoView({ block: "start" })
  heading.focus({ preventScroll: true })
  return true
}

const clampWidth = (width: number) => Math.max(sidebarBounds.min, Math.min(sidebarBounds.max, width))
const WidthContext = createContext({
  width: 224,
  previewWidth: (_width: number | undefined) => {},
})

export function SidebarFrame({ children }: { readonly children: ReactNode }) {
  const prefs = useAtomValue(prefsAtom)
  const save = useAtomSet(savePrefs)
  const [dragged, previewWidth] = useState<number>()
  const width = clampWidth(dragged ?? prefs.sidebarWidth)
  return (
    <SidebarProvider
      open={!prefs.sidebarHidden}
      data-resizing={dragged !== undefined || undefined}
      onOpenChange={(open) => save({ sidebarHidden: !open })}
      style={{ "--sidebar-width": `${width}px` }}
      className="h-full min-h-0"
    >
      <WidthContext.Provider value={{ width, previewWidth }}>{children}</WidthContext.Provider>
    </SidebarProvider>
  )
}

function ResizeHandle() {
  const { width, previewWidth } = useContext(WidthContext)
  const save = useAtomSet(savePrefs)
  const start = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const origin = event.clientX
    let candidate = width
    const move = (pointer: globalThis.PointerEvent) => {
      candidate = clampWidth(width + pointer.clientX - origin)
      previewWidth(candidate)
    }
    const finish = () => {
      handle.removeEventListener("pointermove", move)
      previewWidth(undefined)
      if (candidate !== width) save({ sidebarWidth: candidate })
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("lostpointercapture", finish, { once: true })
  }
  return (
    <div
      role="separator"
      aria-label="Resize navigation"
      aria-orientation="vertical"
      aria-valuemin={sidebarBounds.min}
      aria-valuemax={sidebarBounds.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        save({
          sidebarWidth: clampWidth(width + (event.key === "ArrowLeft" ? -8 : 8)),
        })
      }}
      className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none focus-visible:outline-2 focus-visible:outline-ring md:block"
    />
  )
}

function SidebarBrand({ onHome }: { readonly onHome?: (event: MouseEvent<HTMLElement>) => void }) {
  const { isMobile } = useSidebar()
  return (
    <div data-slot="sidebar-brand" className="flex min-w-0 items-center justify-between gap-2">
      <a
        data-slot="sidebar-home"
        href={pageHash(Pages.overview)}
        onClick={onHome}
        className="flex h-10 min-w-0 items-center gap-2.5 rounded-md px-2 text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="slopmax home"
      >
        <Logo />
        slopmax
      </a>
      <SidebarTrigger size={isMobile ? "icon-lg" : "icon"} />
    </div>
  )
}

/** The brand row used on phones and when the desktop sidebar is collapsed. */
export function SidebarBrandBar() {
  const { open, isMobile } = useSidebar()
  if (open && !isMobile) return null
  return (
    <div data-sidebar-reveal className="shrink-0 border-b bg-sidebar py-0.5">
      <div className="workspace-width">
        <SidebarBrand />
      </div>
    </div>
  )
}

export function DashboardSidebar({ page }: { readonly page: Page }) {
  const active = destinationOf(page)
  const status = useAtomValue(proxyStatusAtom)
  const { openMobile, setOpenMobile } = useSidebar()
  const closingForNavigation = useRef(false)
  const follow = (event: MouseEvent<HTMLElement>) => {
    if (!openMobile || !followsLink(event)) return
    closingForNavigation.current = true
    setOpenMobile(false)
  }
  return (
    <Sidebar
      mobileFinalFocus={() => {
        const selector = closingForNavigation.current
          ? "#dashboard-title"
          : '[data-sidebar-reveal] [data-slot="sidebar-trigger"]'
        closingForNavigation.current = false
        return document.querySelector<HTMLElement>(selector) ?? false
      }}
    >
      <SidebarHeader>
        <SidebarBrand onHome={follow} />
      </SidebarHeader>
      <SidebarContent aria-label="Dashboard">
        {navigationGroups.map(({ label, entries }) => (
          <SidebarGroup key={label}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {entries.map(({ id, label: title, page: target }) => {
                  const Icon = icons[id]
                  const current = pageHash(page) === pageHash(target)
                  return (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton
                        isActive={active === id}
                        aria-current={current ? "page" : active === id ? "location" : undefined}
                        render={<a href={pageHash(target)} />}
                        onClick={follow}
                      >
                        <Icon aria-hidden />
                        <span>{title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="border-t px-1 pt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                isActive={active === "diagnostics"}
                aria-current={active === "diagnostics" ? "page" : undefined}
                aria-label={`Diagnostics · ${status.text}`}
                render={<a href={pageHash(Pages.diagnostics)} />}
                onClick={follow}
              >
                <Dot tone={status.tone} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>Diagnostics</span>
                  <span className="truncate text-xs text-muted-foreground tabular-nums group-data-[active]/menu-button:text-sidebar-accent-foreground">
                    {status.text}
                  </span>
                </span>
                <ChevronRight aria-hidden />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarFooter>
      <ResizeHandle />
    </Sidebar>
  )
}

export function SectionNavigation({ page }: { readonly page: Page }) {
  if (page._tag === "Provider" || page._tag === "AddAccount") {
    const provider = page._tag === "AddAccount" ? page.provider : undefined
    return (
      <ButtonLink
        href={pageHash(provider === undefined ? Pages.accounts : Pages.provider(provider))}
        variant="link"
        size="sm"
        className="w-fit"
      >
        <ArrowLeft aria-hidden />
        {provider === undefined ? "All accounts" : `Back to ${providerTitle(provider)}`}
      </ButtonLink>
    )
  }
  const destination = destinationOf(page)
  if (destination !== "quota" && destination !== "analytics" && destination !== "connections") return null
  const links =
    destination === "quota"
      ? [
          { page: Pages.overview, label: "Upcoming resets" },
          { page: Pages.quotaHistory, label: "Past resets" },
        ]
      : destination === "analytics"
        ? [
            { page: Pages.usage, label: "Usage" },
            { page: Pages.performance, label: "Performance" },
          ]
        : [
            { page: Pages.connections("agents"), label: "Coding agents" },
            { page: Pages.connections("clients"), label: "Client keys" },
            { page: Pages.connections("machines"), label: "Other machines" },
          ]
  const current = page._tag === "Connections" ? pageHash(Pages.connections(page.section ?? "agents")) : pageHash(page)
  return (
    <nav
      aria-label={
        destination === "connections"
          ? "Connections sections"
          : `${destination === "quota" ? "Quota" : "Analytics"} views`
      }
      className={
        destination === "connections"
          ? "flex flex-wrap gap-x-2.5 gap-y-0.5 sm:gap-x-4"
          : "flex flex-wrap gap-x-5 gap-y-0.5"
      }
    >
      {links.map(({ page: target, label }) => {
        const href = pageHash(target)
        return (
          <ButtonLink
            key={href}
            href={href}
            onClick={(event) => {
              if (
                target._tag === "Connections" &&
                target.section !== undefined &&
                location.hash === href &&
                followsLink(event)
              ) {
                event.preventDefault()
                focusConnectionSection(target.section)
              }
            }}
            aria-current={href === current ? (destination === "connections" ? "location" : "page") : undefined}
            variant={destination === "connections" ? "jump" : "section"}
            size={destination === "connections" ? "sm" : "section"}
          >
            {label}
            {destination === "connections" && (
              <ArrowDown aria-hidden data-icon="inline-end" className="hidden sm:block" />
            )}
          </ButtonLink>
        )
      })}
    </nav>
  )
}
