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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card.tsx"
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
    <Card variant="quota">
      <CardHeader>
        <CardTitle>
          <h3>{current ? "Next reset with quota left" : "Next reset in last report"}</h3>
        </CardTitle>
        <CardDescription>
          <span className="wrap-anywhere">{next.account}</span>
          <span className="block">
            {provider} / {window}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-heading text-quota-number font-semibold tracking-tight tabular-nums">
              {quotaPercent(next.left)}
            </p>
            <p className="text-base font-medium">quota left</p>
          </div>
          <div>
            <Progress
              value={next.used}
              tone="quota"
              aria-label={`${window} quota used`}
              marker={Option.isSome(comparison) ? comparison.value.elapsed * 100 : undefined}
            />
            <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-quota-muted">
              <span>{quotaPercent(next.used)} used</span>
              <span>Resets in {until(next.resetsAt, now)}</span>
            </div>
            {Option.isSome(comparison) && (
              <p className="mt-2 text-sm font-medium">
                <span className="text-quota-muted">Even pace guide</span> · {comparison.value.text}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3 border-t border-quota-track pt-4">
            <dl className="flex flex-wrap gap-x-5 gap-y-3">
              <div>
                <dt className="text-xs text-quota-muted">Reset time</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  <time dateTime={DateTime.formatIso(next.resetsAt)}>{clock(next.resetsAt, now, zone)}</time>
                </dd>
              </div>
              {required !== undefined && (
                <div>
                  <dt className="text-xs text-quota-muted">Pace to use it all</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">{required}% per hour</dd>
                </div>
              )}
              {current && next.estimatedValue !== undefined && (
                <div>
                  <dt className="text-xs text-quota-muted">Est. value if unused</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">{dollars(next.estimatedValue)}</dd>
                </div>
              )}
            </dl>
            <ButtonLink variant="quota" href={pageHash(Pages.provider(next.provider, next.accountId))}>
              View account
              <ChevronRight aria-hidden data-icon="inline-end" />
            </ButtonLink>
          </div>
        </div>
      </CardContent>
    </Card>
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
    <li className="min-w-0 border-t first:border-t-0">
      <a
        href={pageHash(Pages.provider(entry.provider, entry.accountId))}
        className="grid min-w-0 grid-cols-[1fr_auto] items-center gap-x-3 px-5 py-3.5 text-sm outline-none hover:bg-accent/55 focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-6"
      >
        <span className="min-w-0">
          <span className="block font-medium wrap-anywhere">{entry.account}</span>
          <span className="block text-xs text-muted-foreground">
            {providerTitle(entry.provider)} / {spanTitle(entry.span)}
          </span>
        </span>
        <span className="text-right tabular-nums">
          <span className="block font-semibold">{quotaPercent(entry.left)} left</span>
          <span className="block text-xs text-muted-foreground">In {until(entry.resetsAt, now)}</span>
          {current && entry.estimatedValue !== undefined && (
            <span className="block text-xs text-muted-foreground">Est. {dollars(entry.estimatedValue)} if unused</span>
          )}
        </span>
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
          Quota before reset
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
        </Card>
      ) : (
        <div className="grid min-w-0 items-start gap-3 @4xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <ResetLead next={next} now={now} current={current} />
          <Card size="flush">
            <CardHeader className="my-5 sm:my-6">
              <CardTitle>
                <h3>Reset queue</h3>
              </CardTitle>
              <CardDescription>Other reported resets, soonest first.</CardDescription>
            </CardHeader>
            {rest.length > 0 ? (
              <div className="border-t">
                <ol>
                  {rest.slice(0, queueSize).map((entry) => (
                    <ResetRow key={entry.id} entry={entry} now={now} current={current} />
                  ))}
                </ol>
                {rest.length > queueSize && (
                  <Collapsible key={scope}>
                    <CollapsibleContent>
                      <ol start={queueSize + 1} className="border-t">
                        {rest.slice(queueSize).map((entry) => (
                          <ResetRow key={entry.id} entry={entry} now={now} current={current} />
                        ))}
                      </ol>
                    </CollapsibleContent>
                    <div className="px-5 pt-2 sm:px-6">
                      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
                        {rest.length - queueSize} more resets
                      </CollapsibleTrigger>
                    </div>
                  </Collapsible>
                )}
              </div>
            ) : (
              <CardContent className="mb-5 sm:mb-6">
                <p className="text-sm text-muted-foreground">No other usable windows in this range.</p>
              </CardContent>
            )}
            <CardFooter density="compact">
              <ButtonLink variant="link" size="sm" href={pageHash(Pages.usage)}>
                Review past resets
                <ChevronRight aria-hidden data-icon="inline-end" />
              </ButtonLink>
            </CardFooter>
          </Card>
        </div>
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
