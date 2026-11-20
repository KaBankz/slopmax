// Client keys and the other machines that connect to slopmax.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { NotFound } from "@slopmax/client"
import { Cause, Exit, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { CircleAlert, Copy, KeyRound } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import {
  canChangeAtom,
  copy,
  dismissNewKey,
  keysAtom,
  makeKey,
  newKeyAtom,
  prefsAtom,
  readOnlyAtom,
  revokeKey,
  tailnetAtom,
  unansweredAtom,
} from "../atoms.ts"
import { useAsk } from "../components/ask.tsx"
import { Failed, Loaded, Panel, Section, SettingRow, Skeleton } from "../components/parts.tsx"
import { ModelPatternHelp } from "../components/model-pattern-help.tsx"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.tsx"
import { Button, ButtonLink } from "../components/ui/button.tsx"
import { Field, FieldError } from "../components/ui/field.tsx"
import { Input } from "../components/ui/input.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../components/ui/input-group.tsx"
import { Item, ItemContent, ItemDescription } from "../components/ui/item.tsx"
import { askRevoke } from "../view/asks.ts"
import { cannotChange } from "../view/live.ts"
import { pageHash, Pages } from "../view/pages.ts"
import { maskEmails } from "../view/privacy.ts"
import { machinesCard } from "../view/tailnet.ts"
import { failureText, patterns, sentenceCase } from "../view/words.ts"

function NewKeyWell() {
  const shown = useAtomValue(newKeyAtom)
  const copyText = useAtomSet(copy)
  const done = useAtomSet(dismissNewKey)
  if (Option.isNone(shown)) return null
  const made = shown.value
  return (
    <div className="animate-in fade-in slide-in-from-top-1">
      <Alert role="status">
        <KeyRound />
        <AlertTitle>The key {made.name}</AlertTitle>
        <AlertDescription>
          Copy it now: you won't see it again. Give it to the tool as its API key, with slopmax's address.
        </AlertDescription>
        <div className="col-start-2 mt-2 flex items-center gap-2">
          <InputGroup>
            <InputGroupInput readOnly aria-label={`The key ${made.name}`} value={made.key} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => copyText({ text: made.key })}>
                <Copy />
                Copy
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Button variant="outline" onClick={() => done()}>
            Done
          </Button>
        </div>
      </Alert>
    </div>
  )
}

/** A line in the keys' panel where rows would be: what there is instead. */
function Note({ children }: { readonly children: ReactNode }) {
  return (
    <Item>
      <ItemContent>
        <ItemDescription>{children}</ItemDescription>
      </ItemContent>
    </Item>
  )
}

function ClientKeys() {
  const keys = useAtomValue(keysAtom)
  const again = useAtomRefresh(keysAtom)
  const canChange = useAtomValue(canChangeAtom)
  const waiting = cannotChange(useAtomValue(unansweredAtom), useAtomValue(readOnlyAtom))
  const make = useAtomSet(makeKey, { mode: "promiseExit" })
  const revoke = useAtomSet(revokeKey)
  const ask = useAsk()
  const [name, setName] = useState("")
  const [models, setModels] = useState("")
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const errorId = useId()
  // The form is cleared only once the key is made, so a refused name keeps what was typed.
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === "" || busy) return
    setRefused(undefined)
    setBusy(true)
    void make({ name, models: patterns(models) }).then((exit) => {
      setBusy(false)
      if (Exit.isFailure(exit)) return setRefused(failureText(exit.cause))
      setName("")
      setModels("")
    })
  }
  return (
    <Section title="Client keys" headingId="connection-clients">
      <div className="flex flex-col gap-2">
        <NewKeyWell />
        <Panel>
          {!canChange ? (
            waiting === undefined ? (
              <Skeleton lines={2} />
            ) : (
              <Note>{waiting}.</Note>
            )
          ) : (
            <Loaded result={keys} title="Could not read the keys" loading={<Skeleton lines={2} />} onRetry={again}>
              {(list) => (
                <>
                  {list.map((key) => (
                    <SettingRow
                      key={key.name}
                      title={key.name}
                      detail={
                        key.models.length === 0 ? (
                          "Any model"
                        ) : (
                          <span className="font-mono text-xs">{key.models.join(", ")}</span>
                        )
                      }
                    >
                      <Button
                        variant="outline"
                        aria-label={`Revoke the key ${key.name}…`}
                        onClick={() =>
                          void ask(askRevoke(key.name)).then((answer) => {
                            if (answer !== null) revoke(key.name)
                          })
                        }
                      >
                        Revoke…
                      </Button>
                    </SettingRow>
                  ))}
                  {list.length === 0 && <Note>No client keys yet. Agents on this machine use slopmax's own key.</Note>}
                </>
              )}
            </Loaded>
          )}
          <form onSubmit={submit} className="flex flex-col gap-2 border-t px-3 py-2.5">
            <Field orientation="horizontal" className="flex-wrap">
              <Input
                aria-label="Name, such as laptop"
                placeholder="Name, such as laptop"
                className="w-50 max-w-full shrink-0"
                value={name}
                aria-invalid={refused !== undefined || undefined}
                aria-describedby={refused === undefined ? undefined : errorId}
                onChange={(e) => {
                  setName(e.currentTarget.value)
                  setRefused(undefined)
                }}
              />
              <Input
                aria-label="Models it may use"
                aria-describedby={`${errorId}-models-help`}
                className="min-w-40 flex-1"
                placeholder="Any model"
                value={models}
                onChange={(e) => setModels(e.currentTarget.value)}
              />
              <Button type="submit" disabled={!canChange || busy || name.trim() === ""}>
                {busy ? "Creating…" : "Create key"}
              </Button>
            </Field>
            <ModelPatternHelp id={`${errorId}-models-help`} />
            {refused !== undefined && <FieldError id={errorId}>{sentenceCase(refused)}</FieldError>}
          </form>
        </Panel>
        <p className="text-xs text-muted-foreground">
          A tool presents its key as an API key. Revoking one refuses it at once; slopmax's own key, in config.toml,
          stays as it is.
        </p>
      </div>
    </Section>
  )
}

