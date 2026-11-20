// Request outcomes, routing readiness, and subscription limits at a glance.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type History, type HistoryRange, type Report, SubscriptionId } from "@slopmax/client"
import { grouped, providerTitle } from "@slopmax/client/format"
import { DateTime, Duration, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowUpCircle, ChevronRight, Plus, Radio, Users } from "lucide-react"
import { useState } from "react"
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
  requestFilterAtom,
  requestLimitAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
  zone,
} from "../atoms.ts"
import { Legend, RequestColumns, requestInks } from "../components/charts.tsx"
import { HealthCard, RecentFailures } from "../components/health.tsx"
import { Dot, Empty, Label, Loaded, Panel, Section, SegmentedBar, Skeleton, StatChange } from "../components/parts.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Alert, AlertTitle } from "../components/ui/alert.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Item, ItemActions, ItemContent, ItemHeader, ItemMedia, ItemTitle } from "../components/ui/item.tsx"
import { type Attention, standing } from "../view/attention.ts"
import { type Group, nextAccountBack, nextQuotaReset, resetsLeft } from "../view/groups.ts"
import { Pages } from "../view/pages.ts"
import { pageSize } from "../view/requests.ts"
import { activityStats, isQuiet, previousRequests, requestTotal } from "../view/usage.ts"
import {
  limitsNotRead,
  rangeTitle,
  ranges,
  releaseNotes,
  resetCount,
  resetsLine,
  segmentsShown,
  strategyTitle,
  updated,
} from "../view/words.ts"

/** A newer slopmax, with the command that updates this install and its release notes. */
function UpdateBanner({ report }: { readonly report: Report }) {
  const copyText = useAtomSet(copy)
  const open = useAtomSet(openExternal)
  const update = report.update
  if (update === undefined) return null
  return (
    <Alert>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <AlertTitle>
            <span className="flex items-center gap-2">
              <ArrowUpCircle aria-hidden className="size-4 shrink-0" />
              slopmax {update.version} is out
            </span>
          </AlertTitle>
          <code className="text-xs text-muted-foreground wrap-anywhere select-text">{update.command}</code>
        </div>
        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>
    </Alert>
  )
}

