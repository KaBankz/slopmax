// The overview: how the accounts stand in a line, what wants a look, a
// day's API value and tokens over the month, each subscription's pool at a
// glance, keys and endpoints, and today so far.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Report, SubscriptionId } from "@slopmax/client"
import { DateTime, Duration, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowUpCircle, ChevronRight, Plus, Radio, Users } from "lucide-react"
import {
  askNotifications,
  attentionAtom,
  canChangeAtom,
  copy,
  go,
  groupsAtom,
  historyAtom,
  nowAtom,
  openCreditsAtom,
  openExternal,
  permissionAtom,
  pollOffAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
} from "../atoms.ts"
import { Hours } from "../components/charts.tsx"
import { HealthCard, RecentFailures } from "../components/health.tsx"
import { Dot, Empty, Label, Loaded, Panel, Section, SegmentedBar, Skeleton, Stats } from "../components/parts.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Tip } from "../components/tip.tsx"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent } from "../components/ui/card.tsx"
import { Item, ItemActions, ItemContent, ItemHeader, ItemMedia, ItemTitle } from "../components/ui/item.tsx"
import { type Attention, standing } from "../view/attention.ts"
import { type Group, resetsLeft } from "../view/groups.ts"
import { Pages } from "../view/pages.ts"
import { dailyStats, hourTip, hourly, isQuiet, todayStats } from "../view/usage.ts"
import { limitsNotRead, releaseNotes, resetCount, resetsLine, routing, updated } from "../view/words.ts"

