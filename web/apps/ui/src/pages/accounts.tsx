// A directory of accounts and the provider pools that route to them.
import { useAtomValue } from "@effect/atom-react"
import { until } from "@slopmax/client/format"
import { type DateTime, Option } from "effect"
import { ChevronRight, Radio, UsersRound } from "lucide-react"
import { attentionAtom, groupsAtom, nowAtom, shownReportAtom, unansweredAtom } from "../atoms.ts"
import { Empty, Label, Section } from "../components/parts.tsx"
import { ButtonLink } from "../components/ui/button.tsx"
import { Card, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Item, ItemActions, ItemContent, ItemTitle } from "../components/ui/item.tsx"
import { worstTone } from "../view/attention.ts"
import { type Group, type Row, spanTitle } from "../view/groups.ts"
import { pageHash, Pages } from "../view/pages.ts"
import { quotaPercent } from "../view/quota.ts"

function AccountRow({
  row,
  now,
  current,
}: {
  readonly row: Row
  readonly now: DateTime.Utc
  readonly current: boolean
}) {
  // The tightest shared window, with the sooner reset first when allowance is equal.
  const window =
    current && !row.disabled && !row.signedOut
      ? row.account.windows
          .filter(
            (found) =>
              found.model === undefined &&
              (found.resetsAt === undefined || found.resetsAt.epochMilliseconds > now.epochMilliseconds),
          )
          .toSorted(
            (a, b) =>
              b.used - a.used ||
              (a.resetsAt?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER) -
                (b.resetsAt?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER),
          )[0]
      : undefined
  return (
    <div className="border-t">
      <Item variant="directory" render={<a href={pageHash(Pages.provider(row.account.provider, row.id))} />}>
        <ItemContent className="min-w-0">
          <ItemTitle className="wrap-anywhere">{row.name}</ItemTitle>
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <Label tone={row.status.tone} text={row.status.text} wrap />
            {row.plan !== "" && <span className="text-muted-foreground">{row.plan}</span>}
            {row.lastUsed !== undefined && <span className="text-muted-foreground">{row.lastUsed}</span>}
          </p>
        </ItemContent>
        <ItemActions className="justify-end">
          {window !== undefined && (
            <div className="text-right text-xs tabular-nums">
              <p className="font-medium">
                {quotaPercent(100 - window.used)} left · {spanTitle(window.span)}
              </p>
              <p
                data-unavailable={window.resetsAt === undefined || undefined}
                className="text-muted-foreground data-unavailable:max-w-24 @sm:data-unavailable:max-w-none"
              >
                {window.resetsAt === undefined ? "Reset time unavailable" : `Resets in ${until(window.resetsAt, now)}`}
              </p>
            </div>
          )}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </ItemActions>
      </Item>
    </div>
  )
}

function ProviderCard({
  group,
  now,
  current,
  attention,
}: {
  readonly group: Group
  readonly now: DateTime.Utc
  readonly current: boolean
  readonly attention: ReturnType<typeof worstTone>
}) {
  const detail =
    group.ready === group.rows.length ? `${group.ready} ready` : `${group.ready} of ${group.rows.length} ready`
  return (
    <Card size="flush">
      <CardHeader className="my-4">
        <div className="flex flex-wrap items-start justify-between gap-x-3">
          <CardTitle>
            <h3>{group.title}</h3>
          </CardTitle>
          <ButtonLink
            href={pageHash(Pages.provider(group.provider))}
            variant="link"
            size="sm"
            aria-label={`${group.subscription ? "View pool" : "Manage accounts"} for ${group.title}`}
          >
            {group.subscription ? "View pool" : "Manage accounts"}
            <ChevronRight aria-hidden data-icon="inline-end" />
          </ButtonLink>
        </div>
        <CardDescription>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <span>{detail}</span>
            {attention !== undefined && <Label tone={attention} text="Needs attention" />}
          </span>
          {group.subscription && (
            <span className="mt-1 block text-xs">
              <Label tone={group.next.tone} text={group.next.text} raw wrap />
            </span>
          )}
        </CardDescription>
      </CardHeader>
      {group.rows.map((row) => (
        <AccountRow key={row.id} row={row} now={now} current={current} />
      ))}
    </Card>
  )
}

export function AccountsPage() {
  const report = useAtomValue(shownReportAtom)
  const groups = useAtomValue(groupsAtom)
  const attention = useAtomValue(attentionAtom)
  const now = useAtomValue(nowAtom)
  const offline = useAtomValue(unansweredAtom)
  if (Option.isNone(report)) {
    return (
      <Empty icon={Radio} title="Looking for the proxy…" detail="Provider accounts appear when the proxy answers." />
    )
  }
  if (groups.length === 0) {
    return (
      <Empty
        icon={UsersRound}
        title="No accounts yet"
        detail="Add a subscription, an API key, or a compatible endpoint."
      />
    )
  }
  const current = report.value.live && !offline
  const providers = (subscription: boolean) =>
    groups
      .filter((group) => group.subscription === subscription)
      .map((group) => (
        <ProviderCard
          key={group.provider}
          group={group}
          now={now}
          current={current}
          attention={worstTone(attention, group.provider)}
        />
      ))
  const subscriptions = providers(true)
  const metered = providers(false)
  return (
    <div className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      <Section title="Subscriptions">
        {subscriptions.length > 0 ? (
          subscriptions
        ) : (
          <p className="text-sm text-muted-foreground">No subscription accounts connected.</p>
        )}
      </Section>
      <Section title="API keys and endpoints">
        {metered.length > 0 ? metered : <p className="text-sm text-muted-foreground">No metered accounts connected.</p>}
      </Section>
    </div>
  )
}
