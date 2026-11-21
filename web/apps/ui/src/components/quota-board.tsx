// A reset queue for shared account windows, led by the next usable window.
import { useAtomValue } from "@effect/atom-react"
import { type Report, Window } from "@slopmax/client"
import { clock, pace, providerTitle, until } from "@slopmax/client/format"
import { DateTime, Option } from "effect"
import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { nowAtom, pollOffAtom, unansweredAtom, zone } from "../atoms.ts"
import { spanTitle } from "../view/groups.ts"
import { pageHash, Pages } from "../view/pages.ts"
import { dollars } from "../view/words.ts"
import {
  quotaPercent,
  type QuotaScope,
  requiredPace,
  type ResetOpportunity,
  resetOpportunities,
} from "../view/quota.ts"
import { Segmented } from "./segmented.tsx"
import { Button, ButtonLink } from "./ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"
import { Progress } from "./ui/progress.tsx"

const scopes: ReadonlyArray<{ value: QuotaScope; title: string }> = [
  { value: "long", title: "Weekly & monthly" },
  { value: "5h", title: "5-hour" },
]

const queueSize = 3

function ResetLead({
  next,
  now,
  current,
}: {
  readonly next: ResetOpportunity
  readonly now: DateTime.Utc
  readonly current: boolean
}) {
  const provider = providerTitle(next.provider)
  const window = spanTitle(next.span)
  const required = current ? requiredPace(next, now) : undefined
  const comparison = current ? pace(Window.of(next.span, next.used, next.resetsAt), now, zone) : Option.none()
  return (
    <CardContent className="my-5 sm:my-6">
      <div className="grid gap-x-8 gap-y-4 @3xl:reset-columns @3xl:items-start @3xl:gap-y-0">
        <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">
          <CardDescription>{current ? "Next reset with quota left" : "Next reset in last report"}</CardDescription>
          <CardTitle>
            <h3 className="mt-1 wrap-anywhere">{next.account}</h3>
          </CardTitle>
          <p className="mt-0.5 text-sm text-quota-muted">
            {provider} · {window}
          </p>
        </div>
        <div className="min-w-0 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1 @3xl:self-center">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="font-heading text-quota-number font-semibold text-quota-fill tracking-tight tabular-nums">
              {quotaPercent(next.left)}
            </p>
            <p className="text-sm font-medium">quota left</p>
          </div>
          <Progress
            value={next.used}
            tone="quota"
            aria-label={`${window} quota used`}
            marker={Option.isSome(comparison) ? comparison.value.elapsed * 100 : undefined}
          />
          <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-quota-muted">
            <span>{quotaPercent(next.used)} used</span>
            {Option.isSome(comparison) && (
              <span>
                Even pace guide · <span className="font-medium text-quota-foreground">{comparison.value.text}</span>
              </span>
            )}
          </div>
        </div>
        <div className="border-t border-quota-track pt-3 @3xl:col-start-3 @3xl:row-span-2 @3xl:row-start-1 @3xl:self-center @3xl:border-t-0 @3xl:border-s @3xl:ps-5 @3xl:pt-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
            <p className="font-semibold">Resets in {until(next.resetsAt, now)}</p>
            <time className="text-xs text-quota-muted" dateTime={DateTime.formatIso(next.resetsAt)}>
              {clock(next.resetsAt, now, zone)}
            </time>
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 @3xl:gap-x-4">
            {required !== undefined && (
              <div>
                <dt className="text-xs text-quota-muted">Pace to use it all</dt>
                <dd className="font-medium tabular-nums">{required}% per hour</dd>
              </div>
            )}
            {current && next.estimatedValue !== undefined && (
              <div>
                <dt className="text-xs text-quota-muted">Est. value if unused</dt>
                <dd className="font-medium tabular-nums">{dollars(next.estimatedValue)}</dd>
              </div>
            )}
          </dl>
        </div>
        <ButtonLink
          variant="quota"
          size="pageAction"
          className="w-fit @3xl:col-start-1 @3xl:row-start-2 @3xl:mt-3"
          href={pageHash(Pages.provider(next.provider, next.accountId))}
        >
          View account
          <ChevronRight aria-hidden data-icon="inline-end" />
        </ButtonLink>
      </div>
    </CardContent>
  )
}

