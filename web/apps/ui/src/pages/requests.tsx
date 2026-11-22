// Requests, one by one: live off the event stream as they are answered, or
// a day, a week or a month of the ledger, each with the machine that sent
// it, filtered by account, model, agent and how they went, with the totals of what matched. A row opens its
// request in a sheet; what is listed exports as CSV.
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type RequestPage, RequestRow, requestSenders } from "@slopmax/client"
import { grouped } from "@slopmax/client/format"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Activity, ChevronRight, Download, SlidersHorizontal } from "lucide-react"
import { useRef, useState } from "react"
import {
  exportRequests,
  feedAtom,
  liveAtom,
  nowAtom,
  requestFilterAtom,
  requestLimitAtom,
  requestPageAtom,
  requestPageKey,
  shownReportAtom,
  zone,
} from "../atoms.ts"
import { Label } from "../components/parts.tsx"
import { Pick } from "../components/pick.tsx"
import { ProviderMark } from "../components/provider-mark.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent } from "../components/ui/card.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx"
import { Skeleton } from "../components/ui/skeleton.tsx"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableNumber, TableRow } from "../components/ui/table.tsx"
import { type FeedEntry, feedSize, isFailure } from "../view/live.ts"
import {
  allRequests,
  facts,
  listings,
  narrowed,
  outcomes,
  pageSize,
  refine,
  type RequestFilter,
  type RowView,
  rowView,
  senderTitle,
  totalsLine,
} from "../view/requests.ts"
import { count } from "../view/words.ts"

/** The live feed as rows, filtered as the ledger would be. */
const liveRows = (filter: RequestFilter, rows: ReadonlyArray<FeedEntry>) =>
  rows.filter(({ record: r }) => {
    const failed = isFailure(r.status)
    return (
      (filter.account === undefined || r.account === filter.account) &&
      (filter.model === undefined || r.model === filter.model) &&
      (filter.agent === undefined || r.agent === filter.agent) &&
      (filter.outcome === "all" ||
        (filter.outcome === "failed" ? failed : filter.outcome === "rescued" ? !failed && r.attempts > 1 : !failed))
    )
  })

