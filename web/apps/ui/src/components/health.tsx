// The overview's last day: every subscription account's requests in half
// hours, and the latest requests that failed, a click from the Requests page
// filtered to them. Cards of Items, Tooltips and the health strip.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type RequestRow, SubscriptionId } from "@slopmax/client"
import { Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChevronRight } from "lucide-react"
import {
  go,
  nowAtom,
  requestFilterAtom,
  requestLimitAtom,
  requestPageAtom,
  requestPageKey,
  shownReportAtom,
  zone,
} from "../atoms.ts"
import { health } from "../view/forecast.ts"
import type { Group } from "../view/groups.ts"
import { Pages } from "../view/pages.ts"
import { pageSize, type RequestFilter, rowView } from "../view/requests.ts"
import { HealthStrip, usePoolDetail } from "./forecast.tsx"
import { Label } from "./parts.tsx"
import { Button } from "./ui/button.tsx"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx"

const isSubscription = Schema.is(SubscriptionId)

/** One provider's working accounts, each with its last day. */
function ProviderHealth({ group }: { readonly group: Group }) {
  const provider = isSubscription(group.provider) ? group.provider : "claude"
  const detail = usePoolDetail(provider)
  if (Option.isNone(detail)) return null
  const pool = detail.value
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{group.title}</span>
      {pool.accounts.map((account) => {
        const row = group.rows.find((r) => r.id === account.id)
        const day = health(account, pool.healthSince, pool.cellMinutes, zone)
        return (
          <div key={account.id} className="flex items-center gap-3">
            <span className="w-36 shrink-0 truncate text-sm">{row?.name ?? account.id}</span>
            <div className="min-w-0 flex-1">
              <HealthStrip health={day} />
            </div>
            <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {day.failed > 0 ? `${day.failed} failed` : "none failed"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Every subscription account's last day, in half hours. */
export function HealthCard({ groups }: { readonly groups: ReadonlyArray<Group> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account health</CardTitle>
        <CardDescription>The last day in half hours: green answered, amber some failed, red mostly.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <ProviderHealth key={group.provider} group={group} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

const failures: RequestFilter = { span: "today", outcome: "failed" }

/** Today's latest failures, and the way to all of them. */
export function RecentFailures() {
  const result = useAtomValue(requestPageAtom(requestPageKey(failures, "today", 5)))
  const report = useAtomValue(shownReportAtom)
  const now = useAtomValue(nowAtom)
  const setFilter = useAtomSet(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  const page = AsyncResult.value(result)
  const name = (id: string) =>
    Option.match(report, { onNone: () => id, onSome: (r) => r.accounts.find((a) => a.id === id)?.name ?? id })
  const rows: ReadonlyArray<RequestRow> = Option.match(page, { onNone: () => [], onSome: (p) => p.rows })
  const matched = Option.match(page, { onNone: () => 0, onSome: (p) => p.matched })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Failed today</CardTitle>
        <CardDescription>
          {matched === 0 ? "Nothing has failed today." : `${matched} ${matched === 1 ? "request" : "requests"} failed.`}
        </CardDescription>
        {matched > 0 && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilter(failures)
                setLimit(pageSize)
                go(Pages.requests)
              }}
            >
              See all
              <ChevronRight data-icon="inline-end" />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {rows.length > 0 && (
        <CardContent>
          <div className="flex flex-col">
            {rows.map((row, i) => {
              const view = rowView(row, i, name, now, zone)
              return (
                <div key={view.key} className="flex items-center gap-3 border-t py-2 text-sm first:border-t-0">
                  <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{view.time}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {view.account}
                    <span className="text-muted-foreground"> · {view.model}</span>
                  </span>
                  <Label tone="bad" text={view.status} raw />
                </div>
              )
            })}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