/** A command or an address, with a button that copies it. */
function Copyable({ text, label }: { readonly text: string; readonly label: string }) {
  const copyText = useAtomSet(copy)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <code className="min-w-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere select-all">
        {text}
      </code>
      <Button variant="ghost" size="sm" aria-label={label} onClick={() => copyText({ text })}>
        <Copy aria-hidden />
        Copy
      </Button>
    </span>
  )
}

/**
 * How your other machines reach slopmax over your tailnet, as the hub sees
 * it. An older proxy has no such endpoint (404), and the card is left out.
 */
function OtherMachines() {
  const result = useAtomValue(tailnetAtom)
  const again = useAtomRefresh(tailnetAtom)
  const hide = useAtomValue(prefsAtom).hideEmails
  const shown = (text: string) => (hide ? maskEmails(text) : text)
  if (AsyncResult.isFailure(result) && Cause.squash(result.cause) instanceof NotFound) return null
  const view = AsyncResult.value(result)
  if (Option.isNone(view)) {
    if (AsyncResult.isFailure(result)) {
      return (
        <Section title="Other machines">
          <Failed title="Could not read the tailnet" detail={failureText(result.cause)} onRetry={again} />
        </Section>
      )
    }
    return null
  }
  const card = machinesCard(view.value)
  return (
    <Section title="Other machines">
      <div className="flex flex-col gap-2">
        {card.problem !== undefined && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>{sentenceCase(card.problem.text)}</AlertTitle>
            {card.problem.fix !== undefined && (
              <AlertDescription>
                <Copyable text={card.problem.fix} label="Copy the fix" />
              </AlertDescription>
            )}
          </Alert>
        )}
        <Panel>
          {card.rows.map((row) => (
            <SettingRow key={row.title} title={row.title} {...(row.detail === undefined ? {} : { detail: row.detail })}>
              {row.copy === true ? (
                <Copyable text={row.value} label={`Copy ${row.value}`} />
              ) : (
                <span className="text-sm">{shown(row.value)}</span>
              )}
            </SettingRow>
          ))}
          {card.start !== undefined && (
            <div className="border-t first:border-t-0">
              <Note>{card.start}</Note>
            </div>
          )}
        </Panel>
        <p className="text-xs text-muted-foreground">
          The hub is for your own machines: list only your own tailnet logins. Machines Tailscale can't vouch for, such
          as tagged ones, use a client key.
        </p>
      </div>
    </Section>
  )
}

export function ClientAccess() {
  return (
    <>
      <ClientKeys />
      <OtherMachines />
      <p className="text-sm text-muted-foreground">
        Connecting an upstream provider?{" "}
        <ButtonLink href={pageHash(Pages.addAccount)} variant="link" size="sm">
          Add a provider account
        </ButtonLink>
      </p>
    </>
  )
}