/** A newer slopmax, with the command that updates this install and its release notes. */
function UpdateBanner({ report }: { readonly report: Report }) {
  const copyText = useAtomSet(copy)
  const open = useAtomSet(openExternal)
  const update = report.update
  if (update === undefined) return null
  return (
    <Alert>
      <ArrowUpCircle />
      <AlertTitle>slopmax {update.version} is out</AlertTitle>
      <AlertDescription>
        This is {report.version}. Update with <code className="font-mono text-xs">{update.command}</code>; the proxy
        moves to the new one without dropping a request.
      </AlertDescription>
      <AlertAction>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => open(releaseNotes(update.version))}>
            What's new
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyText({ text: update.command, said: "Copied the update command." })}
          >
            Copy command
          </Button>
        </span>
      </AlertAction>
    </Alert>
  )
}

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
        <span className="shrink-0 text-xs text-muted-foreground">{updated(age)}</span>
      </div>
      {/* A ghost Button keeps the color around it, so the line reads as quiet as its neighbors. */}
      <span className="shrink-0 text-muted-foreground">
        <Tip content="Change in Settings">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Routing: ${line}. Change it in Settings`}
            onClick={() => go(Pages.settings)}
          >
            {line}
            <ChevronRight aria-hidden data-icon="inline-end" />
          </Button>
        </Tip>
      </span>
    </div>
  )
}

function NotifyMe({ report }: { readonly report: Report }) {
  const permission = useAtomValue(permissionAtom)
  const ask = useAtomSet(askNotifications)
  const undecided = AsyncResult.getOrElse(permission, () => "unsupported") === "default"
  if (!undecided || report.nudges.length === 0) return null
  return (
    <Button variant="outline" size="sm" onClick={() => ask()}>
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
    <div className="border-t first:border-t-0">
      <Item className="flex-nowrap">
        <ItemMedia>
          <Dot tone={item.tone} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <p>{item.text}</p>
        </ItemContent>
        <ItemActions>
          {item.remedy === "sign-in" && isSubscription(provider) ? (
            <Button variant="outline" size="sm" disabled={!canChange} onClick={() => start({ provider })}>
              Sign in…
            </Button>
          ) : item.remedy === "redeem" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                openCredits(Option.some(item.account))
                show()
              }}
            >
              Redeem…
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={show}>
              Show
            </Button>
          )}
        </ItemActions>
      </Item>
    </div>
  )
}

/** One subscription at a glance; it opens its provider's page. */
function PoolBlock({ group }: { readonly group: Group }) {
  const pollOff = useAtomValue(pollOffAtom)
  return (
    // The rule and the hover sit on the row around the Item, which keeps shadcn's own look.
    <div className="border-t first:border-t-0 hover:bg-accent">
      <Item
        render={<button type="button" />}
        aria-label={`${group.title} accounts`}
        onClick={() => go(Pages.provider(group.provider))}
        className="cursor-default text-left"
      >
        <ItemHeader>
          <span className="flex min-w-0 items-center gap-2">
            <ItemTitle>{group.title}</ItemTitle>
            <span className="text-xs text-muted-foreground">
              {group.ready} of {group.enabled} ready
            </span>
          </span>
          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
        </ItemHeader>
        <ItemContent className="basis-full">
          <span className="flex flex-col gap-2.5 pl-3.5">
            {group.overview.map((window) => (
              // Narrow, the reset line takes a line of its own beneath the bar.
              <span key={window.title} className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                <span className="w-25 shrink-0 truncate text-xs text-muted-foreground">{window.title}</span>
                <span className="min-w-16 flex-1">
                  <SegmentedBar window={window} weighted={group.weighted} />
                </span>
                <span className="w-10 shrink-0 text-right font-medium tabular-nums">{window.gauge.percent}</span>
                <span className="w-full truncate text-xs text-muted-foreground tabular-nums @xl:w-48 @xl:shrink-0">
                  {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
                </span>
              </span>
            ))}
            {group.unread && <span className="text-xs text-muted-foreground">{limitsNotRead(pollOff)}</span>}
            {group.credits !== undefined && <span className="text-xs text-muted-foreground">{group.credits}</span>}
            <span className="text-xs">
              <Label tone={group.next.tone} text={group.next.text} raw />
            </span>
          </span>
        </ItemContent>
      </Item>
    </div>
  )
}

/** API keys and compatible endpoints: billed per token, so no windows to show. */
function Metered({ group }: { readonly group: Group }) {
  return (
    <div className="border-t first:border-t-0 hover:bg-accent">
      <Item
        render={<button type="button" />}
        aria-label={`${group.title} accounts`}
        onClick={() => go(Pages.provider(group.provider))}
        className="cursor-default flex-nowrap text-left"
      >
        <ItemTitle className="w-40 shrink-0">{group.title}</ItemTitle>
        <ItemContent className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {group.rows.map((row) => (
              <span key={row.id} className="inline-flex min-w-0 items-center gap-2 text-xs">
                <span className="truncate">{row.name}</span>
                <Label tone={row.status.tone} text={row.status.text} />
              </span>
            ))}
          </span>
        </ItemContent>
        <ItemActions>
          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
    </div>
  )
}

/** A day's API value and tokens, as the last week went and over the month; nothing before a whole day is in. */
function PerDay() {
  const month = useAtomValue(historyAtom("30d"))
  const stats = Option.match(AsyncResult.value(month), { onNone: () => [], onSome: dailyStats })
  if (stats.length === 0) return null
  return (
    <Section title="Per day">
      <Stats stats={stats} size="lg" />
    </Section>
  )
}

function Today() {
  const today = useAtomValue(historyAtom("today"))
  const again = useAtomRefresh(historyAtom("today"))
  return (
    <Loaded result={today} title="Could not read today's ledger" loading={<Skeleton lines={4} />} onRetry={again}>
      {(history) =>
        isQuiet(history) ? (
          <Quiet title="Nothing yet today" />
        ) : (
          <div className="flex flex-col gap-3">
            <Stats stats={todayStats(history)} />
            <Card>
              <CardContent>
                <Hours values={hourly(history)} tip={hourTip} ink="spark-2" />
              </CardContent>
            </Card>
          </div>
        )
      }
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
        <Button onClick={() => go(Pages.access)}>
          <Plus />
          Add account
        </Button>
      </Empty>
    )
  }
  // A subscription shows even before its limits are read, so a new sign-in appears at once.
  const pools = all.filter((group) => group.subscription)
  const metered = all.filter((group) => !group.subscription)
  return (
    <>
      <UpdateBanner report={report} />
      <Standing report={report} />
      {items.length > 0 && (
        <Section
          title="Needs attention"
          trailing={
            <span className="flex items-center gap-2">
              <Badge variant="secondary">{items.length}</Badge>
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
      <PerDay />
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
      {pools.length > 0 && (
        <Section title="Health">
          <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
            <HealthCard groups={pools} />
            <RecentFailures />
          </div>
        </Section>
      )}
      <Section title="Today">
        <Today />
      </Section>
    </>
  )
}
