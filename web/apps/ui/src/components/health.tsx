// The overview's last day: every subscription account's requests in half
// hours, and the latest requests that failed, a click from the Requests page
// filtered to them. Cards of Items, Tooltips and the health strip.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { SubscriptionId } from "@slopmax/client"
import { Option, Schema } from "effect"
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
import { AccountName, Label, Loaded, Skeleton } from "./parts.tsx"
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
          <div key={account.id} className="grid grid-cols-2 items-center gap-x-2 gap-y-1 @sm/health:grid-cols-3">
            <span className="flex min-w-0 text-sm">
              <AccountName name={row?.name ?? account.id} />
            </span>
            <div className="order-last col-span-2 min-w-0 @sm/health:order-none @sm/health:col-span-1">
              <HealthStrip health={day} />
            </div>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
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
        <CardTitle>
          <h3>Account health</h3>
        </CardTitle>
        <CardDescription>Request outcomes over the last 24 hours, in 30-minute blocks.</CardDescription>
      </CardHeader>
      <CardContent className="@container/health">
        <div className="flex flex-wrap gap-x-4 gap-y-1 pb-4 text-xs text-muted-foreground">
          <Label tone="good" text="Answered" />
          <Label tone="warn" text="Some failed" />
          <Label tone="bad" text="Mostly failed" />
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-muted ring-1 ring-border" />
            No requests
          </span>
        </div>
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
  const query = requestPageAtom(requestPageKey(failures, "today", 5))
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const report = useAtomValue(shownReportAtom)
  const now = useAtomValue(nowAtom)
  const setFilter = useAtomSet(requestFilterAtom)
  const setLimit = useAtomSet(requestLimitAtom)
  const name = (id: string) =>
    Option.match(report, { onNone: () => id, onSome: (r) => r.accounts.find((a) => a.id === id)?.name ?? id })
  return (
    <Card>
      <Loaded
        result={result}
        title="Could not load recent failures"
        onRetry={refresh}
        loading={
          <>
            <CardHeader>
              <CardTitle>
                <h3>Failed today</h3>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Skeleton lines={2} />
            </CardContent>
          </>
        }
      >
        {({ rows, matched }) => (
          <>
            <CardHeader>
              <CardTitle>
                <h3>Failed today</h3>
              </CardTitle>
              <CardDescription>
                {matched === 0
                  ? "No failures recorded today."
                  : `${matched} ${matched === 1 ? "request" : "requests"} failed.`}
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
                    <ChevronRight aria-hidden data-icon="inline-end" />
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
          </>
        )}
      </Loaded>
    </Card>
  )
}
