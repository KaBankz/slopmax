// The app: the web dashboard's gate when it has no key (unless this
// machine's tailnet identity opens it), or the window: the sidebar, the
// page's title and tools, the sign-in card, the page, and the toasts.
import { RegistryProvider, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import type { Atom } from "effect/reactivity"
import { AsyncResult } from "effect/reactivity"
import { Eye, Plus, RefreshCw, TriangleAlert, Trash } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react"
import { hostAtom, machineAtom, ownerKeyAtom } from "./api.ts"
import {
  canChangeAtom,
  clearFeed,
  enterKey,
  eventsAtom,
  feedAtom,
  requestFilterAtom,
  go,
  pageAtom,
  prefsAtom,
  rangeAtom,
  readOnlyAtom,
  refresh,
  refreshingAtom,
  settingsAtom,
  shownReportAtom,
  tailnetProbeAtom,
  tailnetRetryAtom,
  toggleSidebar,
  unansweredAtom,
} from "./atoms.ts"
import { AskHost } from "./components/ask.tsx"
import { Kbd } from "./components/parts.tsx"
import { Segmented } from "./components/segmented.tsx"
import { Sidebar, SidebarFrame } from "./components/sidebar.tsx"
import { SignInCard } from "./components/sign-in.tsx"
import { Tip } from "./components/tip.tsx"
import { Toasts } from "./components/toasts.tsx"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx"
import { Button } from "./components/ui/button.tsx"
import { Separator } from "./components/ui/separator.tsx"
import { SidebarInset, SidebarTrigger } from "./components/ui/sidebar.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { AccessPage } from "./pages/access.tsx"
import { AgentsPage } from "./pages/agents.tsx"
import { DiagnosticsPage, DiagnosticsTools } from "./pages/diagnostics.tsx"
import { Gate } from "./pages/gate.tsx"
import { OverviewPage } from "./pages/overview.tsx"
import { ProviderPage } from "./pages/provider.tsx"
import { RequestsPage } from "./pages/requests.tsx"
import { SettingsPage } from "./pages/settings.tsx"
import { PerformancePage, UsagePage } from "./pages/usage.tsx"
import { keyFromHash, type Page, pageOrder, Pages, pageTitle } from "./view/pages.ts"
import { adminCommand, onTheHub } from "./view/tailnet.ts"
import { rangeTitle, ranges } from "./view/words.ts"

/** Light or dark, from the Appearance setting or the system's. */
const useTheme = () => {
  const prefs = useAtomValue(prefsAtom)
  useEffect(() => {
    const root = document.documentElement
    const media = typeof matchMedia === "undefined" ? undefined : matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = prefs.appearance === "dark" || (prefs.appearance === "system" && media?.matches === true)
      root.classList.toggle("dark", dark)
    }
    apply()
    media?.addEventListener("change", apply)
    return () => media?.removeEventListener("change", apply)
  }, [prefs.appearance])
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
  const refreshing = useAtomValue(refreshingAtom)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return
      const order = pageOrder(report)
      if (/^[1-9]$/.test(event.key)) {
        const page = order[Number(event.key) - 1]
        if (page !== undefined) go(page)
      } else if (event.key === "r") {
        if (canChange && !refreshing) again()
      } else if (event.key === "\\") toggle()
      else if (event.key === ",") go(Pages.settings)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [report, canChange, refreshing, again, toggle])
}

