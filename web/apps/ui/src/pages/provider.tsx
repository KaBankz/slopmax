// One provider's page: its pool read as one account, then each account
// with a gauge per window, its notes, its limit resets, and a menu of what
// can be done to it.
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type ProviderId, providerFacts, SubscriptionId } from "@slopmax/client"
import { cva } from "class-variance-authority"
import { Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronDown, ChevronRight, Ellipsis, Users } from "lucide-react"
import { Fragment } from "react"
import {
  attentionAtom,
  canChangeAtom,
  changeAccount,
  groupsAtom,
  nowAtom,
  openCreditsAtom,
  pollOffAtom,
  proxyAtom,
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
import { Dot, Empty, Label, Meter, Panel, Section, SegmentedBar } from "../components/parts.tsx"
import { Tip } from "../components/tip.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button } from "../components/ui/button.tsx"
import { CardFooter } from "../components/ui/card.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "../components/ui/item.tsx"
import { askOwn, askPriority, askRedeem, askRemove, askRename, readPriority } from "../view/asks.ts"
import { across, type Gauge, type Group, type Row } from "../view/groups.ts"
import { cannotChange } from "../view/live.ts"
import { autoRedeem, limitsNotRead, resetsLine, resetsUnlisted } from "../view/words.ts"

function PoolCells({ group }: { readonly group: Group }) {
  return (
    <Panel>
      <div className="flex flex-wrap">
        {group.overview.map((window) => (
          <div
            key={window.title}
            className="flex min-w-48 flex-1 flex-col gap-2 border-l border-border p-4 first:border-l-0"
          >
            <span className="text-xs text-muted-foreground">{window.title}</span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">{window.gauge.percent}</span>
              <span className="text-xs text-muted-foreground">used</span>
            </span>
            <SegmentedBar window={window} weighted={group.weighted} />
            <span className="text-xs text-muted-foreground tabular-nums">
              {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
            </span>
          </div>
        ))}
      </div>
      <CardFooter>
        <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{across(group)}</span>
          {group.credits !== undefined && <span>{group.credits}</span>}
        </div>
      </CardFooter>
    </Panel>
  )
}

const cellVariants = cva("flex min-w-30 flex-1 flex-col gap-1.5", {
  variants: { faded: { true: "opacity-45", false: "" } },
})

/** The window's name over its cell, where the table is too narrow for its header row. */
function CellTitle({ title }: { readonly title: string }) {
  return <span className="truncate text-xs text-muted-foreground @3xl:hidden">{title}</span>
}

function WindowCell({
  title,
  gauge,
  faded,
}: {
  readonly title: string
  readonly gauge: Gauge | undefined
  readonly faded: boolean
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
      <span className="font-medium tabular-nums">{gauge.percent}</span>
      <Meter
        fraction={gauge.fraction}
        tone={gauge.tone}
        {...(gauge.pace === undefined ? {} : { marker: gauge.pace.elapsed })}
      />
      <span className="flex min-w-0 flex-wrap gap-x-2 text-xs">
        <span className="text-muted-foreground tabular-nums">{resetsLine(gauge.resetsIn, gauge.resetsAt)}</span>
        {gauge.pace !== undefined && <Label tone={gauge.pace.label.tone} text={gauge.pace.label.text} raw />}
      </span>
    </div>
  )
}

/** Everything that can be done to one account. */
function AccountMenu({ row }: { readonly row: Row }) {
  const change = useAtomSet(changeAccount)
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
            <DropdownMenuItem disabled={row.disabled} onClick={() => change({ _tag: "Pin", id })}>
              Use for new sessions
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => change({ _tag: "Enable", id, on: row.disabled })}>
            {row.disabled ? "Enable" : "Disable"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Priority {row.priority}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => change({ _tag: "Priority", id, priority: row.priority + 1 })}>
            Raise priority
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => change({ _tag: "Priority", id, priority: row.priority - 1 })}>
            Lower priority
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void ask(askPriority(account)).then((answer) => {
                const priority = answer === null ? undefined : readPriority(answer)
                if (priority !== undefined) change({ _tag: "Priority", id, priority })
              })
            }
          >
            Set priority…
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
  const proxy = useAtomValue(proxyAtom)
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
  const held = !canChange
    ? (cannotChange(proxy, "redeem one", unanswered, readOnly) ?? "Waiting for slopmax")
    : credits.held
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
                aria-label={`Redeem a limit reset on ${row.name}…`}
                onClick={() =>
                  void ask(askRedeem(row.account, credits.credits[0]?.id, now, zone)).then((answer) => {
                    if (answer === null) return
                    const first = credits.credits[0]?.id
                    spend(first === undefined ? { id: row.id } : { id: row.id, reset: first })
                  })
                }
              >
                Redeem…
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
      aria-label={`Sign in to ${row.name} again`}
      onClick={() => start({ provider })}
    >
      Sign in…
    </Button>
  )
}

