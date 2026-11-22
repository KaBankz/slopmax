// One provider's page: its pool read as one account, then each account
// with a gauge per window, its notes, its limit resets, and a menu of what
// can be done to it.
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type AccountDetail, type PoolDetail, type ProviderId, providerFacts, SubscriptionId } from "@slopmax/client"
import { cva } from "class-variance-authority"
import { Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react"
import { useEffect, useRef } from "react"
import {
  attentionAtom,
  canChangeAtom,
  changeAccount,
  checkAccount,
  groupsAtom,
  nowAtom,
  openCreditsAtom,
  pollOffAtom,
  readOnlyAtom,
  redeem,
  redeemingAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
  unansweredAtom,
  zone,
} from "../atoms.ts"
import { useAsk } from "../components/ask.tsx"
import { HealthStrip, PoolForecast, ResetLanes, usePoolDetail } from "../components/forecast.tsx"
import {
  Dot,
  Empty,
  Label,
  Panel,
  PoolUsageLegend,
  RemainingMeter,
  Section,
  SegmentedBar,
} from "../components/parts.tsx"
import { ProviderMark } from "../components/provider-mark.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button, ButtonLink } from "../components/ui/button.tsx"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "../components/ui/item.tsx"
import { askOwn, askPriority, askRedeem, askRemove, askRename, readPriority } from "../view/asks.ts"
import { health, lanes, type SpendView, spendView } from "../view/forecast.ts"
import { across, type Gauge, type Group, type Row } from "../view/groups.ts"
import { cannotChange } from "../view/live.ts"
import { pageHash, Pages } from "../view/pages.ts"
import { quotaPercent } from "../view/quota.ts"
import { autoRedeem, limitsNotRead, resetsLine, resetsUnlisted } from "../view/words.ts"

function PoolCells({ group }: { readonly group: Group }) {
  return (
    <Panel>
      <div className="pool-columns grid gap-px bg-border">
        {group.overview.map((window) => (
          <div key={window.title} className="flex min-w-0 flex-col gap-2 bg-card p-5">
            <span className="text-xs text-muted-foreground">{window.title}</span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-2xl tabular-nums">{quotaPercent((1 - window.gauge.fraction) * 100)}</span>
              <span className="text-xs text-muted-foreground">left</span>
            </span>
            <SegmentedBar window={window} weighted={group.weighted} />
            <span className="text-xs text-muted-foreground tabular-nums">
              {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
            </span>
          </div>
        ))}
      </div>
      <CardFooter density="compact">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span>{across(group)}. Each bar segment shows one account when space allows.</span>
          {group.credits !== undefined && <span>{group.credits}</span>}
          <div className="basis-full empty:hidden">
            <PoolUsageLegend windows={group.overview} />
          </div>
        </div>
      </CardFooter>
    </Panel>
  )
}

const cellVariants = cva("flex min-w-30 flex-1 flex-col gap-1.5", {
  variants: { faded: { true: "text-muted-foreground", false: "" } },
})

/** The window's name over its cell, where the table is too narrow for its header row. */
function CellTitle({ title }: { readonly title: string }) {
  return <span className="truncate text-xs text-muted-foreground @3xl:hidden">{title}</span>
}

function WindowCell({
  title,
  gauge,
  faded,
  spend,
}: {
  readonly title: string
  readonly gauge: Gauge | undefined
  readonly faded: boolean
  readonly spend: SpendView | undefined
}) {
  if (gauge === undefined) {
    return (
      <div className="flex min-w-30 flex-1 flex-col gap-1.5">
        <CellTitle title={title} />
        <span className="text-muted-foreground">—</span>
      </div>
    )
  }
  return (
    <div className={cellVariants({ faded })}>
      <CellTitle title={title} />
      <span
        data-tone={gauge.tone}
        className="font-medium tabular-nums data-[tone=bad]:text-destructive data-[tone=warn]:text-warning"
      >
        {quotaPercent((1 - gauge.fraction) * 100)} left
      </span>
      <RemainingMeter
        used={gauge.fraction}
        tone={gauge.tone}
        {...(gauge.pace === undefined ? {} : { elapsed: gauge.pace.elapsed })}
      />
      <span className="flex min-w-0 flex-wrap gap-x-2 text-xs">
        <span className="text-muted-foreground tabular-nums">{resetsLine(gauge.resetsIn, gauge.resetsAt)}</span>
        {gauge.pace !== undefined && <Label tone={gauge.pace.label.tone} text={gauge.pace.label.text} raw />}
      </span>
      {spend !== undefined && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {spend.line}
          {spend.line === "Not priced" ? "" : " at API prices"}
        </p>
      )}
    </div>
  )
}

/** Everything that can be done to one account. */
function AccountMenu({ row, inlinePin }: { readonly row: Row; readonly inlinePin: boolean }) {
  const change = useAtomSet(changeAccount)
  const check = useAtomSet(checkAccount)
  const openCredits = useAtomSet(openCreditsAtom)
  const canChange = useAtomValue(canChangeAtom)
  const ask = useAsk()
  const { account } = row
  const id = row.id
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={`More for ${row.name}`} disabled={!canChange}>
            <Ellipsis />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          {row.pinned ? (
            <DropdownMenuItem onClick={() => change({ _tag: "UnpinAll" })}>Stop pinning</DropdownMenuItem>
          ) : (
            !inlinePin && (
              <DropdownMenuItem disabled={row.disabled} onClick={() => change({ _tag: "Pin", id })}>
                Use for new sessions
              </DropdownMenuItem>
            )
          )}
          {row.account.condition._tag !== "Limited" && (
            <DropdownMenuItem disabled={row.disabled || row.signedOut} onClick={() => check(id)}>
              Check limits
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => change({ _tag: "Enable", id, on: row.disabled })}>
            {row.disabled ? "Enable" : "Disable"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() =>
              void ask(askPriority(account)).then((answer) => {
                const priority = answer === null ? undefined : readPriority(answer)
                if (priority !== undefined) change({ _tag: "Priority", id, priority })
              })
            }
          >
            Priority ({row.priority})…
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() =>
              void ask(askRename(account)).then((answer) => {
                if (answer !== null) change({ _tag: "Rename", id, label: answer })
              })
            }
          >
            Rename…
          </DropdownMenuItem>
          {row.follows !== undefined && (
            <DropdownMenuItem
              onClick={() =>
                void ask(askOwn(account)).then((answer) => {
                  if (answer !== null) change({ _tag: "Own", id })
                })
              }
            >
              Refresh here instead of {row.follows}
            </DropdownMenuItem>
          )}
          {row.credits !== undefined && (
            <DropdownMenuItem disabled={row.credits.held !== undefined} onClick={() => openCredits(Option.some(id))}>
              Redeem a limit reset…
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() =>
            void ask(askRemove(account)).then((answer) => {
              if (answer !== null) change({ _tag: "Remove", id })
            })
          }
        >
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** An account's limit resets, opened beneath it: what one clears, each one, and redeeming one. */
function CreditsWell({ row, provider }: { readonly row: Row; readonly provider: ProviderId }) {
  const now = useAtomValue(nowAtom)
  const redeeming = useAtomValue(redeemingAtom)
  const canChange = useAtomValue(canChangeAtom)
  const unanswered = useAtomValue(unansweredAtom)
  const readOnly = useAtomValue(readOnlyAtom)
  const settings = useAtomValue(settingsAtom)
  const spend = useAtomSet(redeem)
  const ask = useAsk()
  const credits = row.credits
  if (credits === undefined) return null
  const busy = Option.isSome(redeeming) && redeeming.value === row.id
  const policy = Option.flatMap(AsyncResult.value(settings), (view) =>
    Option.fromUndefinedOr(autoRedeem(view.settings, providerFacts[provider].title)),
  )
  const held = !canChange ? (cannotChange(unanswered, readOnly) ?? "Waiting for slopmax") : credits.held
  return (
    <div className="flex animate-in fade-in slide-in-from-top-1 flex-col px-3 pb-2.5">
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>Limit resets</ItemTitle>
          <ItemDescription>Each one resets this account's {credits.clears} windows at once.</ItemDescription>
        </ItemContent>
        <ItemActions>
          {busy ? (
            <span className="text-xs text-muted-foreground">Redeeming…</span>
          ) : (
            <>
              {held !== undefined && <span className="text-xs text-muted-foreground">{held}</span>}
              <Button
                disabled={held !== undefined}
                aria-label={`Redeem reset for ${row.name}`}
                onClick={() =>
                  void ask(askRedeem(row.account, credits.credits[0]?.id, now, zone)).then((answer) => {
                    if (answer === null) return
                    const first = credits.credits[0]?.id
                    spend(first === undefined ? { id: row.id } : { id: row.id, reset: first })
                  })
                }
              >
                Redeem reset
              </Button>
            </>
          )}
        </ItemActions>
        <div className="flex basis-full flex-col gap-2.5 text-xs">
          {credits.credits.length === 0 ? (
            <span className="text-muted-foreground">{resetsUnlisted(credits.count)}</span>
          ) : (
            <div className="flex flex-col">
              {credits.credits.map((credit) => (
                <div key={credit.id} className="flex items-center gap-2 border-t py-2 first:border-t-0">
                  {credit.tone === "warn" && <Dot tone="warn" />}
                  <span className={credit.tone === "warn" ? "flex-1 text-warning" : "flex-1 text-foreground"}>
                    {credit.title === undefined ? credit.line : `${credit.title} · ${credit.line}`}
                  </span>
                  {credit.granted !== undefined && <span className="text-muted-foreground">{credit.granted}</span>}
                </div>
              ))}
            </div>
          )}
          {Option.isSome(policy) && <span className="text-muted-foreground">{policy.value}</span>}
        </div>
      </Item>
    </div>
  )
}

/** Signing an account in again, beside the account that needs it. */
function SignInAgain({ row }: { readonly row: Row }) {
  const items = useAtomValue(attentionAtom)
  const canChange = useAtomValue(canChangeAtom)
  const start = useAtomSet(signIn)
  const provider = row.account.provider
  const needs = items.some((item) => item.account === row.id && item.remedy === "sign-in")
  if (!needs || !isSubscription(provider)) return null
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      disabled={!canChange}
      aria-label={`Sign in again to ${row.name}`}
      onClick={() => start({ provider })}
    >
      Sign in again
    </Button>
  )
}

/** Checking a limited or throttled account again now, beside its condition. */
function CheckNow({ row }: { readonly row: Row }) {
  const canChange = useAtomValue(canChangeAtom)
  const check = useAtomSet(checkAccount)
  const held = row.account.condition._tag === "Limited" || row.account.condition._tag === "Throttled"
  if (!held || row.disabled) return null
  return (
    <Button
      variant="outline"
      size="xs"
      className="self-start"
      disabled={!canChange}
      aria-label={`Check ${row.name} now`}
      onClick={() => check(row.id)}
    >
      Check now
    </Button>
  )
}

const isSubscription = Schema.is(SubscriptionId)

/** What the account's window in a column has served, for windows over every request. */
const spendOf = (
  detail: AccountDetail | undefined,
  slot: Group["slots"][number] | undefined,
): SpendView | undefined => {
  if (detail === undefined || slot === undefined || slot.model !== undefined) return undefined
  const spend = detail.windows.find((window) => window.span === slot.span)
  return spend === undefined ? undefined : spendView(spend)
}

/** The pool's forecast and resets ahead, once its detail is read. */
function PoolSections({ group, detail }: { readonly group: Group; readonly detail: PoolDetail }) {
  const now = useAtomValue(nowAtom)
  const working = group.rows.filter((row) => !row.disabled && !row.signedOut)
  if (detail.trends.length === 0 && working.length < 2) return null
  return (
    <Section title="Forecast">
      {detail.trends.length > 0 && <PoolForecast group={group} detail={detail} />}
      {working.length > 1 && (
        <ResetLanes
          lanes={lanes(
            working.map((row) => ({
              id: row.id,
              name: row.name,
              windows: row.account.windows,
            })),
            now,
            zone,
          )}
        />
      )}
    </Section>
  )
}

/** Where an account's windows go, before slopmax has read any of the group's. */
function UnreadCell() {
  const pollOff = useAtomValue(pollOffAtom)
  return <span className="min-w-0 flex-1 text-xs text-muted-foreground">{limitsNotRead(pollOff)}</span>
}

function AccountRow({
  row,
  group,
  pool,
  target,
}: {
  readonly row: Row
  readonly group: Group
  readonly pool: PoolDetail | undefined
  readonly target: boolean
}) {
  const detail: AccountDetail | undefined = pool?.accounts.find((account) => account.id === row.id)
  const [open, setOpen] = useAtom(openCreditsAtom)
  const isOpen = Option.isSome(open) && open.value === row.id
  const metered = !group.subscription
  const warnings = row.notes.filter((note) => note.tone === "warn" || note.tone === "bad")
  const details = row.notes.filter((note) => note.tone !== "warn" && note.tone !== "bad")
  const canChange = useAtomValue(canChangeAtom)
  const change = useAtomSet(changeAccount)
  const inlinePin =
    target &&
    !row.pinned &&
    canChange &&
    (row.account.condition._tag === "Ready" || row.account.condition._tag === "Active")
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!target) return
    const frame = requestAnimationFrame(() => {
      anchor.current?.focus({ preventScroll: true })
      anchor.current?.scrollIntoView({ block: "start" })
    })
    return () => cancelAnimationFrame(frame)
  }, [target])
  // Wide, the account is a row of the table. Narrow, its name takes a line of
  // its own, its windows wrap beneath with their names, and its menu stays at
  // the top right, in reach at any width.
  return (
    <div
      ref={anchor}
      tabIndex={target ? -1 : undefined}
      data-highlighted={target || undefined}
      aria-label={target ? row.name : undefined}
      className="scroll-mt-2 border-t first:border-t-0 data-highlighted:focus-within:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <Collapsible open={isOpen} onOpenChange={(next) => setOpen(next ? Option.some(row.id) : Option.none())}>
        <Item className="relative flex-col items-stretch @3xl:flex-row @3xl:flex-nowrap @3xl:items-start">
          <ItemContent className="mr-8 min-w-0 @3xl:mr-0 @3xl:w-60 @3xl:flex-none">
            <ItemTitle className="max-w-full">
              <span className={row.disabled ? "text-muted-foreground wrap-anywhere" : "wrap-anywhere"}>{row.name}</span>
            </ItemTitle>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Label tone={row.status.tone} text={row.status.text} wrap />
              {row.plan !== "" && <span className="text-muted-foreground">{row.plan}</span>}
              {row.next && <Badge>Next</Badge>}
            </span>
            {warnings.map((note) => (
              <Label key={note.text} tone={note.tone} text={note.text} wrap />
            ))}
            <SignInAgain row={row} />
            <CheckNow row={row} />
            {inlinePin && (
              <div className="mt-1">
                <Button variant="secondary" size="sm" onClick={() => change({ _tag: "Pin", id: row.id })}>
                  Use for new sessions
                </Button>
              </div>
            )}
            {row.lastUsed !== undefined && <span className="text-xs text-muted-foreground">{row.lastUsed}</span>}
          </ItemContent>
          {metered ? (
            <dl className="flex min-w-0 flex-1 flex-col gap-2 text-xs @3xl:flex-row @3xl:gap-6">
              {row.account.endpoint !== undefined && (
                <div className="min-w-0">
                  <dt className="font-medium">Address</dt>
                  <dd className="mt-1 font-mono wrap-anywhere text-muted-foreground">{row.account.endpoint}</dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="font-medium">Models</dt>
                <dd className="mt-1 wrap-anywhere text-muted-foreground">
                  {row.account.models.length === 0 ? "Any model" : row.account.models.join(", ")}
                </dd>
              </div>
            </dl>
          ) : group.unread ? (
            <UnreadCell />
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-3 @3xl:contents">
              {row.gauges.map((gauge, i) => (
                <WindowCell
                  key={group.columns[i] ?? i}
                  title={group.columns[i] ?? ""}
                  gauge={gauge}
                  faded={row.faded[i] ?? false}
                  spend={spendOf(detail, group.slots[i])}
                />
              ))}
            </div>
          )}
          <ItemActions className="absolute top-2 right-2 @3xl:static">
            <AccountMenu row={row} inlinePin={inlinePin} />
          </ItemActions>
        </Item>
        {(detail !== undefined || details.length > 0 || row.credits !== undefined) && (
          <div className="-mt-1 flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-3 pb-2.5 text-xs">
            {row.credits !== undefined && (
              <CollapsibleTrigger
                render={<Button variant="ghost" size="xs" className="-ml-2" />}
                aria-label={`${row.credits.title} on ${row.name}`}
              >
                {row.credits.title}
                {isOpen ? (
                  <ChevronDown aria-hidden data-icon="inline-end" />
                ) : (
                  <ChevronRight aria-hidden data-icon="inline-end" />
                )}
              </CollapsibleTrigger>
            )}
            {(detail !== undefined || details.length > 0) && (
              <details className="min-w-0">
                <summary className="w-fit cursor-pointer rounded-sm py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  Account details
                </summary>
                <div className="flex flex-col gap-1.5 py-2">
                  {detail !== undefined && pool !== undefined && (
                    <HealthStrip health={health(detail, pool.healthSince, pool.cellMinutes, zone)} />
                  )}
                  {details.map((note) => (
                    <Label key={note.text} tone={note.tone} text={note.text} wrap />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        <CollapsibleContent>
          <CreditsWell row={row} provider={group.provider} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

interface ProviderProps {
  readonly provider: ProviderId
  readonly account?: string | undefined
}

export function ProviderPage({ provider, account }: ProviderProps) {
  return isSubscription(provider) ? (
    <SubscriptionPage key={provider} provider={provider} account={account} />
  ) : (
    <Accounts provider={provider} account={account} />
  )
}

function SubscriptionPage({
  provider,
  account,
}: {
  readonly provider: SubscriptionId
  readonly account?: string | undefined
}) {
  const detail = usePoolDetail(provider)
  return <Accounts provider={provider} account={account} pool={Option.getOrUndefined(detail)} />
}

function Accounts({ provider, account, pool }: ProviderProps & { readonly pool?: PoolDetail | undefined }) {
  const shown = useAtomValue(shownReportAtom)
  const all = useAtomValue(groupsAtom)
  const change = useAtomSet(changeAccount)
  const canChange = useAtomValue(canChangeAtom)
  const start = useAtomSet(signIn)
  const readOnly = useAtomValue(readOnlyAtom)
  const title = providerFacts[provider].title
  const group = Option.fromUndefinedOr(all.find((g) => g.provider === provider))
  if (Option.isNone(shown)) {
    return <Empty title="Looking for the proxy…" detail="slopmax shows your accounts as soon as it answers." />
  }
  if (Option.isNone(group)) {
    const subscription = isSubscription(provider)
    const action = readOnly ? undefined : subscription ? (
      <Button variant="outline" disabled={!canChange} onClick={() => start({ provider, device: provider === "grok" })}>
        <ProviderMark provider={provider} /> Sign in to {title}
      </Button>
    ) : (
      <ButtonLink variant="outline" href={pageHash(Pages.addAccountFor(provider))}>
        <ProviderMark provider={provider} />
        {provider === "compat" ? "Add endpoint" : `Add ${title} key`}
      </ButtonLink>
    )
    return (
      <Section title="Accounts" trailing={action}>
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h3>No {title} accounts</h3>
            </CardTitle>
            <CardDescription>
              {readOnly
                ? "Add accounts from a dashboard that can manage this proxy."
                : subscription
                  ? "Sign in to make this subscription available to the proxy."
                  : provider === "compat"
                    ? "Add a local or compatible remote model endpoint."
                    : "Add an API key to make this provider’s models available to the proxy."}
            </CardDescription>
          </CardHeader>
        </Card>
      </Section>
    )
  }
  const g = group.value
  const pinned = g.rows.some((row) => row.pinned)
  return (
    <>
      {g.overview.length > 0 && (
        <Section title="Pool" trailing={<Label tone={g.next.tone} text={g.next.text} raw wrap />}>
          <PoolCells group={g} />
        </Section>
      )}
      <Section
        title="Accounts"
        trailing={
          pinned ? (
            <Button variant="outline" size="sm" disabled={!canChange} onClick={() => change({ _tag: "UnpinAll" })}>
              Let slopmax choose
            </Button>
          ) : undefined
        }
      >
        <Panel>
          {g.subscription && !g.unread && (
            // Spaced as an Item, so each title sits over its column.
            <div className="hidden items-center gap-2.5 border-x border-b border-x-transparent px-3 py-2 text-xs text-muted-foreground @3xl:flex">
              <span className="w-60 shrink-0">Account</span>
              {g.columns.map((column) => (
                <span key={column} className="min-w-30 flex-1 wrap-anywhere">
                  {column}
                </span>
              ))}
              <span className="w-8 shrink-0" />
            </div>
          )}
          {g.rows.map((row) => (
            <AccountRow key={row.id} row={row} group={g} pool={pool} target={row.id === account} />
          ))}
        </Panel>
      </Section>
      {g.rows.some((row) => row.gauges.some((gauge) => gauge?.pace !== undefined)) && (
        <p className="-mt-4 text-xs text-muted-foreground">
          The tick marks how much quota would be left at an even pace.
        </p>
      )}
      {pool !== undefined && <PoolSections group={g} detail={pool} />}
    </>
  )
}
