// The app: the web dashboard's gate when it has no key, the menu bar's
// panel, or the window: the sidebar, the page's title and tools, the
// sign-in card, the page, and the toasts.
import { RegistryProvider, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import type { Atom } from "effect/reactivity"
import { AsyncResult } from "effect/reactivity"
import { PanelLeft, Plus, RefreshCw, Trash } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react"
import { hostAtom, ownerKeyAtom } from "./api.ts"
import {
  canChangeAtom,
  clearFeed,
  enterKey,
  eventsAtom,
  feedAtom,
  go,
  liveAtom,
  menuAtom,
  offlineAtom,
  prefsAtom,
  proxyAction,
  proxyAtom,
  rangeAtom,
  refresh,
  routeAtom,
  settingsAtom,
  shownReportAtom,
  toggleSidebar,
} from "./atoms.ts"
import { AskHost } from "./components/ask.tsx"
import { Kbd } from "./components/parts.tsx"
import { Sidebar } from "./components/sidebar.tsx"
import { SignInCard } from "./components/sign-in.tsx"
import { Toasts } from "./components/toasts.tsx"
import { Button } from "./components/ui/button.tsx"
import { Segmented } from "./components/ui/segmented.tsx"
import { Tip, TooltipProvider } from "./components/ui/tooltip.tsx"
import { AccessPage } from "./pages/access.tsx"
import { AgentsPage } from "./pages/agents.tsx"
import { DiagnosticsPage, DiagnosticsTools } from "./pages/diagnostics.tsx"
import { Gate } from "./pages/gate.tsx"
import { OverviewPage } from "./pages/overview.tsx"
import { PanelPage } from "./pages/panel.tsx"
import { ProviderPage } from "./pages/provider.tsx"
import { RequestsPage } from "./pages/requests.tsx"
import { SettingsPage } from "./pages/settings.tsx"
import { PerformancePage, UsagePage } from "./pages/usage.tsx"
import { keyFromHash, type Page, pageOrder, Pages, pageTitle } from "./view/pages.ts"
import { rangeTitle, ranges } from "./view/words.ts"

/** Light or dark, from the Appearance setting or the system's; and whether the window sits on a Mac. */
const useTheme = () => {
  const prefs = useAtomValue(prefsAtom)
  const host = useAtomValue(hostAtom)
  const desktop = Option.isSome(host) && host.value.kind === "desktop"
  useEffect(() => {
    const root = document.documentElement
    const media = typeof matchMedia === "undefined" ? undefined : matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = prefs.appearance === "dark" || (prefs.appearance === "system" && media?.matches === true)
      root.classList.toggle("dark", dark)
    }
    apply()
    root.classList.toggle("mac", desktop && /Mac/.test(navigator.platform))
    media?.addEventListener("change", apply)
    return () => media?.removeEventListener("change", apply)
  }, [prefs.appearance, desktop])
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT")

/**
 * Keys for the whole window, as in other keyboard-first tools: a digit opens
 * the page at that place in the sidebar, R reads usage again, \ shows or
 * hides the sidebar, and the comma opens Settings. None of them fire while
 * typing, or with a modifier held, so the browser's own keys still work.
 */
const useShortcuts = () => {
  const again = useAtomSet(refresh)
  const toggle = useAtomSet(toggleSidebar)
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const canChange = useAtomValue(canChangeAtom)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return
      const order = pageOrder(report)
      if (/^[1-9]$/.test(event.key)) {
        const page = order[Number(event.key) - 1]
        if (page !== undefined) go(page)
      } else if (event.key === "r" && canChange) again()
      else if (event.key === "\\") toggle("keyboard")
      else if (event.key === ",") go(Pages.settings)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [report, canChange, again, toggle])
}

function RefreshButton() {
  const canChange = useAtomValue(canChangeAtom)
  const again = useAtomSet(refresh)
  return (
    <Tip
      content={
        <span className="flex items-center gap-2">
          Refresh usage <Kbd>R</Kbd>
        </span>
      }
    >
      <Button variant="ghost" size="icon" aria-label="Refresh usage" disabled={!canChange} onClick={() => again()}>
        <RefreshCw />
      </Button>
    </Tip>
  )
}