function ResetRow({
  entry,
  now,
  current,
}: {
  readonly entry: ResetOpportunity
  readonly now: DateTime.Utc
  readonly current: boolean
}) {
  return (
    <li className="min-w-0 border-t">
      <a
        href={pageHash(Pages.provider(entry.provider, entry.accountId))}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-5 py-3 text-sm outline-none hover:bg-accent/55 focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-6 @3xl:reset-columns @3xl:gap-x-8"
      >
        <div className="min-w-0">
          <p className="font-medium wrap-anywhere">{entry.account}</p>
          <p className="text-xs text-muted-foreground">
            {providerTitle(entry.provider)} · {spanTitle(entry.span)}
          </p>
        </div>
        <div className="min-w-0 text-right tabular-nums @3xl:text-left">
          <p className="font-semibold">{quotaPercent(entry.left)} left</p>
          <Progress
            aria-hidden
            value={entry.used}
            tone="allowance"
            className="mt-1 ms-auto w-24 @3xl:ms-0 @3xl:w-full"
          />
        </div>
        <div className="col-span-2 flex items-center justify-between gap-2 text-xs tabular-nums @3xl:col-span-1 @3xl:ps-5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted-foreground">
            <p className="font-medium text-foreground">Resets in {until(entry.resetsAt, now)}</p>
            <time dateTime={DateTime.formatIso(entry.resetsAt)}>{clock(entry.resetsAt, now, zone)}</time>
            {current && entry.estimatedValue !== undefined && <p>Est. {dollars(entry.estimatedValue)} if unused</p>}
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </a>
    </li>
  )
}

export function QuotaBoard({ report }: { readonly report: Report }) {
  const now = useAtomValue(nowAtom)
  const paused = useAtomValue(pollOffAtom)
  const offline = useAtomValue(unansweredAtom)
  const [selected, select] = useState<QuotaScope | undefined>(undefined)
  const long = resetOpportunities(report, now, "long")
  const short = resetOpportunities(report, now, "5h")
  const scope = selected ?? (long.length === 0 && short.length > 0 ? "5h" : "long")
  const queue = scope === "long" ? long : short
  const [next, ...rest] = queue
  const current = report.live && !offline
  const alternative = (scope === "long" ? short : long)[0]
  const otherResetsSooner =
    alternative !== undefined &&
    (next === undefined || alternative.resetsAt.epochMilliseconds < next.resetsAt.epochMilliseconds)
  const scopeOptions = scopes.map((option) => ({
    ...option,
    ...(option.value !== scope && otherResetsSooner ? { detail: until(alternative.resetsAt, now) } : {}),
  }))
  const nextSession =
    next === undefined ? undefined : report.pools.find((pool) => pool.provider === next.provider)?.next
  const routesElsewhere =
    nextSession !== undefined && nextSession.account !== next?.accountId
      ? report.accounts.find((account) => account.id === nextSession.account)
      : undefined
  return (
    <section aria-labelledby="quota-heading" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <h2 id="quota-heading" className="font-heading text-xl font-semibold tracking-tight">
          Reset opportunities
        </h2>
        <Segmented label="Quota window" value={scope} onChange={select} options={scopeOptions} />
      </div>
      {next === undefined ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h3>No spendable quota with a known reset</h3>
            </CardTitle>
            <CardDescription>
              Check Subscription limits for blocked accounts and windows awaiting a reading.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ButtonLink variant="link" size="sm" href={pageHash(Pages.quotaHistory)}>
              Review past resets
              <ChevronRight aria-hidden data-icon="inline-end" />
            </ButtonLink>
          </CardContent>
        </Card>
      ) : (
        <Card size="flush" variant="quota">
          <ResetLead next={next} now={now} current={current} />
          {rest.length > 0 && (
            <div className="border-t bg-card text-card-foreground">
              <CardHeader className="my-3">
                <CardTitle className="text-base">
                  <h3>Later resets</h3>
                </CardTitle>
              </CardHeader>
              <ol>
                {rest.slice(0, queueSize).map((entry) => (
                  <ResetRow key={entry.id} entry={entry} now={now} current={current} />
                ))}
              </ol>
              {rest.length > queueSize && (
                <Collapsible key={scope}>
                  <CollapsibleContent>
                    <ol start={queueSize + 1}>
                      {rest.slice(queueSize).map((entry) => (
                        <ResetRow key={entry.id} entry={entry} now={now} current={current} />
                      ))}
                    </ol>
                  </CollapsibleContent>
                  <div className="border-t px-5 py-2 sm:px-6">
                    <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
                      {rest.length - queueSize} more resets
                    </CollapsibleTrigger>
                  </div>
                </Collapsible>
              )}
            </div>
          )}
        </Card>
      )}
      {next !== undefined && current && routesElsewhere !== undefined && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <p className="text-muted-foreground">
            New {providerTitle(next.provider)} sessions currently go to{" "}
            <span className="font-medium text-foreground wrap-anywhere">{routesElsewhere.name}</span>.
          </p>
          <ButtonLink variant="link" size="sm" href={pageHash(Pages.settings)}>
            Routing settings
          </ButtonLink>
        </div>
      )}
      {next !== undefined && (
        <p className="text-sm text-muted-foreground">
          {current
            ? `${paused ? "Automatic polling is off. " : ""}Based on the last provider readings. Other limits can restrict what you can use. Estimated value is the unused share of the plan fee.`
            : "Showing the last available quota readings. Updated readings are needed to calculate a pace."}
        </p>
      )}
    </section>
  )
}
