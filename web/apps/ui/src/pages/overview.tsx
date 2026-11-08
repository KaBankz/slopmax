// The overview: how the accounts stand in a line, what wants a look, each
// subscription's pool at a glance, keys and endpoints, and today so far.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Report, SubscriptionId } from "@slopmax/client"
import { DateTime, Duration, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronRight, Plus, Radio, Users } from "lucide-react"
import { hostAtom } from "../api.ts"
import {
  askNotifications,
  attentionAtom,
  canChangeAtom,
  go,
  groupsAtom,
  historyAtom,
  nowAtom,
  openCreditsAtom,
  permissionAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
} from "../atoms.ts"
import { Hours } from "../components/charts.tsx"
import { Dot, Empty, Label, Loaded, Panel, Section, SegmentedBar, Skeleton, Stats } from "../components/parts.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button } from "../components/ui/button.tsx"
import { Tip } from "../components/ui/tooltip.tsx"
import { type Attention, standing } from "../view/attention.ts"
import { type Group, resetsLeft } from "../view/groups.ts"
import { Pages } from "../view/pages.ts"
import { hourly, todayStats } from "../view/usage.ts"
import { resetCount, resetsLine, routing, updated } from "../view/words.ts"

function Standing({ report }: { readonly report: Report }) {
  const now = useAtomValue(nowAtom)
  const settings = useAtomValue(settingsAtom)
  const stand = standing(report)
  const line = routing(
    Option.match(AsyncResult.value(settings), {
      onNone: () => ({ strategy: report.strategy }),
      onSome: (view) => view.settings,
    }),
  )
  const age = Duration.toSeconds(DateTime.distance(report.generatedAt, now))
  const banked = report.accounts.reduce((sum, account) => sum + resetsLeft(account, now), 0)
  const detail = [
    ...(stand.detail === undefined ? [] : [stand.detail]),
    ...(banked > 0 ? [`${resetCount(banked)} banked`] : []),
  ].join(" · ")
  return (
    // Narrow, the routing line wraps beneath the headline rather than over it.
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-80 items-center gap-2.5">
        <Dot tone={stand.tone} />
        <span className="shrink-0 font-medium">{stand.headline}</span>
        {detail !== "" && <span className="truncate text-muted-foreground">{detail}</span>}
        <span className="shrink-0 text-small text-faint">{updated(age)}</span>
      </div>
      <Tip content="Change in Settings">
        <button
          type="button"
          aria-label={`Routing: ${line}. Change it in Settings`}
          onClick={() => go(Pages.settings)}
          className="inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-sm text-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {line}
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </Tip>
    </div>
  )
}

function NotifyMe({ report }: { readonly report: Report }) {
  const host = useAtomValue(hostAtom)
  const permission = useAtomValue(permissionAtom)
  const ask = useAtomSet(askNotifications)
  const web = Option.isSome(host) && host.value.kind === "web"
  const undecided = AsyncResult.getOrElse(permission, () => "unsupported") === "default"
  if (!web || !undecided || report.nudges.length === 0) return null
  return (
    <Button size="sm" onClick={() => ask()}>
      Notify me
    </Button>
  )
}

const isSubscription = Schema.is(SubscriptionId)

/** A row of Needs attention, with what can be done about it. */
function AttentionRow({ item }: { readonly item: Attention }) {
  const start = useAtomSet(signIn)
  const openCredits = useAtomSet(openCreditsAtom)
  const canChange = useAtomValue(canChangeAtom)
  const show = () => go(Pages.provider(item.provider))
  const provider = item.provider
  return (
    <div className="flex items-center gap-3 border-t border-separator px-4 py-2.5 first:border-t-0">
      <Dot tone={item.tone} />
      <span className="min-w-0 flex-1">{item.text}</span>
      {item.remedy === "sign-in" && isSubscription(provider) ? (
        <Button size="sm" disabled={!canChange} onClick={() => start({ provider })}>
          Sign in…
        </Button>
      ) : item.remedy === "redeem" ? (
        <Button
          size="sm"
          onClick={() => {
            openCredits(Option.some(item.account))
            show()
          }}
        >
          Redeem…
        </Button>
      ) : (
        <Button size="sm" onClick={show}>
          Show
        </Button>
      )}
    </div>
  )
}

