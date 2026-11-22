// The checks `slopmax doctor` runs, with what to do about each.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Section as DoctorSection } from "@slopmax/client"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Copy, RefreshCw } from "lucide-react"
import { copy, doctorAtom, readOnlyAtom } from "../atoms.ts"
import { Empty, Failed, Label, Panel, Section } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { Item, ItemActions, ItemContent, ItemMedia } from "../components/ui/item.tsx"
import { readOnlyShort } from "../view/tailnet.ts"
import { failureText, levelTone, sentenceCase } from "../view/words.ts"

const findingLabels = { ok: "Passed", info: "Info", warn: "Warning", fail: "Failed" } as const
const literal = /(`[^`]+`|https?:\/\/[^\s,)]+|\b(?:\d{1,3}\.){3}\d{1,3}:\d+|\[[a-f\d:]+\]:\d+)/i

function Findings({ sections }: { readonly sections: ReadonlyArray<DoctorSection> }) {
  const copyText = useAtomSet(copy)
  return (
    <>
      {sections.map((section) => (
        <Section title={section.title} key={section.title} layout="split">
          <Panel>
            <ul role="list" className="divide-y">
              {section.findings.map((finding, index) => (
                <li key={`${finding.text}-${index}`}>
                  <Item size="row" className="items-start">
                    <ItemMedia className="w-18 justify-start">
                      <Label tone={levelTone(finding.level)} text={findingLabels[finding.level]} raw dot />
                    </ItemMedia>
                    <ItemContent className="min-w-0 wrap-anywhere">
                      <p>
                        {sentenceCase(finding.text)
                          .split(literal)
                          .map((part, position) =>
                            position % 2 === 0 ? part : <code key={position}>{part.replace(/^`|`$/g, "")}</code>,
                          )}
                      </p>
                    </ItemContent>
                    {finding.fix !== undefined && (
                      <ItemActions className="min-w-0 flex-wrap">
                        <code className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere">
                          {finding.fix}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Copy the command"
                          onClick={() => copyText({ text: finding.fix ?? "" })}
                        >
                          <Copy aria-hidden />
                          Copy
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      ))}
    </>
  )
}

const checking = <Empty title="Checking your setup…" detail="The same checks slopmax doctor runs." />

export function DiagnosticsPage() {
  const doctor = useAtomValue(doctorAtom)
  const again = useAtomRefresh(doctorAtom)
  const readOnly = useAtomValue(readOnlyAtom)
  const sections = AsyncResult.value(doctor)
  const body = readOnly ? (
    <Empty title={readOnlyShort} detail="Run slopmax doctor on the hub to check its setup." />
  ) : Option.isSome(sections) ? (
    <Findings sections={sections.value} />
  ) : AsyncResult.isFailure(doctor) ? (
    <Failed title="Could not check the setup" detail={failureText(doctor.cause)} onRetry={again} />
  ) : (
    checking
  )
  return body
}

export function DiagnosticsTools() {
  const doctor = useAtomValue(doctorAtom)
  const again = useAtomRefresh(doctorAtom)
  if (useAtomValue(readOnlyAtom)) return null
  return (
    <Button variant="outline" disabled={AsyncResult.isWaiting(doctor) || AsyncResult.isInitial(doctor)} onClick={again}>
      <RefreshCw />
      Check again
    </Button>
  )
}
