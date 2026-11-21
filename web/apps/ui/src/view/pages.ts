// The dashboard's destinations and their stable hash routes.
import { parseProviderId, providerFacts, type ProviderId } from "@slopmax/client"
import { Result } from "effect"

export type Page =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "QuotaHistory" }
  | { readonly _tag: "Accounts" }
  | { readonly _tag: "AddAccount" }
  | { readonly _tag: "Provider"; readonly provider: ProviderId; readonly account?: string }
  | { readonly _tag: "Usage" }
  | { readonly _tag: "Performance" }
  | { readonly _tag: "Requests" }
  | { readonly _tag: "Connections"; readonly section?: ConnectionSection }
  | { readonly _tag: "Diagnostics" }
  | { readonly _tag: "Settings" }

export type ConnectionSection = "agents" | "clients"

type Simple = Exclude<Page["_tag"], "Provider" | "Connections">

const simple = <T extends Simple>(tag: T): { readonly _tag: T } => ({
  _tag: tag,
})

export const Pages = {
  overview: simple("Overview"),
  quotaHistory: simple("QuotaHistory"),
  accounts: simple("Accounts"),
  addAccount: simple("AddAccount"),
  usage: simple("Usage"),
  performance: simple("Performance"),
  requests: simple("Requests"),
  connections: (section?: ConnectionSection): Extract<Page, { readonly _tag: "Connections" }> => ({
    _tag: "Connections",
    ...(section === undefined ? {} : { section }),
  }),
  diagnostics: simple("Diagnostics"),
  settings: simple("Settings"),
  provider: (provider: ProviderId, account?: string): Page => ({
    _tag: "Provider",
    provider,
    ...(account === undefined ? {} : { account }),
  }),
} as const

export const navigationGroups = [
  {
    label: "Workspace",
    entries: [
      { id: "quota", label: "Quota", page: Pages.overview },
      { id: "accounts", label: "Accounts", page: Pages.accounts },
    ],
  },
  {
    label: "Activity",
    entries: [
      { id: "analytics", label: "Analytics", page: Pages.usage },
      { id: "requests", label: "Requests", page: Pages.requests },
    ],
  },
  {
    label: "Proxy",
    entries: [
      { id: "connections", label: "Connections", page: Pages.connections() },
      { id: "settings", label: "Settings", page: Pages.settings },
    ],
  },
] as const

export type Destination = (typeof navigationGroups)[number]["entries"][number]["id"] | "diagnostics"

export const destinationOf = (page: Page): Destination => {
  switch (page._tag) {
    case "Overview":
    case "QuotaHistory":
      return "quota"
    case "Accounts":
    case "AddAccount":
    case "Provider":
      return "accounts"
    case "Usage":
    case "Performance":
      return "analytics"
    case "Requests":
      return "requests"
    case "Connections":
      return "connections"
    case "Settings":
      return "settings"
    case "Diagnostics":
      return "diagnostics"
  }
}

export const pageTitle = (page: Page): string => {
  switch (page._tag) {
    case "Overview":
    case "QuotaHistory":
      return "Quota"
    case "Provider":
      return providerFacts[page.provider].title
    case "AddAccount":
      return "Add an account"
    case "Usage":
    case "Performance":
      return "Analytics"
    default:
      return page._tag
  }
}

/** What users can find here, in the shared page header. */
export const pageDescription = (page: Page): string => {
  switch (page._tag) {
    case "Overview":
      return "Find quota you can use before it resets."
    case "QuotaHistory":
      return "See unused allowance and its estimated share of subscription fees."
    case "Accounts":
      return "Compare readiness, last proxy use, and each account’s tightest shared limit."
    case "AddAccount":
      return "Connect a subscription, import a login, or add a key or endpoint."
    case "Provider":
      return providerFacts[page.provider].billing === "subscription"
        ? "Account limits, routing, and upcoming resets."
        : "Manage accounts and the models they serve."
    case "Usage":
      return "Track requests, tokens, and estimated costs through your proxy."
    case "Performance":
      return "Explore response times, cache use, and reliability."
    case "Requests":
      return "Follow live traffic or inspect recorded requests."
    case "Connections":
      return "Connect coding agents and manage access from other machines."
    case "Diagnostics":
      return "Check the proxy and its connection to your agents."
    case "Settings":
      return "Proxy and browser preferences."
  }
}

/** The page as the address's fragment: `#/overview`, `#/claude`. */
export const pageHash = (page: Page): string => {
  switch (page._tag) {
    case "Provider":
      return `#/${page.provider}${page.account === undefined ? "" : `?account=${encodeURIComponent(page.account)}`}`
    case "Connections":
      return `#/connections${page.section === undefined ? "" : `?section=${page.section}`}`
    case "AddAccount":
      return "#/accounts/add"
    case "QuotaHistory":
      return "#/quota/history"
    default:
      return `#/${page._tag.toLowerCase()}`
  }
}

/** The page the address's fragment names; the overview when it names none. */
export const parsePage = (hash: string): Page => {
  const [path, query] = hash.replace(/^#\/?/, "").split("?", 2)
  const name = path?.split("&", 1)[0] ?? ""
  if (name === "agents") return Pages.connections("agents")
  if (name === "access") return Pages.connections("clients")
  if (name === "connections") {
    const section = new URLSearchParams(query).get("section")
    return Pages.connections(section === "agents" || section === "clients" ? section : undefined)
  }
  const provider = parseProviderId(name)
  if (Result.isSuccess(provider)) {
    const account = new URLSearchParams(query).get("account")
    return Pages.provider(provider.success, account || undefined)
  }
  const found = Object.values(Pages).find(
    (page): page is { readonly _tag: Simple } => typeof page !== "function" && pageHash(page) === `#/${name}`,
  )
  return found ?? Pages.overview
}

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
