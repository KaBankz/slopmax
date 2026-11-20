// Dashboard destinations, contextual links, and the live proxy state.
import { useAtomValue } from "@effect/atom-react"
import { ArrowLeft, ChartNoAxesCombined, Gauge, SlidersHorizontal, UsersRound } from "lucide-react"
import { proxyStatusAtom } from "../atoms.ts"
import { destinationOf, destinations, type Page, pageHash, Pages } from "../view/pages.ts"
import { Dot, Logo } from "./parts.tsx"
import { ButtonLink } from "./ui/button.tsx"

const destinationIcons = { quota: Gauge, accounts: UsersRound, activity: ChartNoAxesCombined, proxy: SlidersHorizontal }

const activityPages = [
  { page: Pages.usage, label: "Usage" },
  { page: Pages.requests, label: "Requests" },
  { page: Pages.performance, label: "Performance" },
]
const proxyPages = [
  { page: Pages.settings, label: "Settings" },
  { page: Pages.agents, label: "Agents" },
  { page: Pages.access, label: "Access" },
  { page: Pages.diagnostics, label: "Diagnostics" },
]

function ProxyStatus() {
  const status = useAtomValue(proxyStatusAtom)
  const compactStatus = status.tone === "good" ? "Running" : status.text
  return (
    <ButtonLink
      href={pageHash(Pages.diagnostics)}
      variant="proxyStatus"
      size="sm"
      aria-label={`Diagnostics · ${status.text}`}
      className="justify-self-end"
    >
      <Dot tone={status.tone} />
      Diagnostics
      <span className="hidden lg:inline">· {status.text}</span>
      <span className="hidden xs:inline md:hidden">· {compactStatus}</span>
    </ButtonLink>
  )
}

export function Masthead({ page }: { readonly page: Page }) {
  const current = destinationOf(page)
  return (
    <header className="z-10 shrink-0 border-b bg-card">
      <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 min-h-12 px-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-x-3 sm:px-6 lg:gap-x-6 lg:px-8">
        <a
          href={pageHash(Pages.overview)}
          className="flex w-fit items-center gap-2 rounded-md py-1.5 font-heading text-2xl leading-none font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="slopmax home"
        >
          <Logo />
          slopmax
        </a>
        <nav
          aria-label="Dashboard"
          className="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t bg-card pb-(--dashboard-safe-bottom) md:static md:flex md:gap-1 md:border-0 md:pb-0"
        >
          {destinations.map(({ id, label, page: target }) => {
            const Icon = destinationIcons[id]
            return (
              <ButtonLink
                key={id}
                href={pageHash(target)}
                aria-current={page._tag === target._tag ? "page" : current === id ? "location" : undefined}
                variant="destination"
                size="navigation"
              >
                <Icon aria-hidden />
                {label}
              </ButtonLink>
            )
          })}
        </nav>
        <ProxyStatus />
      </div>
    </header>
  )
}

export function SectionNavigation({ page }: { readonly page: Page }) {
  const section = destinationOf(page)
  if (page._tag === "Provider" || page._tag === "AddAccount") {
    return (
      <ButtonLink href={pageHash(Pages.accounts)} variant="link" size="sm" className="w-fit">
        <ArrowLeft aria-hidden />
        All accounts
      </ButtonLink>
    )
  }
  if (section !== "activity" && section !== "proxy") return null
  const links = section === "activity" ? activityPages : proxyPages
  return (
    <nav aria-label={section === "activity" ? "Activity" : "Proxy"} className="flex flex-wrap gap-x-1 gap-y-0.5">
      {links.map(({ page: target, label }) => (
        <ButtonLink
          key={target._tag}
          href={pageHash(target)}
          aria-current={page._tag === target._tag ? "page" : undefined}
          variant="section"
          size="section"
        >
          {label}
        </ButtonLink>
      ))}
    </nav>
  )
}