function Tools({ page }: { readonly page: Page }) {
  const [range, setRange] = [useAtomValue(rangeAtom), useAtomSet(rangeAtom)]
  const feed = useAtomValue(feedAtom)
  const clear = useAtomSet(clearFeed)
  switch (page._tag) {
    case "Overview":
    case "Provider":
      return (
        <>
          <RefreshButton />
          <Button variant="primary" onClick={() => go(Pages.access)}>
            <Plus />
            Add account
          </Button>
        </>
      )
    case "Usage":
    case "Performance":
      return (
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={ranges.map((value) => ({ value, title: rangeTitle(value) }))}
        />
      )
    case "Diagnostics":
      return <DiagnosticsTools />
    case "Requests":
      return (
        <Button disabled={feed.length === 0} onClick={() => clear()}>
          <Trash />
          Clear
        </Button>
      )
    case "Agents":
    case "Access":
    case "Settings":
      return null
  }
}

function PageBody({ page }: { readonly page: Page }) {
  switch (page._tag) {
    case "Overview":
      return <OverviewPage />
    case "Provider":
      return <ProviderPage provider={page.provider} />
    case "Usage":
      return <UsagePage />
    case "Performance":
      return <PerformancePage />
    case "Requests":
      return <RequestsPage />
    case "Agents":
      return <AgentsPage />
    case "Access":
      return <AccessPage />
    case "Diagnostics":
      return <DiagnosticsPage />
    case "Settings":
      return <SettingsPage />
  }
}

/**
 * While the desktop's proxy is stopped, or another version runs: what the
 * window shows, and the way back. While the event stream is down, in either
 * host, that what is shown may be out of date.
 */
function ProxyBanner() {
  const proxy = useAtomValue(proxyAtom)
  const live = useAtomValue(liveAtom)
  const offline = useAtomValue(offlineAtom)
  const act = useAtomSet(proxyAction)
  if (proxy._tag === "OtherVersion") {
    return (
      <div role="status" className="flex items-center gap-4 rounded-xl border border-warning px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">
            slopmax {proxy.running} is running, not this app's {proxy.bundled}
          </span>
          <span className="text-small text-muted-foreground">
            {proxy.service
              ? "The login service runs the other version. Restart points it at this app's slopmax."
              : "Restart to run this app's slopmax."}
          </span>
        </div>
        <Button variant="primary" onClick={() => act("restart")}>
          Restart
        </Button>
      </div>
    )
  }
  if (proxy._tag !== "Stopped") {
    if (live._tag !== "Reconnecting") return null
    return (
      <div role="status" className="flex flex-col gap-0.5 rounded-xl border border-warning px-4 py-3">
        <span className="font-medium">slopmax is not answering</span>
        <span className="text-small text-muted-foreground">
          This page tries again on its own; until then, what it shows may be out of date.
        </span>
      </div>
    )
  }
  const fromDisk = Option.isSome(AsyncResult.getOrElse(offline, () => Option.none()))
  return (
    <div role="status" className="flex items-center gap-4 rounded-xl border border-danger px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">The proxy is stopped</span>
        <span className="text-small text-muted-foreground">
          Agents cannot reach slopmax.{" "}
          {fromDisk
            ? "This is what slopmax last saved; signing in, changes and history need it running."
            : "Start it to see your accounts."}
        </span>
      </div>
      <Button variant="primary" onClick={() => act("start")}>
        Start the proxy
      </Button>
    </div>
  )
}

