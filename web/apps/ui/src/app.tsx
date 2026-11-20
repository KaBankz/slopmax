// The dashboard shell, its page controls, and the owner-key entrance.
import { RegistryProvider, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import type { Atom } from "effect/reactivity"
import { AsyncResult } from "effect/reactivity"
import { Eye, Plus, RefreshCw, TriangleAlert, Trash } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef } from "react"
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
  tailnetProbeAtom,
  tailnetRetryAtom,
  toggleSidebar,
  unansweredAtom,
} from "./atoms.ts"
import { AskHost } from "./components/ask.tsx"
import { Segmented } from "./components/segmented.tsx"
import { Sidebar, SidebarFrame } from "./components/sidebar.tsx"
import { SignInCard } from "./components/sign-in.tsx"
import { Toasts } from "./components/toasts.tsx"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx"
import { Button } from "./components/ui/button.tsx"
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
import { keyFromHash, type Page, pageDescription, Pages, pageTitle } from "./view/pages.ts"
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

function RefreshButton() {
  const canChange = useAtomValue(canChangeAtom)
  const refreshing = useAtomValue(refreshingAtom)
  const again = useAtomSet(refresh)
  return (
    <Button
      variant="outline"
      aria-label="Refresh usage"
      aria-busy={refreshing || undefined}
      disabled={!canChange || refreshing}
      onClick={() => again()}
    >
      <RefreshCw aria-hidden className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
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
          <Button variant="secondary" onClick={() => go(Pages.access)}>
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
      return <ProviderPage provider={page.provider} account={page.account} />
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
  const origin = Option.match(host, {
    onNone: () => "",
    onSome: (h) => h.origin,
  })
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
  const page = useAtomValue(pageAtom)
  const host = useAtomValue(hostAtom)
  const settings = useAtomValue(settingsAtom)
  const toggle = useAtomSet(toggleSidebar)
  const pane = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (pane.current !== null) pane.current.scrollTop = 0
  }, [page])
  const listen = Option.map(AsyncResult.value(settings), (view) => view.settings.listen)
  const address = Option.getOrElse(listen, () =>
    Option.match(host, {
      onNone: () => "",
      onSome: (h) => h.origin.replace(/^https?:\/\//, ""),
    }),
  )
  return (
    <SidebarFrame onToggle={() => toggle()}>
      <a
        href="#dashboard-title"
        className="sr-only z-50 rounded-md bg-card px-4 py-2 font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-ring"
        onClick={(event) => {
          event.preventDefault()
          heading.current?.focus()
        }}
      >
        Skip to main content
      </a>
      <Sidebar address={address} />
      <SidebarInset className="min-w-0" aria-labelledby="dashboard-title">
        <header className="shrink-0 border-b bg-card">
          <div className="mx-auto grid w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-6 lg:px-8">
            <div className="min-w-0">
              <h1
                ref={heading}
                id="dashboard-title"
                tabIndex={-1}
                className="font-heading text-display font-semibold tracking-tight"
              >
                {pageTitle(page)}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{pageDescription(page)}</p>
            </div>
            <SidebarTrigger className="col-start-2 row-start-1 self-start sm:col-start-3 sm:self-center" />
            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 empty:hidden sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-end">
              <Tools page={page} />
            </div>
          </div>
        </header>
        <div ref={pane} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="@container mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
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
        <h1 className="font-heading text-xl font-semibold">slopmax could not draw this page</h1>
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