function Standing({ report, providers }: { readonly report: Report; readonly providers: ReadonlyArray<Group> }) {
  const now = useAtomValue(nowAtom)
  const settings = useAtomValue(settingsAtom)
  const stand = standing(report)
  const strategy = strategyTitle(
    Option.match(AsyncResult.value(settings), {
      onNone: () => report.strategy,
      onSome: (view) => view.settings.strategy,
    }),
  )
  const age = Duration.toSeconds(DateTime.distance(report.generatedAt, now))
  const banked = report.accounts.reduce((sum, account) => sum + resetsLeft(account, now), 0)
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>Account readiness</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-lg leading-tight font-semibold">
            <Dot tone={stand.tone} />
            {stand.headline}
          </p>
          {stand.detail !== undefined && <p className="text-sm text-muted-foreground">{stand.detail}</p>}
          {banked > 0 && <p className="text-sm text-muted-foreground">{resetCount(banked)} held</p>}
          {providers.length > 0 && (
            <ul className="mt-2 divide-y" aria-label="Accounts ready by provider">
              {providers.map((group) => (
                <li key={group.provider} className="flex justify-between gap-2 py-1.5 text-xs">
                  <span className="font-medium">{group.title}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {group.enabled === 0 ? "All turned off" : `${group.ready} of ${group.enabled} ready`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-auto">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Routing settings, ${strategy}`}
            onClick={() => go(Pages.settings)}
          >
            Routing / {strategy}
            <ChevronRight aria-hidden data-icon="inline-end" />
          </Button>
          <span className="text-xs text-muted-foreground">{updated(age)}</span>
        </div>
      </CardFooter>
    </Card>
  )
}

function Capacity({ report }: { readonly report: Report }) {
  const now = useAtomValue(nowAtom)
  const back = nextAccountBack(report.accounts, now, zone)
  const reset = back === undefined ? nextQuotaReset(report, now, zone) : undefined
  const next = back ?? reset
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>{back === undefined ? "Next quota reset" : "Next account back"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {next === undefined ? (
          <p className="text-muted-foreground">No upcoming reset reported.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-2xl leading-tight font-semibold tracking-tight tabular-nums">In {next.countdown}</p>
            <p className="text-sm text-muted-foreground">
              {reset === undefined ? `Quota block ends ${next.at}` : `${reset.window} quota resets ${next.at}`}
            </p>
          </div>
        )}
      </CardContent>
      {next !== undefined && (
        <CardFooter className="mt-auto">
          <Button
            variant="ghost"
            size="xs"
            className="w-fit max-w-full justify-start"
            onClick={() => go(Pages.provider(next.provider))}
          >
            <span className="truncate" title={next.account}>
              {providerTitle(next.provider)} / {next.account}
            </span>
            <ChevronRight aria-hidden data-icon="inline-end" />
          </Button>
        </CardFooter>
      )}
    </Card>
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
              View account
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <CardTitle>
              <h3>{group.title}</h3>
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {group.enabled === 0 ? "All turned off" : `${group.ready} of ${group.enabled} ready`}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`View ${group.title} accounts`}
            onClick={() => go(Pages.provider(group.provider))}
          >
            Accounts
            <ChevronRight aria-hidden data-icon="inline-end" />
          </Button>
        </div>
        {group.overview.some((window) => window.shares.length > 1 && window.shares.length <= segmentsShown) && (
          <CardDescription>Each bar segment represents one account.</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {group.overview.map((window) => (
            <div key={window.title} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span>{window.title}</span>
                <span className="shrink-0 font-medium tabular-nums">{window.gauge.percent} used across accounts</span>
              </div>
              <SegmentedBar window={window} weighted={group.weighted} />
              <p className="text-xs text-muted-foreground tabular-nums">
                {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
              </p>
            </div>
          ))}
          {group.unread && <p className="text-xs text-muted-foreground">{limitsNotRead(pollOff)}</p>}
          {group.credits !== undefined && <p className="text-xs text-muted-foreground">{group.credits}</p>}
          <p className="text-xs">
            <Label tone={group.next.tone} text={group.next.text} raw wrap />
          </p>
        </div>
      </CardContent>
    </Card>
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
        className="cursor-default text-left"
      >
        <ItemHeader>
          <ItemTitle>{group.title}</ItemTitle>
          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
        </ItemHeader>
        <ItemContent className="min-w-0 basis-full">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {group.rows.map((row) => (
              <span key={row.id} className="inline-flex min-w-0 items-center gap-2 text-xs">
                <span className="truncate">{row.name}</span>
                <Label tone={row.status.tone} text={row.status.text} />
              </span>
            ))}
          </span>
        </ItemContent>
      </Item>
    </div>
  )
}

const activityRanges = ranges.map((value) => ({ value, title: rangeTitle(value) }))

function ActivityPlot({ history }: { readonly history: History }) {
  const { total, range } = history
  const comparison = previousRequests(history)
  const requests = requestTotal(total)
  const quiet = isQuiet(history)
  return (
    <>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-4xl leading-none font-semibold tracking-tight tabular-nums @lg/activity:text-5xl">
                  {grouped(requests)}
                </span>
                <span className="text-base font-medium">{requests === 1 ? "request" : "requests"}</span>
              </p>
              {comparison !== undefined && <p className="mt-1 text-xs text-muted-foreground">{comparison}</p>}
            </div>
            <Legend
              items={[
                { ink: requestInks.answered, title: `${grouped(total.requests)} answered` },
                { ink: requestInks.failed, title: `${grouped(total.failed)} failed` },
              ]}
            />
          </div>
          {quiet ? (
            <Quiet title={range === "today" ? "No requests recorded today" : "No requests recorded in this range"} />
          ) : (
            <RequestColumns history={history} size="lg" />
          )}
        </div>
      </CardContent>
      {!quiet && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t px-4 pt-4 @xl/activity:grid-cols-4">
          {activityStats(history).map((stat) => (
            <div key={stat.title} className="row-span-4 grid min-w-0 grid-rows-subgrid pb-3 @xl/activity:pb-0">
              <dt className="text-xs font-medium">{stat.title}</dt>
              <dd className="text-xl leading-tight font-semibold tracking-tight tabular-nums">{stat.value}</dd>
              <dd aria-hidden={stat.change === undefined} className="text-xs">
                {stat.change !== undefined && <StatChange change={stat.change} />}
              </dd>
              <dd className="text-xs text-muted-foreground">{stat.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}

function RequestActivity() {
  const [range, setRange] = useState<HistoryRange>("today")
  const history = useAtomValue(historyAtom(range))
  const refresh = useAtomRefresh(historyAtom(range))
  const setFilter = useAtomSet(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  return (
    <Card className="@container/activity min-w-0 @4xl:col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle>
            <h2>Request activity</h2>
          </CardTitle>
          <Segmented label="Activity range" value={range} options={activityRanges} onChange={setRange} />
        </div>
      </CardHeader>
      <Loaded
        result={history}
        title="Could not load request activity"
        loading={
          <CardContent>
            <div className="min-h-72 sm:min-h-80">
              <Skeleton lines={6} />
            </div>
          </CardContent>
        }
        onRetry={refresh}
      >
        {(found) => found.range === range && <ActivityPlot history={found} />}
      </Loaded>
      <CardContent className="mt-auto flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilter({ span: range, outcome: "all" })
            setLimit(pageSize)
            go(Pages.requests)
          }}
        >
          View requests
          <ChevronRight aria-hidden data-icon="inline-end" />
        </Button>
      </CardContent>
    </Card>
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
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
        <RequestActivity />
        <div className="grid min-w-0 content-start gap-4 @xl:grid-cols-2 @4xl:grid-cols-1 @4xl:grid-rows-[auto_1fr]">
          <Standing report={report} providers={all} />
          {pools.length > 0 && <Capacity report={report} />}
        </div>
      </div>
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
      {pools.length > 0 && (
        <Section title="Subscription limits">
          <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
            {pools.map((group) => (
              <PoolBlock key={group.provider} group={group} />
            ))}
          </div>
        </Section>
      )}
      <Section title="Request health">
        <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
          {pools.length > 0 && <HealthCard groups={pools} />}
          <RecentFailures />
        </div>
      </Section>
      {metered.length > 0 && (
        <Section title="Keys and endpoints">
          <Panel>
            {metered.map((group) => (
              <Metered key={group.provider} group={group} />
            ))}
          </Panel>
        </Section>
      )}
    </>
  )
}