function RefreshButton() {
  const canChange = useAtomValue(canChangeAtom)
  const refreshing = useAtomValue(refreshingAtom)
  const again = useAtomSet(refresh)
  return (
    <Tip
      content={
        <span className="flex items-center gap-2">
          Refresh usage <Kbd>R</Kbd>
        </span>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={refreshing ? "Reading usage again…" : "Refresh usage"}
        aria-busy={refreshing || undefined}
        disabled={!canChange || refreshing}
        onClick={() => again()}
      >
        <RefreshCw className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
      </Button>
    </Tip>
  )
}

function Tools({ page }: { readonly page: Page }) {
  const [range, setRange] = [useAtomValue(rangeAtom), useAtomSet(rangeAtom)]
  const feed = useAtomValue(feedAtom)
  const clear = useAtomSet(clearFeed)
  const listing = useAtomValue(requestFilterAtom).span
  switch (page._tag) {
    case "Overview":
    case "Provider":
      return (
        <>
          <RefreshButton />
          <Button onClick={() => go(Pages.access)}>
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
      // Clearing empties the live feed; the ledger's ranges keep everything.
      return listing !== "live" ? null : (
        <Button variant="outline" disabled={feed.length === 0} onClick={() => clear()}>
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

/** While the event stream is down: that what the window shows may be out of date. */
function UnansweredBanner() {
  if (!useAtomValue(unansweredAtom)) return null
  return (
    <Alert role="status" variant="warning">
      <TriangleAlert />
      <AlertTitle>slopmax is not answering</AlertTitle>
      <AlertDescription>
        This page tries again on its own; until then, what it shows may be out of date.
      </AlertDescription>
    </Alert>
  )
}

/**
 * A page opened over the tailnet from a machine that may only look: what it
 * can't do, and how to let it.
 */
function ReadOnlyBanner() {
  const readOnly = useAtomValue(readOnlyAtom)
  const machine = useAtomValue(machineAtom)
  const host = useAtomValue(hostAtom)
  if (!readOnly) return null
  const origin = Option.match(host, { onNone: () => "", onSome: (h) => h.origin })
  return (
    <Alert role="note">
      <Eye />
      <AlertDescription>
        {onTheHub(machine, origin) ? (
          <p>
            Read-only at this address, even on the hub. Here, <code className="font-mono">slopmax dashboard</code> opens
            it with its key.
          </p>
        ) : (
          <p>
            Read-only from this machine. On the hub: <code className="font-mono">{adminCommand(machine)}</code>
          </p>
        )}
      </AlertDescription>
    </Alert>
  )
}

function Window() {
  useAtomMount(eventsAtom)
  useShortcuts()
  const page = useAtomValue(pageAtom)
  const host = useAtomValue(hostAtom)
  const settings = useAtomValue(settingsAtom)
  const toggle = useAtomSet(toggleSidebar)
  const listen = Option.map(AsyncResult.value(settings), (view) => view.settings.listen)
  const address = Option.getOrElse(listen, () =>
    Option.match(host, { onNone: () => "", onSome: (h) => h.origin.replace(/^https?:\/\//, "") }),
  )
  return (
    <SidebarFrame onToggle={() => toggle()}>
      <Sidebar address={address} />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center border-b">
          {/* As wide as the content column, so the page's tools sit over the page they act on. */}
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 md:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <h1 className="min-w-0 flex-1 truncate text-base font-medium">{pageTitle(page)}</h1>
            <div className="flex items-center gap-2">
              <Tools page={page} />
            </div>
          </div>
        </header>
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="@container mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
            <ReadOnlyBanner />
            <UnansweredBanner />
            <SignInCard />
            <PageBody page={page} />
          </div>
        </div>
      </SidebarInset>
      <Toasts />
      <AskHost />
    </SidebarFrame>
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
const useKeyFromAddress = () => {
  const setKey = useAtomSet(enterKey)
  useEffect(() => {
    const take = () => {
      const key = takeKeyFromAddress()
      if (key !== undefined) setKey(key)
    }
    window.addEventListener("hashchange", take)
    return () => window.removeEventListener("hashchange", take)
  }, [setKey])
}

export function App() {
  useTheme()
  const key = useAtomValue(ownerKeyAtom)
  useKeyFromAddress()
  if (Option.isNone(key)) return <Entrance />
  return <Window />
}

/**
 * The web dashboard without a key: it first asks slopmax whether this
 * machine's tailnet identity opens it, and asks for the key only when not.
 */
function Entrance() {
  if (useAtomValue(tailnetRetryAtom) === "refused") return <Gate />
  return <Probe />
}

/** Asks `/healthz` whether this machine's tailnet identity opens the dashboard; the gate when it does not. */
function Probe() {
  const probe = useAtomValue(tailnetProbeAtom)
  if (AsyncResult.isInitial(probe) || AsyncResult.isWaiting(probe)) {
    return <main aria-busy="true" aria-label="Opening slopmax…" className="h-full bg-sidebar" />
  }
  return <Gate />
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
        <h1 className="text-base font-semibold">slopmax could not draw this page</h1>
        <p className="max-w-md text-xs text-muted-foreground">{this.state.failed}</p>
        <Button variant="outline" onClick={() => location.reload()}>
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
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </Boundary>
    </RegistryProvider>
  )
}
