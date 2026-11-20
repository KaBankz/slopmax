// Reset opportunities, account readiness, and subscription limits.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Report, SubscriptionId } from "@slopmax/client"
import { DateTime, Duration, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowUpCircle, ChevronRight, Gauge, Plus, Radio, Users } from "lucide-react"
import {
  askNotifications,
  attentionAtom,
  canChangeAtom,
  copy,
  go,
  groupsAtom,
  nowAtom,
  openCreditsAtom,
  openExternal,
  permissionAtom,
  pollOffAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
  zone,
} from "../atoms.ts"
import { Dot, Empty, Label, Panel, Section, SegmentedBar } from "../components/parts.tsx"
import { QuotaBoard } from "../components/quota-board.tsx"
import { Alert, AlertTitle } from "../components/ui/alert.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button, ButtonLink } from "../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Item, ItemActions, ItemContent, ItemMedia } from "../components/ui/item.tsx"
import { type Attention, standing } from "../view/attention.ts"
import { type Group, nextAccountBack, resetsLeft } from "../view/groups.ts"
import { pageHash, Pages } from "../view/pages.ts"
import {
  limitsNotRead,
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
            onClick={() =>
              copyText({
                text: update.command,
                said: "Copied the update command.",
              })
            }
          >
            Copy command
          </Button>
        </div>
      </div>
    </Alert>
  )
}

function Standing({ report }: { readonly report: Report }) {
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
  const back = nextAccountBack(report.accounts, now, zone)
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
          {back !== undefined && <p className="text-sm text-muted-foreground">Next account back in {back.countdown}</p>}
        </div>
      </CardContent>
      <CardFooter className="mt-auto">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <ButtonLink
            variant="link"
            size="xs"
            href={pageHash(Pages.settings)}
            aria-label={`Routing / ${strategy}, open settings`}
          >
            Routing / {strategy}
            <ChevronRight aria-hidden data-icon="inline-end" />
          </ButtonLink>
          <span className="text-xs text-muted-foreground">{updated(age)}</span>
        </div>
      </CardFooter>
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
  const show = () => go(Pages.provider(item.provider, item.account))
  const provider = item.provider
  const report = Option.getOrUndefined(useAtomValue(shownReportAtom))
  const name = report?.accounts.find((account) => account.id === item.account)?.name
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
            <Button
              variant="outline"
              size="sm"
              disabled={!canChange}
              aria-label={name === undefined ? undefined : `Sign in again to ${name}`}
              onClick={() => start({ provider })}
            >
              Sign in again
            </Button>
          ) : item.remedy === "redeem" ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={name === undefined ? undefined : `Redeem reset for ${name}`}
              onClick={() => {
                openCredits(Option.some(item.account))
                show()
              }}
            >
              Redeem reset
            </Button>
          ) : (
            <ButtonLink variant="outline" size="sm" href={pageHash(Pages.provider(item.provider, item.account))}>
              View account
            </ButtonLink>
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
          <ButtonLink
            variant="ghost"
            size="sm"
            aria-label={`Accounts for ${group.title}`}
            href={pageHash(Pages.provider(group.provider))}
          >
            Accounts
            <ChevronRight aria-hidden data-icon="inline-end" />
          </ButtonLink>
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
        detail="Sign in, import an agent login, or add an API key to get started."
      >
        <ButtonLink href={pageHash(Pages.addAccount)}>
          <Plus />
          Add account
        </ButtonLink>
      </Empty>
    )
  }
  // A subscription shows even before its limits are read, so a new sign-in appears at once.
  const pools = all.filter((group) => group.subscription)
  return (
    <>
      {pools.length > 0 ? (
        <QuotaBoard report={report} />
      ) : (
        <Empty
          icon={Gauge}
          title="No subscription quota to track"
          detail="Quota windows appear when you connect a subscription. API keys and compatible endpoints report their requests in Activity."
        >
          <div className="flex flex-wrap justify-center gap-2">
            <ButtonLink variant="outline" href={pageHash(Pages.accounts)}>
              View accounts
            </ButtonLink>
            <ButtonLink href={pageHash(Pages.usage)}>View usage</ButtonLink>
          </div>
        </Empty>
      )}
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
      <Standing report={report} />
      <UpdateBanner report={report} />
    </>
  )
}
