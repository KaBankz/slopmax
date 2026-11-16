// Requests as slopmax answers them, newest first, straight off the event
// stream: who sent it, the model, the account that answered (and whether a
// failover rescued it), its status, its tokens and how long it took.
import { useAtomValue } from "@effect/atom-react"
import { cva } from "class-variance-authority"
import { Option } from "effect"
import { Activity } from "lucide-react"
import type { ReactNode } from "react"
import { feedAtom, liveAtom, shownReportAtom, zone } from "../atoms.ts"
import { Label } from "../components/parts.tsx"
import { Quiet } from "../components/quiet.tsx"
import { Card, CardContent } from "../components/ui/card.tsx"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx"
import { feedRow, feedSize } from "../view/live.ts"

const figureVariants = cva("animate-in text-right tabular-nums fade-in", {
  variants: { muted: { true: "text-muted-foreground", false: "" } },
})

/** A figure in a table cell, right-aligned so the column's digits line up. */
function Figure({ children, muted = false }: { readonly children?: ReactNode; readonly muted?: boolean }) {
  return <div className={figureVariants({ muted })}>{children}</div>
}

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
      <Quiet
        icon={Activity}
        title={live._tag === "Running" ? "Waiting for requests" : "Connecting to the proxy…"}
        detail="Answered and failed requests show here as they happen."
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-18">Time</TableHead>
                <TableHead className="w-24">Agent</TableHead>
                <TableHead className="w-40">Model</TableHead>
                <TableHead className="w-full">Account</TableHead>
                <TableHead className="w-12 text-right">Status</TableHead>
                <TableHead className="w-14 text-right">Tokens</TableHead>
                <TableHead className="w-28 text-right">First byte · total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {feed.map((entry) => {
                const row = feedRow(entry.record, name, zone)
                return (
                  <TableRow key={entry.seq}>
                    <TableCell>
                      <div className="animate-in text-muted-foreground tabular-nums fade-in">{row.time}</div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-24 animate-in truncate fade-in">{row.who}</div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-40 animate-in truncate font-mono text-xs fade-in">{row.model}</div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-0 min-w-full animate-in truncate text-muted-foreground fade-in">
                        {row.detail}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex animate-in justify-end tabular-nums fade-in">
                        <Label tone={row.failed ? "bad" : "muted"} text={row.status} raw />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Figure>{row.tokens}</Figure>
                    </TableCell>
                    <TableCell>
                      <Figure muted>{row.took}</Figure>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">The newest {feedSize} requests since this page opened.</p>
    </div>
  )
}