function Window() {
  useAtomMount(eventsAtom)
  useAtomMount(menuAtom)
  useShortcuts()
  const route = useAtomValue(routeAtom)
  const prefs = useAtomValue(prefsAtom)
  const host = useAtomValue(hostAtom)
  const settings = useAtomValue(settingsAtom)
  const toggle = useAtomSet(toggleSidebar)
  const page = route._tag === "Page" ? route.page : Pages.overview
  const listen = Option.map(AsyncResult.value(settings), (view) => view.settings.listen)
  const address = Option.getOrElse(listen, () =>
    Option.match(host, { onNone: () => "", onSome: (h) => h.origin.replace(/^https?:\/\//, "") }),
  )
  return (
    <div className="flex h-full">
      <Sidebar address={address} onToggle={() => toggle("button")} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-13 shrink-0 items-center">
          {/* As wide as the content column, so the page's tools sit over the page they act on. */}
          <div
            className="flex w-full max-w-page items-center gap-3 px-8 mac:data-hidden:pl-22"
            data-hidden={prefs.sidebarHidden || undefined}
          >
            {prefs.sidebarHidden && (
              <Tip content="Show Sidebar">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Show Sidebar"
                  className="no-drag"
                  onClick={() => toggle("button")}
                >
                  <PanelLeft />
                </Button>
              </Tip>
            )}
            <h1 className="min-w-0 flex-1 truncate text-title font-semibold">{pageTitle(page)}</h1>
            <div className="no-drag flex items-center gap-2">
              <Tools page={page} />
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="@container flex max-w-page flex-col gap-8 px-8 pt-1 pb-10">
            <ProxyBanner />
            <SignInCard />
            <PageBody page={page} />
          </div>
        </div>
      </main>
      <Toasts />
      <AskHost />
    </div>
  )
}

function Panel() {
  useAtomMount(eventsAtom)
  // The panel's window is transparent around its card.
  useEffect(() => {
    document.documentElement.classList.add("panel")
    return () => document.documentElement.classList.remove("panel")
  }, [])
  return (
    <div className="flex justify-center bg-transparent">
      <PanelPage />
    </div>
  )
}

/**
 * Takes the owner key out of the address (`#key=sm-…`), where
 * `slopmax dashboard` puts it, so it never stays in the address bar or the
 * history; answers it when there was one.
 */
export const takeKeyFromAddress = (): string | undefined => {
  const { key, rest } = keyFromHash(location.hash)
  if (key !== undefined) {
    history.replaceState(null, "", `${location.pathname}${location.search}${rest === "" ? "#/overview" : rest}`)
  }
  return key
}

/** A key handed over in the address while the page is open (a second `slopmax dashboard` reusing the tab). */
const useKeyFromAddress = (web: boolean) => {
  const setKey = useAtomSet(enterKey)
  useEffect(() => {
    if (!web) return
    const take = () => {
      const key = takeKeyFromAddress()
      if (key !== undefined) setKey(key)
    }
    window.addEventListener("hashchange", take)
    return () => window.removeEventListener("hashchange", take)
  }, [web, setKey])
}

export function App() {
  useTheme()
  const route = useAtomValue(routeAtom)
  const host = useAtomValue(hostAtom)
  const key = useAtomValue(ownerKeyAtom)
  const web = Option.isSome(host) && host.value.kind === "web"
  useKeyFromAddress(web)
  if (web && Option.isNone(key)) return <Gate />
  return route._tag === "Panel" ? <Panel /> : <Window />
}

/** Catches a page that fails to draw, so the rest of the window stays usable. */
export class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed?: string }> {
  override state: { readonly failed?: string } = {}

  static getDerivedStateFromError(error: unknown): { readonly failed: string } {
    return { failed: error instanceof Error ? error.message : "it failed" }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("slopmax: could not draw the page", error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed === undefined) return this.props.children
    return (
      <main role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="text-heading font-semibold">slopmax could not draw this page</h1>
        <p className="max-w-md text-small text-muted-foreground">{this.state.failed}</p>
        <Button className="mt-2" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    )
  }
}

/** The app with its registry, given the values it starts from (the host, the key, the preferences, in tests the transport). */
export function Root({ initialValues }: { readonly initialValues: Iterable<readonly [Atom.Atom<unknown>, unknown]> }) {
  return (
    <RegistryProvider initialValues={initialValues}>
      <Boundary>
        <TooltipProvider delay={300}>
          <App />
        </TooltipProvider>
      </Boundary>
    </RegistryProvider>
  )
}
