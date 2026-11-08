// The checks `slopmax doctor` runs, with what to do about each. While the
// desktop's proxy is stopped, the findings come from the CLI instead.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Section as DoctorSection } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Copy, RefreshCw } from "lucide-react"
import { copy, doctorAtom, offlineAtom } from "../atoms.ts"
import { Dot, Empty, Failed, Panel } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { Tip } from "../components/ui/tooltip.tsx"
import { failureText, levelTone, sentenceCase } from "../view/words.ts"

function Findings({ sections }: { readonly sections: ReadonlyArray<DoctorSection> }) {
  const copyText = useAtomSet(copy)
  return (
    <Panel>
      {sections.flatMap((section) =>
        section.findings.map((finding, i) => (
          <div
            key={`${section.title}-${finding.text}`}
            className="flex items-start gap-3 border-t border-separator px-4 py-2.5 first:border-t-0"
          >
            <span className="w-30 shrink-0 text-small text-muted-foreground">{i === 0 ? section.title : ""}</span>
            <span className="flex h-4.5 items-center">
              <Dot tone={levelTone(finding.level)} />
            </span>
            <span className="min-w-0 flex-1">{sentenceCase(finding.text.replaceAll("`", ""))}</span>
            {finding.fix !== undefined && (
              <span className="flex shrink-0 items-center gap-1">
                <code className="rounded-sm border bg-well px-1.5 py-0.5 font-mono text-caption">{finding.fix}</code>
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
              </span>
            )}
          </div>
        )),
      )}
    </Panel>
  )
}

const checking = <Empty title="Checking your setup…" detail="The same checks slopmax doctor runs." />

export function DiagnosticsPage() {
  const offline = AsyncResult.getOrElse(useAtomValue(offlineAtom), () => Option.none())
  const doctor = useAtomValue(doctorAtom)
  const sections = Option.isSome(offline) ? Option.some(offline.value.doctor) : AsyncResult.value(doctor)
  const body = Option.isSome(sections) ? (
    <Findings sections={sections.value} />
  ) : AsyncResult.isFailure(doctor) ? (
    <Failed title="Could not check the setup" detail={failureText(doctor.cause)} />
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
    <Button disabled={AsyncResult.isWaiting(doctor) || AsyncResult.isInitial(doctor)} onClick={again}>
      <RefreshCw />
      Check again
    </Button>
  )
}
