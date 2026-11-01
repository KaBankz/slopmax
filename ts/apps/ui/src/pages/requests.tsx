// Requests as slopmax answers them, newest first, straight off the event
// stream: who sent it, the model, the account that answered (and whether a
// failover rescued it), its status, its tokens and how long it took.
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { Activity } from "lucide-react"
import { feedAtom, liveAtom, shownReportAtom, zone } from "../atoms.ts"
import { Dot, Empty, Panel } from "../components/parts.tsx"
import { feedRow, feedSize } from "../view/live.ts"

export function RequestsPage() {
  const feed = useAtomValue(feedAtom)
  const live = useAtomValue(liveAtom)
  const report = useAtomValue(shownReportAtom)
  const name = (id: string) =>
    Option.match(report, {
      onNone: () => id,
      onSome: (r) => r.accounts.find((a) => a.id === id)?.name ?? id,
    })
  if (feed.length === 0) {
    return (
      <Empty
        icon={Activity}
        title={live._tag === "Running" ? "Waiting for requests" : "Connecting to the proxy…"}
        detail="Answered and failed requests as they happen."
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Panel>
        <div className="flex items-center gap-3 border-b border-separator px-4 py-2 text-small text-muted-foreground">
          <span className="w-18 shrink-0">Time</span>
          <span className="w-24 shrink-0">Agent</span>
          <span className="w-40 shrink-0">Model</span>
          <span className="min-w-0 flex-1">Account</span>
          <span className="w-12 shrink-0 text-right">Status</span>
          <span className="w-14 shrink-0 text-right">Tokens</span>
          <span className="w-28 shrink-0 text-right">First byte · total</span>
        </div>
        {feed.map((entry) => {
          const row = feedRow(entry.record, name, zone)
          return (
            <div
              key={entry.seq}
              className="flex animate-flash items-center gap-3 border-t border-separator px-4 py-2 text-small first:border-t-0"
            >
              <span className="w-18 shrink-0 text-muted-foreground tabular">{row.time}</span>
              <span className="w-24 shrink-0 truncate">{row.who}</span>
              <span className="w-40 shrink-0 truncate font-mono text-caption">{row.model}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.detail}</span>
              <span
                className={
                  row.failed
                    ? "inline-flex w-12 shrink-0 items-center justify-end gap-1.5 text-danger tabular"
                    : "inline-flex w-12 shrink-0 items-center justify-end gap-1.5 text-muted-foreground tabular"
                }
              >
                {row.failed && <Dot tone="bad" />}
                {row.status}
              </span>
              <span className="w-14 shrink-0 text-right tabular">{row.tokens}</span>
              <span className="w-28 shrink-0 text-right text-muted-foreground tabular">{row.took}</span>
            </div>
          )
        })}
      </Panel>
      <p className="text-caption text-faint">The newest {feedSize} requests since this page opened.</p>
    </div>
  )
}
