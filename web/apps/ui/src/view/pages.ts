// The dashboard's destinations and their stable hash routes.
import { parseProviderId, providerFacts, type ProviderId } from "@slopmax/client"
import { Result } from "effect"

export type Page =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Accounts" }
  | { readonly _tag: "AddAccount" }
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
  accounts: simple("Accounts"),
  addAccount: simple("AddAccount"),
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

export const destinations = [
  { id: "quota", label: "Quota", page: Pages.overview },
  { id: "accounts", label: "Accounts", page: Pages.accounts },
  { id: "activity", label: "Activity", page: Pages.usage },
  { id: "proxy", label: "Proxy", page: Pages.settings },
] as const

export type Destination = (typeof destinations)[number]["id"]

export const destinationOf = (page: Page): Destination => {
  switch (page._tag) {
    case "Overview":
      return "quota"
    case "Accounts":
    case "AddAccount":
    case "Provider":
      return "accounts"
    case "Usage":
    case "Requests":
    case "Performance":
      return "activity"
    case "Settings":
    case "Agents":
    case "Access":
    case "Diagnostics":
      return "proxy"
  }
}

export const pageTitle = (page: Page): string => {
  switch (page._tag) {
    case "Overview":
      return "Quota"
    case "Provider":
      return providerFacts[page.provider].title
    case "AddAccount":
      return "Add an account"
    case "Usage":
      return "Activity"
    case "Settings":
      return "Proxy"
    case "Agents":
      return "Coding agents"
    case "Access":
      return "Client access"
    default:
      return page._tag
  }
}

/** What users can find here, in the shared page header. */
export const pageDescription = (page: Page): string => {
  switch (page._tag) {
    case "Overview":
      return "Find quota you can use before it resets."
    case "Accounts":
      return "Compare readiness, last proxy use, and each account’s tightest shared limit."
    case "AddAccount":
      return "Connect a subscription, import a login, or add a key or endpoint."
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
      return "Manage client keys and connect other machines to the proxy."
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
    : page._tag === "AddAccount"
      ? "#/accounts/add"
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
