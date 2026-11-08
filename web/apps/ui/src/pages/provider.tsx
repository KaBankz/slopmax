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
  proxyAtom,
  redeem,
  redeemingAtom,
  settingsAtom,
  shownReportAtom,
  signIn,
  zone,
} from "../atoms.ts"
import { useAsk } from "../components/ask.tsx"
import { Dot, Empty, Label, Meter, Panel, Section, SegmentedBar } from "../components/parts.tsx"
import { Badge } from "../components/ui/badge.tsx"
import { Button } from "../components/ui/button.tsx"
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../components/ui/menu.tsx"
import { Tip } from "../components/ui/tooltip.tsx"
import { askOwn, askPriority, askRedeem, askRemove, askRename, readPriority } from "../view/asks.ts"
import { across, type Gauge, type Group, type Row } from "../view/groups.ts"
import { needsProxy } from "../view/live.ts"
import { autoRedeem, resetsLine } from "../view/words.ts"

function PoolCells({ group }: { readonly group: Group }) {
  return (
    <Panel>
      <div className="flex flex-wrap">
        {group.overview.map((window) => (
          <div
            key={window.title}
            className="flex min-w-48 flex-1 flex-col gap-2 border-l border-separator p-4 first:border-l-0"
          >
            <span className="text-small text-muted-foreground">{window.title}</span>
            <span className="flex items-baseline gap-1.5">
              <span className="text-figure font-semibold tabular">{window.gauge.percent}</span>
              <span className="text-small text-muted-foreground">used</span>
            </span>
            <SegmentedBar window={window} weighted={group.weighted} />
            <span className="text-caption text-faint tabular">
              {resetsLine(window.gauge.resetsIn, window.gauge.resetsAt)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-separator px-4 py-2.5 text-small text-muted-foreground">
        <span>{across(group)}</span>
        {group.credits !== undefined && <span>{group.credits}</span>}
      </div>
    </Panel>
  )
}

const cellVariants = cva("flex min-w-30 flex-1 flex-col gap-1.5", {
  variants: { faded: { true: "opacity-45", false: "" } },
})

/** The window's name over its cell, where the table is too narrow for its header row. */
function CellTitle({ title }: { readonly title: string }) {
  return <span className="truncate text-caption text-muted-foreground @table:hidden">{title}</span>
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
        <span className="text-faint">—</span>
      </div>
    )
  }
  return (
    <div className={cellVariants({ faded })}>
      <CellTitle title={title} />
      <span className="font-medium tabular">{gauge.percent}</span>
      <Meter
        fraction={gauge.fraction}
        tone={gauge.tone}
        {...(gauge.pace === undefined ? {} : { marker: gauge.pace.elapsed })}
      />
      <span className="flex min-w-0 flex-wrap gap-x-2 text-caption">
        <span className="text-faint tabular">{resetsLine(gauge.resetsIn, gauge.resetsAt)}</span>
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
    <Menu
      trigger={
        <Button variant="ghost" size="icon" aria-label={`More for ${row.name}`} disabled={!canChange}>
          <Ellipsis />
        </Button>
      }
    >
      {row.pinned ? (
        <MenuItem onClick={() => change({ _tag: "UnpinAll" })}>Stop pinning</MenuItem>
      ) : (
        <MenuItem disabled={row.disabled} onClick={() => change({ _tag: "Pin", id })}>
          Use for new sessions
        </MenuItem>
      )}
      <MenuItem onClick={() => change({ _tag: "Enable", id, on: row.disabled })}>
        {row.disabled ? "Enable" : "Disable"}
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Priority {row.priority}</MenuLabel>
      <MenuItem onClick={() => change({ _tag: "Priority", id, priority: row.priority + 1 })}>Raise priority</MenuItem>
      <MenuItem onClick={() => change({ _tag: "Priority", id, priority: row.priority - 1 })}>Lower priority</MenuItem>
      <MenuItem
        onClick={() =>
          void ask(askPriority(account)).then((answer) => {
            const priority = answer === null ? undefined : readPriority(answer)
            if (priority !== undefined) change({ _tag: "Priority", id, priority })
          })
        }
      >
        Set priority…
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        onClick={() =>
          void ask(askRename(account)).then((answer) => {
            if (answer !== null) change({ _tag: "Rename", id, label: answer })
          })
        }
      >
        Rename…
      </MenuItem>
      {row.follows !== undefined && (
        <MenuItem
          onClick={() =>
            void ask(askOwn(account)).then((answer) => {
              if (answer !== null) change({ _tag: "Own", id })
            })
          }
        >
          Refresh here instead of {row.follows}
        </MenuItem>
      )}
      {row.credits !== undefined && (
        <MenuItem disabled={row.credits.held !== undefined} onClick={() => openCredits(Option.some(id))}>
          Redeem a limit reset…
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        tone="danger"
        onClick={() =>
          void ask(askRemove(account)).then((answer) => {
            if (answer !== null) change({ _tag: "Remove", id })
          })
        }
      >
        Remove…
      </MenuItem>
    </Menu>
  )
}

/** An account's limit resets, opened beneath it: what one clears, each one, and redeeming one. */
function CreditsWell({ row, provider }: { readonly row: Row; readonly provider: ProviderId }) {
  const now = useAtomValue(nowAtom)
  const redeeming = useAtomValue(redeemingAtom)
  const canChange = useAtomValue(canChangeAtom)
  const proxy = useAtomValue(proxyAtom)
  const settings = useAtomValue(settingsAtom)
  const spend = useAtomSet(redeem)
  const ask = useAsk()
  const credits = row.credits
  if (credits === undefined) return null
  const busy = Option.isSome(redeeming) && redeeming.value === row.id
  const policy = Option.flatMap(AsyncResult.value(settings), (view) =>
    Option.fromUndefinedOr(autoRedeem(view.settings, providerFacts[provider].title)),
  )
  const held = !canChange ? (needsProxy(proxy, "redeem one") ?? "Waiting for slopmax") : credits.held
  return (
    <div className="mx-4 mb-3.5 flex animate-appear flex-col gap-3 rounded-md bg-well p-3.5">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">Limit resets</span>
          <span className="text-small text-muted-foreground">
            Each one resets this account's {credits.clears} windows at once.
          </span>
        </div>
        {busy ? (
          <span className="text-small text-muted-foreground">Redeeming…</span>
        ) : (
          <span className="flex items-center gap-3">
            {held !== undefined && <span className="text-small text-muted-foreground">{held}</span>}
            <Button
              variant="primary"
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
          </span>
        )}
      </div>
      {credits.credits.length === 0 ? (
        <span className="text-small text-muted-foreground">Listing them…</span>
      ) : (
        <div className="flex flex-col">
          {credits.credits.map((credit) => (
            <div
              key={credit.id}
              className="flex items-center gap-2 border-t border-separator py-2 text-small first:border-t-0"
            >
              {credit.tone === "warn" && <Dot tone="warn" />}
              <span className={credit.tone === "warn" ? "flex-1 text-warning" : "flex-1 text-foreground"}>
                {credit.title === undefined ? credit.line : `${credit.title} · ${credit.line}`}
              </span>
              {credit.granted !== undefined && <span className="text-caption text-faint">{credit.granted}</span>}
            </div>
          ))}
        </div>
      )}
      {Option.isSome(policy) && <span className="text-caption text-faint">{policy.value}</span>}
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
      size="sm"
      disabled={!canChange}
      aria-label={`Sign in to ${row.name} again`}
      onClick={() => start({ provider })}
    >
      Sign in…
    </Button>
  )
}

const isSubscription = Schema.is(SubscriptionId)

function AccountRow({ row, group }: { readonly row: Row; readonly group: Group }) {
  const [open, setOpen] = useAtom(openCreditsAtom)
  const isOpen = Option.isSome(open) && open.value === row.id
  const toggle = () => setOpen(isOpen ? Option.none() : Option.some(row.id))
  const metered = !group.subscription
  // Wide, the account is a row of the table. Narrow, its name takes a line of
  // its own, its windows wrap beneath with their names, and its menu stays at
  // the top right, in reach at any width.
  return (
    <div className="border-t border-separator first:border-t-0">
      <div className="relative flex flex-col gap-3 px-4 py-3.5 @table:flex-row @table:items-start @table:gap-4">
        <div className="flex min-w-0 flex-col gap-1 pr-9 @table:w-60 @table:shrink-0 @table:pr-0">
          <span className={row.disabled ? "truncate font-medium text-muted-foreground" : "truncate font-medium"}>
            {row.name}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small">
            <Label tone={row.status.tone} text={row.status.text} wrap />
            {row.plan !== "" && <span className="text-faint">{row.plan}</span>}
            {row.next && <Badge tone="brand">Next</Badge>}
          </span>
          <span className="empty:hidden">
            <SignInAgain row={row} />
          </span>
          {row.lastUsed !== undefined && <span className="text-caption text-faint">{row.lastUsed}</span>}
        </div>
        {metered ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-small">
            {row.account.endpoint !== undefined && (
              <span className="truncate font-mono text-caption text-muted-foreground">{row.account.endpoint}</span>
            )}
            <span className="text-muted-foreground">
              {row.account.models.length === 0 ? "Any model" : row.account.models.join(", ")}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-3 @table:contents">
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
        <div className="absolute top-3 right-3 w-7 @table:static @table:shrink-0">
          <AccountMenu row={row} />
        </div>
      </div>
      {(row.notes.length > 0 || row.credits !== undefined) && (
        <div className="-mt-1.5 flex min-w-0 items-center gap-3 px-4 pb-3 text-small">
          {row.credits !== undefined && (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={`${row.credits.title} on ${row.name}`}
              onClick={toggle}
              className={
                isOpen
                  ? "inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              }
            >
              {row.credits.title}
              {isOpen ? (
                <ChevronDown aria-hidden className="size-3.5" />
              ) : (
                <ChevronRight aria-hidden className="size-3.5" />
              )}
            </button>
          )}
          {row.notes.map((note, i) => (
            <span key={note.text} className={i === row.notes.length - 1 ? "min-w-0 truncate" : "shrink-0"}>
              <Label tone={note.tone} text={note.text} />
            </span>
          ))}
        </div>
      )}
      {isOpen && <CreditsWell row={row} provider={group.provider} />}
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
            <Button size="sm" disabled={!canChange} onClick={() => change({ _tag: "UnpinAll" })}>
              Let slopmax choose
            </Button>
          ) : undefined
        }
      >
        <Panel>
          {g.subscription && (
            <div className="hidden items-center gap-4 border-b border-separator px-4 py-2 text-small text-muted-foreground @table:flex">
              <span className="w-60 shrink-0">Account</span>
              {g.columns.map((column) => (
                <Fragment key={column}>
                  <Tip content={column}>
                    <span className="min-w-30 flex-1 truncate">{column}</span>
                  </Tip>
                </Fragment>
              ))}
              <span className="w-7 shrink-0" />
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