const isSubscription = Schema.is(SubscriptionId)

/** Where an account's windows go, before slopmax has read any of the group's. */
function UnreadCell() {
  const pollOff = useAtomValue(pollOffAtom)
  return <span className="min-w-0 flex-1 text-xs text-muted-foreground">{limitsNotRead(pollOff)}</span>
}

function AccountRow({ row, group }: { readonly row: Row; readonly group: Group }) {
  const [open, setOpen] = useAtom(openCreditsAtom)
  const isOpen = Option.isSome(open) && open.value === row.id
  const metered = !group.subscription
  // Wide, the account is a row of the table. Narrow, its name takes a line of
  // its own, its windows wrap beneath with their names, and its menu stays at
  // the top right, in reach at any width.
  return (
    <div className="border-t first:border-t-0">
      <Collapsible open={isOpen} onOpenChange={(next) => setOpen(next ? Option.some(row.id) : Option.none())}>
        <Item className="relative flex-col items-stretch @3xl:flex-row @3xl:flex-nowrap @3xl:items-start">
          <ItemContent className="mr-8 min-w-0 @3xl:mr-0 @3xl:w-60 @3xl:flex-none">
            <ItemTitle className="max-w-full">
              <span className={row.disabled ? "truncate text-muted-foreground" : "truncate"}>{row.name}</span>
            </ItemTitle>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Label tone={row.status.tone} text={row.status.text} wrap />
              {row.plan !== "" && <span className="text-muted-foreground">{row.plan}</span>}
              {row.next && <Badge>Next</Badge>}
            </span>
            <SignInAgain row={row} />
            {row.lastUsed !== undefined && <span className="text-xs text-muted-foreground">{row.lastUsed}</span>}
          </ItemContent>
          {metered ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              {row.account.endpoint !== undefined && (
                <span className="truncate font-mono text-xs text-muted-foreground">{row.account.endpoint}</span>
              )}
              <span className="text-muted-foreground">
                {row.account.models.length === 0 ? "Any model" : row.account.models.join(", ")}
              </span>
            </div>
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
                />
              ))}
            </div>
          )}
          <ItemActions className="absolute top-2 right-2 @3xl:static">
            <AccountMenu row={row} />
          </ItemActions>
        </Item>
        {(row.notes.length > 0 || row.credits !== undefined) && (
          <div className="-mt-1 flex min-w-0 items-center gap-3 px-3 pb-2.5 text-xs">
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
            {row.notes.map((note, i) => (
              <span key={note.text} className={i === row.notes.length - 1 ? "min-w-0 truncate" : "shrink-0"}>
                <Label tone={note.tone} text={note.text} />
              </span>
            ))}
          </div>
        )}
        <CollapsibleContent>
          <CreditsWell row={row} provider={group.provider} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export function ProviderPage({ provider }: { readonly provider: ProviderId }) {
  const shown = useAtomValue(shownReportAtom)
  const all = useAtomValue(groupsAtom)
  const change = useAtomSet(changeAccount)
  const canChange = useAtomValue(canChangeAtom)
  const title = providerFacts[provider].title
  const group = Option.fromUndefinedOr(all.find((g) => g.provider === provider))
  if (Option.isNone(shown)) {
    return <Empty title="Looking for the proxy…" detail="slopmax shows your accounts as soon as it answers." />
  }
  if (Option.isNone(group)) {
    return <Empty icon={Users} title={`No ${title} accounts`} detail="Add one with Add account, above." />
  }
  const g = group.value
  const pinned = g.rows.some((row) => row.pinned)
  return (
    <>
      {g.overview.length > 0 && (
        <Section title="Pool" trailing={<Label tone={g.next.tone} text={g.next.text} raw />}>
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
                <Fragment key={column}>
                  <Tip content={column}>
                    <span className="min-w-30 flex-1 truncate">{column}</span>
                  </Tip>
                </Fragment>
              ))}
              <span className="w-8 shrink-0" />
            </div>
          )}
          {g.rows.map((row) => (
            <AccountRow key={row.id} row={row} group={g} />
          ))}
        </Panel>
      </Section>
    </>
  )
}
