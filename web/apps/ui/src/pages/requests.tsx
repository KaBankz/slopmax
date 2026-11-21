// Requests, one by one: live off the event stream as they are answered, or
// a day, a week or a month of the ledger, each with the machine that sent
// it, filtered by account, model, agent and how they went, with the totals of what matched. A row opens its
// request in a sheet; what is listed exports as CSV.
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type HistoryRange, type RequestPage, RequestRow, requestSenders } from "@slopmax/client"
import { grouped } from "@slopmax/client/format"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Activity, ChevronRight, Download } from "lucide-react"
import { useState } from "react"
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
import { Quiet } from "../components/quiet.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent } from "../components/ui/card.tsx"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx"
import { Skeleton } from "../components/ui/skeleton.tsx"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableNumber, TableRow } from "../components/ui/table.tsx"
import { feedSize } from "../view/live.ts"
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
const liveRows = (filter: RequestFilter, rows: ReadonlyArray<RequestRow>) =>
  rows.filter((row) => {
    const r = row.record
    const failed = r.status < 200 || r.status >= 400
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
}: {
  readonly filter: RequestFilter
  readonly facets: {
    readonly accounts: ReadonlyArray<string>
    readonly models: ReadonlyArray<string>
    readonly agents: ReadonlyArray<NonNullable<RequestFilter["agent"]>>
  }
  readonly onChange: (filter: RequestFilter) => void
  readonly name: (id: string) => string
}) {
  const set = (patch: Parameters<typeof refine>[1]) => onChange(refine(filter, patch))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-full sm:w-auto">
        <Segmented label="Which requests" value={filter.span} options={listings} onChange={(span) => set({ span })} />
      </div>
      <Pick
        label="Account"
        anyTitle="Any account"
        value={filter.account}
        options={facets.accounts.map((id) => ({ value: id, title: name(id) }))}
        onChange={(account) => set({ account })}
      />
      <Pick
        label="Model"
        anyTitle="Any model"
        value={filter.model}
        options={facets.models.map((model) => ({ value: model, title: model }))}
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
      {narrowed(filter) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...allRequests, span: filter.span })}>
          Clear filters
        </Button>
      )}
    </div>
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
  readonly onOpen: (row: RequestRow) => void
}) {
  return (
    <Card size="flush">
      <Table aria-label="Request log">
        <TableHeader>
          <TableRow>
            <TableHead className="hidden w-24 @sm:table-cell">Time</TableHead>
            <TableHead className="hidden w-24 @3xl:table-cell">Agent</TableHead>
            <TableHead className="hidden w-40 @2xl:table-cell">Model</TableHead>
            <TableHead className="w-full">
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
            <TableRow key={view.key} onClick={() => onOpen(row)}>
              <TableCell className="hidden @sm:table-cell">
                <div className="text-muted-foreground tabular-nums">{view.time}</div>
              </TableCell>
              <TableCell className="hidden @3xl:table-cell">
                <div className="max-w-24 truncate">{view.who}</div>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell">
                <div className="max-w-40 truncate font-mono text-xs">{view.model}</div>
              </TableCell>
              <TableCell>
                <div className="max-w-0 min-w-full whitespace-normal wrap-anywhere">
                  <p className="font-medium @2xl:hidden">{view.model}</p>
                  <p className="flex flex-wrap gap-x-2 text-muted-foreground @2xl:font-medium @2xl:text-foreground">
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
                    onOpen(row)
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
}: {
  readonly row: RequestRow | undefined
  readonly onClose: () => void
  readonly name: (id: string) => string
}) {
  const now = useAtomValue(nowAtom)
  const view = row === undefined ? undefined : rowView(row, 0, name, now, zone)
  return (
    <Sheet open={row !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent>
        {row !== undefined && view !== undefined && (
          <>
            <SheetHeader>
              <SheetTitle>
                {view.who} · {view.time}
              </SheetTitle>
              <SheetDescription>
                {view.model} on {view.account}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-4">
              {facts(row, name, zone).map((group) => (
                <section key={group.title} className="flex flex-col">
                  <h3 className="pb-1.5 text-xs font-medium text-muted-foreground">{group.title}</h3>
                  {group.facts.map((fact) => (
                    <div key={fact.title} className="flex items-baseline justify-between gap-4 border-t py-2">
                      <span className="shrink-0 text-muted-foreground">{fact.title}</span>
                      <span
                        className={
                          fact.mono === true
                            ? "min-w-0 truncate text-right font-mono text-xs"
                            : "min-w-0 text-right tabular-nums"
                        }
                      >
                        {fact.value}
                      </span>
                    </div>
                  ))}
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

/** The page's shared parts: the filter, choosing it, names, and the open request. */
function usePage() {
  const [filter, setFilter] = useAtom(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  const report = useAtomValue(shownReportAtom)
  const now = useAtomValue(nowAtom)
  const [open, setOpen] = useState<RequestRow | undefined>(undefined)
  const name = (id: string) =>
    Option.match(report, {
      onNone: () => id,
      onSome: (r) => r.accounts.find((a) => a.id === id)?.name ?? id,
    })
  const choose = (next: RequestFilter) => {
    setFilter(next)
    setLimit(pageSize)
  }
  const views = (rows: ReadonlyArray<RequestRow>) =>
    rows.map((row, i) => ({ view: rowView(row, i, name, now, zone), row }))
  return { filter, choose, name, views, open, setOpen }
}

/** The live feed, filtered as the ledger is. */
function LiveRequests() {
  const { filter, choose, name, views, open, setOpen } = usePage()
  const feed = useAtomValue(feedAtom)
  const live = useAtomValue(liveAtom)
  const feedRows = feed.map(
    (entry) =>
      new RequestRow({
        record: entry.record,
        ...(entry.cost === undefined ? {} : { cost: entry.cost }),
      }),
  )
  const shown = views(liveRows(filter, feedRows))
  const facets = {
    accounts: [...new Set(feedRows.flatMap((r) => r.record.account ?? []))].toSorted(),
    models: [...new Set(feedRows.flatMap((r) => r.record.model ?? []))].toSorted(),
    agents: requestSenders.filter((a) => feedRows.some((r) => r.record.agent === a)),
  }
  return (
    <div className="flex flex-col gap-3">
      <Filters filter={filter} facets={facets} onChange={choose} name={name} />
      {shown.length === 0 ? (
        <Quiet
          icon={Activity}
          title={
            feed.length > 0
              ? "No live requests match"
              : live._tag === "Running"
                ? "Waiting for requests"
                : "Connecting to the proxy…"
          }
          detail={
            feed.length > 0
              ? "Clear the filters, or look back over a day, a week or a month."
              : "Answered and failed requests show here as they happen. Look back over a day, a week or a month above."
          }
        />
      ) : (
        <RequestsTable views={shown} onOpen={setOpen} />
      )}
      <p className="text-xs text-muted-foreground">
        The newest {feedSize} requests since this page opened, as they are answered.
      </p>
      <RequestSheet row={open} onClose={() => setOpen(undefined)} name={name} />
    </div>
  )
}

/** A range of the ledger, filtered, a page at a time. */
function LedgerRequests({ range }: { readonly range: HistoryRange }) {
  const { filter, choose, name, views, open, setOpen } = usePage()
  const [limit, setLimit] = useAtom(requestLimitAtom)
  const save = useAtomSet(exportRequests)
  const ledger = useAtomValue(requestPageAtom(requestPageKey(filter, range, limit)))
  const page: Option.Option<RequestPage> = AsyncResult.value(ledger)
  const facets = Option.match(page, {
    onNone: () => ({ accounts: [], models: [], agents: [] }),
    onSome: (p) => p.facets,
  })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Filters filter={filter} facets={facets} onChange={choose} name={name} />
        <Button
          variant="outline"
          size="sm"
          disabled={Option.match(page, {
            onNone: () => true,
            onSome: (p) => p.matched === 0,
          })}
          onClick={() => save({ filter, range })}
        >
          <Download data-icon="inline-start" />
          Export CSV
        </Button>
      </div>
      {Option.match(page, {
        onNone: () =>
          AsyncResult.isFailure(ledger) ? (
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
              <RequestsTable views={views(p.rows)} onOpen={setOpen} />
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
      })}
      <RequestSheet row={open} onClose={() => setOpen(undefined)} name={name} />
    </div>
  )
}

export function RequestsPage() {
  const span = useAtomValue(requestFilterAtom).span
  return span === "live" ? <LiveRequests /> : <LedgerRequests range={span} />
}
