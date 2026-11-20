// The actionable account windows, using the provider's reported quota.
import { type AccountId, type AccountView, type Report, type Span, SubscriptionId, type Window } from "@slopmax/client"
import { fixed } from "@slopmax/client/format"
import { DateTime, Schema } from "effect"

export type QuotaScope = "long" | "5h"

const isSubscription = Schema.is(SubscriptionId)

export interface ResetOpportunity {
  readonly id: string
  readonly account: string
  readonly accountId: AccountId
  readonly provider: SubscriptionId
  readonly span: Span
  readonly used: number
  readonly left: number
  readonly resetsAt: DateTime.Utc
  readonly estimatedValue?: number
}

/** Fee share from the daemon's reminder for this specific account window. */
const unusedValue = (report: Report, account: AccountView, window: Window): number | undefined => {
  const key = `unused:${account.id}:${window.span}:`
  const notice = report.nudges.find((nudge) => {
    if (nudge.kind !== "quota-unused" || nudge.until?.epochMilliseconds !== window.resetsAt?.epochMilliseconds)
      return false
    if (nudge.key.startsWith("unused:")) return nudge.key.startsWith(key)
    return (
      nudge.provider === account.provider &&
      nudge.account === account.name &&
      report.accounts.filter((other) => other.provider === account.provider && other.name === account.name).length === 1
    )
  })
  return notice?.worth
}

export function resetOpportunities(report: Report, now: DateTime.Utc, scope: QuotaScope): ResetOpportunity[] {
  const result: ResetOpportunity[] = []
  for (const account of report.accounts) {
    if (!isSubscription(account.provider) || account.disabled) continue
    if (account.condition._tag !== "Active" && account.condition._tag !== "Ready") continue

    for (const window of account.windows) {
      if (window.model !== undefined || (window.span === "5h") !== (scope === "5h")) continue
      const { resetsAt, used } = window
      if (resetsAt === undefined || resetsAt.epochMilliseconds <= now.epochMilliseconds || used >= 100) continue

      const estimatedValue = unusedValue(report, account, window)
      result.push({
        id: `${account.id}:${window.span}`,
        account: account.name,
        accountId: account.id,
        provider: account.provider,
        span: window.span,
        used,
        left: 100 - used,
        resetsAt,
        ...(estimatedValue === undefined ? {} : { estimatedValue }),
      })
    }
  }
  return result.toSorted(
    (a, b) =>
      a.resetsAt.epochMilliseconds - b.resetsAt.epochMilliseconds || b.left - a.left || a.id.localeCompare(b.id),
  )
}

/** Required average burn in percentage points of this window per hour. */
export const requiredPace = (opportunity: ResetOpportunity, now: DateTime.Utc): string | undefined => {
  const hours = (opportunity.resetsAt.epochMilliseconds - now.epochMilliseconds) / 3_600_000
  if (hours < 5 / 60) return undefined
  const rate = opportunity.left / hours
  if (rate < 0.1) return "<0.1"
  return fixed(rate, 1)
}

export const quotaPercent = (value: number): string => {
  if (value > 0 && value < 1) return "<1%"
  if (value > 99 && value < 100) return ">99%"
  return `${fixed(value, 0)}%`
}