/** One subscription at a glance; it opens its provider's page. */
function PoolBlock({ group }: { readonly group: Group }) {
  return (
    <button
      type="button"
      aria-label={`${group.title} accounts`}
      onClick={() => go(Pages.provider(group.provider))}
      className="flex w-full cursor-default flex-col gap-2.5 border-t border-separator px-4 py-3.5 text-left outline-none first:border-t-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex items-center gap-2">
        <span className="font-medium">{group.title}</span>
        <span className="text-small text-muted-foreground">
          {group.ready} of {group.enabled} ready
        </span>
        <span className="flex-1" />
        <ChevronRight aria-hidden className="size-4 text-faint" />
      </span>
      {group.overview.map((window) => (
        // Narrow, the reset line takes a line of its own beneath the bar.
        <span key={window.title} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-3.5">
          <span className="w-25 shrink-0 truncate text-small text-muted-foreground">{window.title}</span>
          <span className="min-w-16 flex-1">
            <SegmentedBar window={window} weighted={group.weighted} />
          </span>
          <span className="w-10 shrink-0 text-right font-medium tabular">{window.gauge.percent}</span>
          <span className="w-full truncate text-caption text-faint tabular @xl:w-48 @xl:shrink-0">
            {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
          </span>
        </span>
      ))}
      {group.credits !== undefined && <span className="pl-3.5 text-small text-muted-foreground">{group.credits}</span>}
      <span className="pl-3.5 text-small">
        <Label tone={group.next.tone} text={group.next.text} raw />
      </span>
    </button>
  )
}

/** API keys and compatible endpoints: billed per token, so no windows to show. */
function Metered({ group }: { readonly group: Group }) {
  return (
    <button
      type="button"
      aria-label={`${group.title} accounts`}
      onClick={() => go(Pages.provider(group.provider))}
      className="flex w-full cursor-default items-center gap-3 border-t border-separator px-4 py-3 text-left outline-none first:border-t-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="w-40 shrink-0 font-medium">{group.title}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {group.rows.map((row) => (
          <span key={row.id} className="inline-flex min-w-0 items-center gap-2 text-small">
            <span className="truncate">{row.name}</span>
            <Label tone={row.status.tone} text={row.status.text} />
          </span>
        ))}
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
    </button>
  )
}

function Today() {
  const today = useAtomValue(historyAtom("today"))
  return (
    <Loaded result={today} title="Could not read today's ledger" loading={<Skeleton lines={4} />}>
      {(history) => (
        <div className="flex flex-col gap-3">
          <Stats stats={todayStats(history)} />
          <Panel>
            <div className="px-4 pt-4 pb-3">
              <Hours values={hourly(history)} />
            </div>
          </Panel>
        </div>
      )}
    </Loaded>
  )
}

export function OverviewPage() {
  const shown = useAtomValue(shownReportAtom)
  const items = useAtomValue(attentionAtom)
  const all = useAtomValue(groupsAtom)
  if (Option.isNone(shown)) {
    return (
      <Empty icon={Radio} title="Looking for the proxy…" detail="slopmax shows your accounts as soon as it answers." />
    )
  }
  const report = shown.value
  if (report.accounts.length === 0) {
    return (
      <Empty
        icon={Users}
        title="No accounts yet"
        detail="Sign in, import your agents' logins, or add an API key, with Add account above."
      >
        <Button variant="primary" onClick={() => go(Pages.access)}>
          <Plus />
          Add account
        </Button>
      </Empty>
    )
  }
  const pools = all.filter((group) => group.subscription && group.overview.length > 0)
  const metered = all.filter((group) => !group.subscription)
  return (
    <>
      <Standing report={report} />
      {items.length > 0 && (
        <Section
          title="Needs attention"
          trailing={
            <span className="flex items-center gap-2">
              <Badge>{items.length}</Badge>
              <NotifyMe report={report} />
            </span>
          }
        >
          <Panel>
            {items.map((item, i) => (
              // Its words count down, so the key is what it is about rather than what it says.
              <AttentionRow key={`${item.account}-${item.remedy}-${i}`} item={item} />
            ))}
          </Panel>
        </Section>
      )}
      {pools.length > 0 && (
        <Section title="Subscriptions">
          <Panel>
            {pools.map((group) => (
              <PoolBlock key={group.provider} group={group} />
            ))}
          </Panel>
        </Section>
      )}
      {metered.length > 0 && (
        <Section title="Keys and endpoints">
          <Panel>
            {metered.map((group) => (
              <Metered key={group.provider} group={group} />
            ))}
          </Panel>
        </Section>
      )}
      <Section title="Today">
        <Today />
      </Section>
    </>
  )
}
