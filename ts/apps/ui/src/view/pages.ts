// The app's pages: their order in the sidebar (and for the arrow keys),
// their titles, and how they live in the address's fragment, so a reload, a
// link from the menu bar panel, or the back button lands on the same page.
import { parseProviderId, providerFacts, providerOrder, type ProviderId, type Report } from "@slopmax/domain"
import { Result } from "effect"

export type Page =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Provider"; readonly provider: ProviderId }
  | { readonly _tag: "Usage" }
  | { readonly _tag: "Performance" }
  | { readonly _tag: "Requests" }
  | { readonly _tag: "Agents" }
  | { readonly _tag: "Access" }
  | { readonly _tag: "Diagnostics" }
  | { readonly _tag: "Settings" }

type Simple = Exclude<Page["_tag"], "Provider">

const simple = <T extends Simple>(tag: T): { readonly _tag: T } => ({ _tag: tag })

export const Pages = {
  overview: simple("Overview"),
  usage: simple("Usage"),
  performance: simple("Performance"),
  requests: simple("Requests"),
  agents: simple("Agents"),
  access: simple("Access"),
  diagnostics: simple("Diagnostics"),
  settings: simple("Settings"),
  provider: (provider: ProviderId): Page => ({ _tag: "Provider", provider }),
} as const

/** The providers that have accounts, in registry order: one sidebar row each. */
export const providersWithAccounts = (report: Report | undefined): ReadonlyArray<ProviderId> =>
  report === undefined ? [] : providerOrder.filter((id) => report.accounts.some((a) => a.provider === id))

/** Every page in sidebar order. */
export const pageOrder = (report: Report | undefined): ReadonlyArray<Page> => [
  Pages.overview,
  ...providersWithAccounts(report).map(Pages.provider),
  Pages.usage,
  Pages.performance,
  Pages.requests,
  Pages.agents,
  Pages.access,
  Pages.diagnostics,
  Pages.settings,
]

export const samePage = (a: Page, b: Page): boolean =>
  a._tag === b._tag && (a._tag !== "Provider" || (b._tag === "Provider" && a.provider === b.provider))

/** The page before or after `current`, staying put at either end. */
export const movePage = (order: ReadonlyArray<Page>, current: Page, by: -1 | 1): Page => {
  const at = order.findIndex((page) => samePage(page, current))
  if (at < 0) return order[0] ?? current
  return order[Math.min(order.length - 1, Math.max(0, at + by))] ?? current
}

export const pageTitle = (page: Page): string =>
  page._tag === "Provider" ? providerFacts[page.provider].title : page._tag

/** The page as the address's fragment: `#/overview`, `#/claude`. */
export const pageHash = (page: Page): string =>
  page._tag === "Provider" ? `#/${page.provider}` : `#/${page._tag.toLowerCase()}`

/** Where the app is, read from the address's fragment. */
export type Route =
  | { readonly _tag: "Page"; readonly page: Page }
  /** The menu bar's panel, a window of its own in the desktop app. */
  | { readonly _tag: "Panel" }

export const parseRoute = (hash: string): Route => {
  const name = hash.replace(/^#\/?/, "").split(/[?&]/)[0] ?? ""
  if (name === "panel") return { _tag: "Panel" }
  const provider = parseProviderId(name)
  if (Result.isSuccess(provider)) return { _tag: "Page", page: Pages.provider(provider.success) }
  const found = Object.values(Pages).find(
    (page): page is { readonly _tag: Simple } => typeof page !== "function" && page._tag.toLowerCase() === name,
  )
  return { _tag: "Page", page: found ?? Pages.overview }
}

/** Where the sidebar stands: shown or hidden, and whether the last change slides or is instant. */
export interface SidebarState {
  readonly hidden: boolean
  readonly width: number
  /** The keyboard and the menus show and hide it at once; the button slides it. */
  readonly instant: boolean
}

export const sidebarWidth = { least: 190, most: 340, initial: 220 } as const

/** Dragging the edge further left than this hides the sidebar. */
export const sidebarHideBelow = 130

export const clampWidth = (width: number): number =>
  Math.min(sidebarWidth.most, Math.max(sidebarWidth.least, Number.isFinite(width) ? width : sidebarWidth.initial))

/** Shows or hides the sidebar; `via` the keyboard or a menu it moves at once, `via` the button it slides. */
export const toggleSidebar = (state: SidebarState, via: "button" | "keyboard"): SidebarState => ({
  ...state,
  hidden: !state.hidden,
  instant: via === "keyboard",
})

/**
 * Where a drag of the sidebar's edge leaves it: the pointer's x sets the
 * width within its limits; past the hiding point the sidebar hides and keeps
 * the width the drag began with.
 */
export const dragSidebar = (state: SidebarState, x: number, startWidth: number): SidebarState =>
  x < sidebarHideBelow
    ? { hidden: true, width: startWidth, instant: true }
    : { hidden: false, width: clampWidth(x), instant: true }

/**
 * The owner key handed to the web dashboard in its address (`#key=sm-…`),
 * and the fragment left once it is taken out, so the key never stays in the
 * address bar or the history.
 */
export const keyFromHash = (hash: string): { readonly key?: string; readonly rest: string } => {
  const parts = hash.replace(/^#/, "").split("&")
  const found = parts.find((part) => part.startsWith("key="))
  if (found === undefined) return { rest: hash }
  const others = parts.filter((part) => part !== found)
  const key = decodeURIComponent(found.slice("key=".length)).trim()
  return { ...(key === "" ? {} : { key }), rest: others.length === 0 ? "" : `#${others.join("&")}` }
}
