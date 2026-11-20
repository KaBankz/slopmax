// The app's pages: their order in the sidebar (and for the arrow keys),
// their titles, and how they live in the address's fragment, so a reload, a
// link, or the back button lands on the same page.
import { parseProviderId, providerFacts, providerOrder, type ProviderId, type Report } from "@slopmax/client"
import { Result } from "effect"

export type Page =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Provider"; readonly provider: ProviderId; readonly account?: string }
  | { readonly _tag: "Usage" }
  | { readonly _tag: "Performance" }
  | { readonly _tag: "Requests" }
  | { readonly _tag: "Agents" }
  | { readonly _tag: "Access" }
  | { readonly _tag: "Diagnostics" }
  | { readonly _tag: "Settings" }

type Simple = Exclude<Page["_tag"], "Provider">

const simple = <T extends Simple>(tag: T): { readonly _tag: T } => ({
  _tag: tag,
})

export const Pages = {
  overview: simple("Overview"),
  usage: simple("Usage"),
  performance: simple("Performance"),
  requests: simple("Requests"),
  agents: simple("Agents"),
  access: simple("Access"),
  diagnostics: simple("Diagnostics"),
  settings: simple("Settings"),
  provider: (provider: ProviderId, account?: string): Page => ({
    _tag: "Provider",
    provider,
    ...(account === undefined ? {} : { account }),
  }),
} as const

/** The providers that have accounts, in registry order: one sidebar row each. */
const providersWithAccounts = (report: Report | undefined): ReadonlyArray<ProviderId> =>
  report === undefined ? [] : providerOrder.filter((id) => report.accounts.some((a) => a.provider === id))

/** Every page in sidebar order. */
export const pageOrder = (report: Report | undefined): ReadonlyArray<Page> => [
  Pages.overview,
  ...providersWithAccounts(report).map((provider) => Pages.provider(provider)),
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

/** What users can find here, in the shared page header. */
export const pageDescription = (page: Page): string => {
  switch (page._tag) {
    case "Overview":
      return "Find quota you can use before it resets."
    case "Provider":
      return providerFacts[page.provider].billing === "subscription"
        ? "Account limits, routing, and upcoming resets."
        : "Manage accounts and the models they serve."
    case "Usage":
      return "Track usage and review what went unused at reset."
    case "Performance":
      return "Explore response times, cache use, and reliability."
    case "Requests":
      return "Follow live traffic or inspect recorded requests."
    case "Agents":
      return "Connect coding agents to the proxy or restore their previous settings."
    case "Access":
      return "Add accounts and manage access for other machines."
    case "Diagnostics":
      return "Check the proxy and its connection to your agents."
    case "Settings":
      return "Manage routing, limit resets, notifications, and appearance."
  }
}

/** The page as the address's fragment: `#/overview`, `#/claude`. */
export const pageHash = (page: Page): string =>
  page._tag === "Provider"
    ? `#/${page.provider}${page.account === undefined ? "" : `?account=${encodeURIComponent(page.account)}`}`
    : `#/${page._tag.toLowerCase()}`

/** The page the address's fragment names; the overview when it names none. */
export const parsePage = (hash: string): Page => {
  const [path, query] = hash.replace(/^#\/?/, "").split("?", 2)
  const name = path?.split("&", 1)[0] ?? ""
  const provider = parseProviderId(name)
  if (Result.isSuccess(provider)) {
    const account = new URLSearchParams(query).get("account")
    return Pages.provider(provider.success, account || undefined)
  }
  const found = Object.values(Pages).find(
    (page): page is { readonly _tag: Simple } => typeof page !== "function" && page._tag.toLowerCase() === name,
  )
  return found ?? Pages.overview
}

/** Where the sidebar stands: shown or hidden, and how wide. */
export interface SidebarState {
  readonly hidden: boolean
  readonly width: number
}

export const sidebarWidth = { least: 190, most: 340, initial: 220 } as const

/** Dragging the edge further left than this hides the sidebar. */
export const sidebarHideBelow = 130

export const clampWidth = (width: number): number =>
  Math.min(sidebarWidth.most, Math.max(sidebarWidth.least, Number.isFinite(width) ? width : sidebarWidth.initial))

/**
 * Where a drag of the sidebar's edge leaves it: the pointer's x sets the
 * width within its limits; past the hiding point the sidebar hides and keeps
 * the width the drag began with.
 */
export const dragSidebar = (x: number, startWidth: number): SidebarState =>
  x < sidebarHideBelow ? { hidden: true, width: startWidth } : { hidden: false, width: clampWidth(x) }

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
  return {
    ...(key === "" ? {} : { key }),
    rest: others.length === 0 ? "" : `#${others.join("&")}`,
  }
}