function Filters({
  filter,
  facets,
  onChange,
  name,
  csv,
}: {
  readonly filter: RequestFilter
  readonly facets: {
    readonly accounts: ReadonlyArray<string>
    readonly models: ReadonlyArray<string>
    readonly agents: ReadonlyArray<NonNullable<RequestFilter["agent"]>>
  }
  readonly onChange: (filter: RequestFilter) => void
  readonly name: (id: string) => string
  readonly csv?: { readonly disabled: boolean; readonly save: () => void }
}) {
  const set = (patch: Parameters<typeof refine>[1]) => onChange(refine(filter, patch))
  const extra = [filter.account, filter.model, filter.agent].filter((value) => value !== undefined).length
  return (
    <Collapsible>
      <div className="flex flex-wrap items-center gap-2">
        <div className="basis-full @lg:basis-auto">
          <Segmented label="Which requests" value={filter.span} options={listings} onChange={(span) => set({ span })} />
        </div>
        <Pick
          label="Outcome"
          anyTitle="Any outcome"
          value={filter.outcome === "all" ? undefined : filter.outcome}
          options={outcomes.filter((o) => o.value !== "all")}
          onChange={(outcome) =>
            set({
              outcome: outcomes.find((o) => o.value === outcome)?.value ?? "all",
            })
          }
        />
        <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
          <SlidersHorizontal aria-hidden data-icon="inline-start" />
          Filters{extra === 0 ? "" : ` (${extra})`}
        </CollapsibleTrigger>
        {csv !== undefined && (
          <Button variant="outline" size="sm" disabled={csv.disabled} onClick={csv.save} className="@lg:ml-auto">
            <Download aria-hidden data-icon="inline-start" />
            <span className="sr-only @sm:not-sr-only">Export CSV</span>
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border bg-muted/35 px-3 py-2.5">
          <Pick
            label="Account"
            anyTitle="Any account"
            value={filter.account}
            options={facets.accounts.map((id) => ({
              value: id,
              title: name(id),
            }))}
            onChange={(account) => set({ account })}
          />
          <Pick
            label="Model"
            literal
            anyTitle="Any model"
            value={filter.model}
            options={facets.models.map((model) => ({
              value: model,
              title: model,
            }))}
            onChange={(model) => set({ model })}
          />
          <Pick
            label="Agent"
            anyTitle="Any agent"
            value={filter.agent}
            options={facets.agents.map((agent) => ({
              value: agent,
              title: senderTitle(agent),
            }))}
            onChange={(agent) => set({ agent: facets.agents.find((a) => a === agent) })}
          />
          {narrowed(filter) && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...allRequests, span: filter.span })}>
              Clear filters
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function RequestsTable({
  views,
  onOpen,
}: {
  readonly views: ReadonlyArray<{
    readonly view: RowView
    readonly row: RequestRow
  }>
  readonly onOpen: (row: RequestRow, trigger: HTMLButtonElement | null) => void
}) {
  return (
    <Card size="flush">
      <Table aria-label="Request log">
        <TableHeader>
          <TableRow>
            <TableHead className="hidden w-24 @sm:table-cell">Time</TableHead>
            <TableHead className="hidden w-24 @3xl:table-cell">Agent</TableHead>
            <TableHead className="hidden w-40 @2xl:table-cell">Model</TableHead>
            <TableHead className="w-full @5xl:w-64">
              <span className="@2xl:hidden">Request</span>
              <span className="hidden @2xl:inline">Account</span>
            </TableHead>
            <TableHead className="w-12 text-right">Status</TableHead>
            <TableHead className="hidden w-14 text-right @lg:table-cell">Tokens</TableHead>
            <TableHead className="hidden w-16 text-right @3xl:table-cell">Cost</TableHead>
            <TableHead className="hidden w-28 text-right @2xl:table-cell">First byte · total</TableHead>
            <TableHead className="w-8">
              <span className="sr-only">Details</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {views.map(({ view, row }) => (
            <TableRow key={view.key} onClick={(event) => onOpen(row, event.currentTarget.querySelector("button"))}>
              <TableCell className="hidden @sm:table-cell">
                <div className="text-muted-foreground tabular-nums">{view.time}</div>
              </TableCell>
              <TableCell className="hidden @3xl:table-cell">
                <div className="max-w-24 truncate">{view.who}</div>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell">
                <code className="block max-w-40 truncate text-xs">{view.model}</code>
              </TableCell>
              <TableCell>
                <div className="max-w-0 min-w-full whitespace-normal wrap-anywhere">
                  <code className="block text-xs @2xl:hidden">{view.model}</code>
                  <p className="flex flex-col text-muted-foreground @2xl:font-medium @2xl:text-foreground">
                    <span className="min-w-0">{view.account}</span>
                    <span className="text-xs tabular-nums @sm:hidden">{view.time}</span>
                  </p>
                  {view.notes.length > 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{view.notes.join(" · ")}</p>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end tabular-nums">
                  <Label tone={view.failed ? "bad" : "muted"} text={view.status} raw />
                </div>
              </TableCell>
              <TableCell className="hidden @lg:table-cell">
                <TableNumber>{view.tokens}</TableNumber>
              </TableCell>
              <TableCell className="hidden @3xl:table-cell">
                <TableNumber muted>{view.cost}</TableNumber>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell">
                <TableNumber muted>{view.took}</TableNumber>
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Details of the request at ${view.time}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(row, event.currentTarget)
                  }}
                >
                  <ChevronRight />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

/** One request in full, in a sheet at the right. */
function RequestSheet({
  row,
  onClose,
  name,
  restoreFocus,
}: {
  readonly row: RequestRow | undefined
  readonly onClose: () => void
  readonly name: (id: string) => string
  readonly restoreFocus: () => HTMLElement | false
}) {
  const now = useAtomValue(nowAtom)
  const view = row === undefined ? undefined : rowView(row, 0, name, now, zone)
  return (
    <Sheet open={row !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent size="detail" finalFocus={restoreFocus}>
        {row !== undefined && view !== undefined && (
          <>
            <SheetHeader>
              <SheetTitle>Request details</SheetTitle>
              <SheetDescription className="wrap-anywhere">
                <span className="inline-flex items-center gap-2">
                  <ProviderMark provider={row.record.provider} />
                  <span>
                    <code>{view.model}</code> · {view.who}
                  </span>
                </span>
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 pb-5 sm:px-5">
              {facts(row, name, zone).map((group) => (
                <section key={group.title} className="flex flex-col gap-1">
                  <h3 className="font-heading text-base font-semibold">{group.title}</h3>
                  <dl>
                    {group.facts.map((fact) => (
                      <div
                        key={fact.title}
                        className="grid grid-cols-[minmax(6.25rem,1fr)_minmax(0,2.5fr)] items-baseline gap-3 border-t py-2"
                      >
                        <dt className="text-muted-foreground">{fact.title}</dt>
                        <dd
                          data-error={view.failed && fact.title === "Status" ? true : undefined}
                          className={
                            fact.mono === true
                              ? "wrap-anywhere text-right font-mono text-xs"
                              : "wrap-anywhere text-right tabular-nums data-error:font-medium data-error:text-destructive"
                          }
                        >
                          {fact.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function TableSkeleton() {
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** Read the live feed or ledger for the selected range without replacing the filter bar. */
const requestSourceAtom = Atom.make((get) => {
  const filter = get(requestFilterAtom)
  if (filter.span === "live") {
    return { kind: "live", feed: get(feedAtom), live: get(liveAtom) } as const
  }
  const range = filter.span
  const result = get(requestPageAtom(requestPageKey(filter, range, get(requestLimitAtom))))
  return { kind: "ledger", range, result } as const
})

export function RequestsPage() {
  const [filter, setFilter] = useAtom(requestFilterAtom)
  const [limit, setLimit] = useAtom(requestLimitAtom)
  const save = useAtomSet(exportRequests)
  const source = useAtomValue(requestSourceAtom)
  const report = useAtomValue(shownReportAtom)
  const now = useAtomValue(nowAtom)
  const [open, setOpen] = useState<RequestRow | undefined>(undefined)
  const opener = useRef<HTMLButtonElement | null>(null)

  const name = (id: string) =>
    Option.match(report, {
      onNone: () => id,
      onSome: (r) => r.accounts.find((a) => a.id === id)?.name ?? id,
    })
  const choose = (next: RequestFilter) => {
    setFilter(next)
    setLimit(pageSize)
  }
  const show = (row: RequestRow, key: number) => ({ row, view: rowView(row, key, name, now, zone) })
  const openRequest = (row: RequestRow, trigger: HTMLButtonElement | null) => {
    opener.current = trigger
    setOpen(row)
  }
  const restoreFocus = () =>
    opener.current?.isConnected === true ? opener.current : (document.getElementById("dashboard-title") ?? false)

  const page = source.kind === "ledger" ? AsyncResult.value(source.result) : Option.none<RequestPage>()
  const facets =
    source.kind === "live"
      ? {
          accounts: [...new Set(source.feed.flatMap(({ record }) => record.account ?? []))].toSorted(),
          models: [...new Set(source.feed.flatMap(({ record }) => record.model ?? []))].toSorted(),
          agents: requestSenders.filter((a) => source.feed.some(({ record }) => record.agent === a)),
        }
      : Option.match(page, {
          onNone: () => ({ accounts: [], models: [], agents: [] }),
          onSome: (p) => p.facets,
        })
  const shown =
    source.kind === "live"
      ? liveRows(filter, source.feed).map(({ seq, record, cost }) =>
          show(new RequestRow({ record, ...(cost === undefined ? {} : { cost }) }), seq),
        )
      : []
  const csv =
    source.kind === "ledger"
      ? {
          disabled: Option.match(page, { onNone: () => true, onSome: (p) => p.matched === 0 }),
          save: () => save({ filter, range: source.range }),
        }
      : undefined

  return (
    <div className="flex flex-col gap-3">
      <Filters filter={filter} facets={facets} onChange={choose} name={name} {...(csv === undefined ? {} : { csv })} />
      {source.kind === "live" ? (
        <>
          {shown.length === 0 ? (
            <Quiet
              icon={Activity}
              title={
                source.feed.length > 0
                  ? "No live requests match"
                  : source.live._tag === "Running"
                    ? "Waiting for requests"
                    : "Connecting to the proxy…"
              }
              detail={
                source.feed.length > 0
                  ? "Clear the filters, or look back over a day, a week or a month."
                  : "Answered and failed requests show here as they happen. Look back over a day, a week or a month above."
              }
            />
          ) : (
            <RequestsTable views={shown} onOpen={openRequest} />
          )}
          <p className="text-xs text-muted-foreground">
            The newest {feedSize} requests since this page opened, as they are answered.
          </p>
        </>
      ) : (
        Option.match(page, {
          onNone: () =>
            AsyncResult.isFailure(source.result) ? (
              <p className="text-sm text-destructive">Could not read the ledger.</p>
            ) : (
              <TableSkeleton />
            ),
          onSome: (p) => (
            <>
              <p className="text-sm text-muted-foreground tabular-nums">{totalsLine(p)}</p>
              {p.rows.length === 0 ? (
                <Quiet
                  icon={Activity}
                  title="No requests match"
                  detail={
                    narrowed(filter)
                      ? "Clear the filters, or look further back."
                      : "Nothing went through slopmax in this range."
                  }
                />
              ) : (
                <RequestsTable views={p.rows.map(show)} onOpen={openRequest} />
              )}
              {p.matched > p.rows.length && (
                <div className="flex items-center justify-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Showing {grouped(p.rows.length)} of {count(p.matched, "request")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLimit(Math.min(1_000, limit + pageSize))}
                    disabled={limit >= 1_000}
                  >
                    Show more
                  </Button>
                </div>
              )}
            </>
          ),
        })
      )}
      <RequestSheet row={open} onClose={() => setOpen(undefined)} name={name} restoreFocus={restoreFocus} />
    </div>
  )
}
