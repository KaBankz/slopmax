// The checks `slopmax doctor` runs, with what to do about each. While the
// desktop's proxy is stopped, the findings come from the CLI instead.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Section as DoctorSection } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Copy, RefreshCw } from "lucide-react"
import { Fragment } from "react"
import { copy, doctorAtom, offlineAtom } from "../atoms.ts"
import { Dot, Empty, Failed, Panel } from "../components/parts.tsx"
import { Tip } from "../components/tip.tsx"
import { Button } from "../components/ui/button.tsx"
import { Item, ItemActions, ItemContent, ItemMedia } from "../components/ui/item.tsx"
import { Separator } from "../components/ui/separator.tsx"
import { failureText, levelTone, sentenceCase } from "../view/words.ts"

function Findings({ sections }: { readonly sections: ReadonlyArray<DoctorSection> }) {
  const copyText = useAtomSet(copy)
  const rows = sections.flatMap((section) =>
    section.findings.map((finding, i) => ({ section: i === 0 ? section.title : "", key: section.title, finding })),
  )
  return (
    <Panel>
      {rows.map(({ section, key, finding }, n) => (
        <Fragment key={`${key}-${finding.text}`}>
          {n > 0 && <Separator />}
          <Item className="items-start">
            <span className="w-30 shrink-0 text-xs/5 text-muted-foreground">{section}</span>
            <ItemMedia className="h-5">
              <Dot tone={levelTone(finding.level)} />
            </ItemMedia>
            <ItemContent>{sentenceCase(finding.text.replaceAll("`", ""))}</ItemContent>
            {finding.fix !== undefined && (
              <ItemActions className="shrink-0">
                <code className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-xs">{finding.fix}</code>
                <Tip content="Copy the command">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy the command"
                    onClick={() => copyText({ text: finding.fix ?? "" })}
                  >
                    <Copy />
                  </Button>
                </Tip>
              </ItemActions>
            )}
          </Item>
        </Fragment>
      ))}
    </Panel>
  )
}

const checking = <Empty title="Checking your setup…" detail="The same checks slopmax doctor runs." />

export function DiagnosticsPage() {
  const offline = AsyncResult.getOrElse(useAtomValue(offlineAtom), () => Option.none())
  const doctor = useAtomValue(doctorAtom)
  const again = useAtomRefresh(doctorAtom)
  const sections = Option.isSome(offline) ? Option.some(offline.value.doctor) : AsyncResult.value(doctor)
  const body = Option.isSome(sections) ? (
    <Findings sections={sections.value} />
  ) : AsyncResult.isFailure(doctor) ? (
    <Failed title="Could not check the setup" detail={failureText(doctor.cause)} onRetry={again} />
  ) : (
    checking
  )
  return (
    <>
      <p className="max-w-prose text-muted-foreground">The checks slopmax doctor runs, with what to do about each.</p>
      {body}
    </>
  )
}

export function DiagnosticsTools() {
  const doctor = useAtomValue(doctorAtom)
  const again = useAtomRefresh(doctorAtom)
  return (
    <Button variant="outline" disabled={AsyncResult.isWaiting(doctor) || AsyncResult.isInitial(doctor)} onClick={again}>
      <RefreshCw />
      Check again
    </Button>
  )
}
