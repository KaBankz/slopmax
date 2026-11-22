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
  pageAtom,
  prefsAtom,
  rangeAtom,
  readOnlyAtom,
  refresh,
  refreshingAtom,
  shownReportAtom,
  tailnetProbeAtom,
  tailnetRetryAtom,
  unansweredAtom,
} from "./atoms.ts"
import { AskHost } from "./components/ask.tsx"
import { Segmented } from "./components/segmented.tsx"
import {
  DashboardSidebar,
  focusConnectionSection,
  SectionNavigation,
  SidebarBrandBar,
  SidebarFrame,
} from "./components/navigation.tsx"
import { SignInCard } from "./components/sign-in.tsx"
import { Toasts } from "./components/toasts.tsx"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx"
import { Button, ButtonLink } from "./components/ui/button.tsx"
import { SidebarInset } from "./components/ui/sidebar.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { AccountsPage } from "./pages/accounts.tsx"
import { AddAccountPage } from "./pages/add-account.tsx"
import { ConnectionsPage } from "./pages/connections.tsx"
import { DiagnosticsPage, DiagnosticsTools } from "./pages/diagnostics.tsx"
import { Gate } from "./pages/gate.tsx"
import { OverviewPage } from "./pages/overview.tsx"
import { ProviderPage } from "./pages/provider.tsx"
import { RequestsPage } from "./pages/requests.tsx"
import { SettingsPage } from "./pages/settings.tsx"
import { AnalyticsPage, QuotaHistoryPage } from "./pages/usage.tsx"
import { keyFromHash, type Page, pageDescription, pageHash, Pages, pageTitle } from "./view/pages.ts"
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
      size="pageAction"
      aria-label="Refresh"
      aria-busy={refreshing || undefined}
      disabled={!canChange || refreshing}
      onClick={() => again()}
    >
      <RefreshCw aria-hidden className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
      <span className="hidden sm:inline">{refreshing ? "Refreshing…" : "Refresh"}</span>
    </Button>
  )
}

function Tools({ page }: { readonly page: Page }) {
  const [range, setRange] = [useAtomValue(rangeAtom), useAtomSet(rangeAtom)]
  const feed = useAtomValue(feedAtom)
  const clear = useAtomSet(clearFeed)
  const listing = useAtomValue(requestFilterAtom).span
  const report = useAtomValue(shownReportAtom)
  switch (page._tag) {
    case "Overview":
    case "Accounts":
    case "Provider":
      if (
        page._tag === "Provider" &&
        Option.exists(report, (r) => !r.accounts.some((a) => a.provider === page.provider))
      )
        return null
      return (
        <>
          <RefreshButton />
          <ButtonLink variant="secondary" size="pageAction" href={pageHash(Pages.addAccount)}>
            <Plus aria-hidden />
            Add account
          </ButtonLink>
        </>
      )
    case "Usage":
    case "Performance":
    case "QuotaHistory":
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
    case "AddAccount":
    case "Connections":
    case "Settings":
      return null
  }
}

function PageBody({ page }: { readonly page: Page }) {
  switch (page._tag) {
    case "Overview":
      return <OverviewPage />
    case "Accounts":
      return <AccountsPage />
    case "AddAccount":
      return <AddAccountPage provider={page.provider} />
    case "Provider":
      return <ProviderPage provider={page.provider} account={page.account} />
    case "QuotaHistory":
      return <QuotaHistoryPage />
    case "Usage":
    case "Performance":
      return <AnalyticsPage performance={page._tag === "Performance"} />
    case "Requests":
      return <RequestsPage />
    case "Connections":
      return <ConnectionsPage />
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
  const pane = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const previousPage = useRef(page)
  useEffect(() => {
    const section = page._tag === "Connections" ? page.section : undefined
    if (previousPage.current === page && section === undefined) return
    previousPage.current = page
    if (pane.current !== null) pane.current.scrollTop = 0
    // Give the focused account row the first chance to receive focus on a deep link.
    const frame = requestAnimationFrame(() => {
      const accountLink = page._tag === "Provider" && page.account !== undefined
      if (accountLink && pane.current?.contains(document.activeElement)) return
      if (section === undefined || !focusConnectionSection(section)) heading.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [page])
  return (
    <SidebarFrame>
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
      <DashboardSidebar page={page} />
      <SidebarInset className="min-h-0 min-w-0" aria-labelledby="dashboard-title">
        <SidebarBrandBar />
        <header className="shrink-0 border-b">
          <div className="workspace-width flex flex-col gap-3 pt-5 pb-3.5 sm:py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-3 sm:gap-x-5">
              <div className="min-w-0">
                <h1
                  ref={heading}
                  id="dashboard-title"
                  tabIndex={-1}
                  className="w-fit rounded-sm font-display text-display font-normal tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {pageTitle(page)}
                </h1>
                <p
                  data-compact={page._tag === "Overview" || undefined}
                  className="mt-1.5 max-w-prose text-sm text-muted-foreground data-compact:hidden sm:data-compact:block"
                >
                  {pageDescription(page)}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">
                <Tools page={page} />
              </div>
            </div>
            <SectionNavigation page={page} />
          </div>
        </header>
        <div ref={pane} data-slot="dashboard-scroll" className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="workspace-width @container flex flex-col gap-6 pt-5 pb-8 sm:gap-8 sm:pt-6 sm:pb-10">
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
    return <main aria-busy="true" aria-label="Opening slopmax…" className="h-full bg-background" />
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
