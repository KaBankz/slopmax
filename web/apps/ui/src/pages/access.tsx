// The accounts slopmax sends requests to, and the keys other machines and
// tools reach it with: sign in, import logins, add an API key or a
// compatible endpoint, make or revoke client keys, and see how your other
// machines reach slopmax over your tailnet.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Dialect } from "@slopmax/client"
import { NotFound, providerFacts } from "@slopmax/client"
import { Cause, Exit, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { CircleAlert, Copy, KeyRound } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import {
  addAccount,
  canChangeAtom,
  copy,
  dismissNewKey,
  importLogins,
  keysAtom,
  makeKey,
  newKeyAtom,
  prefsAtom,
  readOnlyAtom,
  revokeKey,
  signIn,
  tailnetAtom,
  unansweredAtom,
} from "../atoms.ts"
import { useAsk } from "../components/ask.tsx"
import { Failed, Loaded, Panel, Section, SettingRow, Skeleton } from "../components/parts.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Tip } from "../components/tip.tsx"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.tsx"
import { Button } from "../components/ui/button.tsx"
import { Field, FieldError, FieldLabel, FieldTitle } from "../components/ui/field.tsx"
import { Input } from "../components/ui/input.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../components/ui/input-group.tsx"
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "../components/ui/item.tsx"
import { askRevoke } from "../view/asks.ts"
import { cannotChange } from "../view/live.ts"
import { maskEmails } from "../view/privacy.ts"
import { machinesCard } from "../view/tailnet.ts"
import { failureText, patterns, sentenceCase } from "../view/words.ts"

type KeyProvider = "anthropic" | "openai" | "xai"
const keyProviders: ReadonlyArray<KeyProvider> = ["anthropic", "openai", "xai"]

const dialects: ReadonlyArray<{ readonly value: Dialect; readonly title: string }> = [
  { value: "chat", title: "Chat completions" },
  { value: "responses", title: "Responses" },
  { value: "messages", title: "Messages" },
]

function KeyRow({ disabled }: { readonly disabled: boolean }) {
  const add = useAtomSet(addAccount, { mode: "promiseExit" })
  const [provider, setProvider] = useState<KeyProvider>("anthropic")
  const [key, setKey] = useState("")
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const errorId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "" || busy) return
    setRefused(undefined)
    setBusy(true)
    void add({ _tag: "Key", provider, key: key.trim() }).then((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) setKey("")
      else setRefused(failureText(exit.cause))
    })
  }
  // A SettingRow, but why a key was refused takes the place of its description,
  // with the form that asked rather than as a toast.
  return (
    <div className="border-t first:border-t-0">
      <Item>
        <ItemContent>
          <ItemTitle>API key</ItemTitle>
          {refused === undefined ? (
            <ItemDescription>A key bills by the token; slopmax spends subscriptions first.</ItemDescription>
          ) : (
            <FieldError id={errorId}>{sentenceCase(refused)}</FieldError>
          )}
        </ItemContent>
        <ItemActions>
          <form onSubmit={submit} className="flex items-center gap-2">
            <Segmented
              label="Provider"
              value={provider}
              onChange={setProvider}
              options={keyProviders.map((id) => ({ value: id, title: providerFacts[id].title }))}
            />
            <Input
              type="password"
              aria-label="Paste an API key"
              placeholder="Paste an API key"
              className="w-56"
              value={key}
              aria-invalid={refused !== undefined || undefined}
              aria-describedby={refused === undefined ? undefined : errorId}
              onChange={(event) => setKey(event.currentTarget.value)}
            />
            <Button type="submit" disabled={disabled || busy || key.trim() === ""}>
              {busy ? "Checking key…" : "Add key"}
            </Button>
          </form>
        </ItemActions>
      </Item>
    </div>
  )
}

/** A field of the endpoint form: its label in a column at the left, the control beside it. */
function Line({
  label,
  htmlFor,
  invalid = false,
  children,
}: {
  readonly label: string
  readonly htmlFor: string
  readonly invalid?: boolean
  readonly children: ReactNode
}) {
  return (
    <Field orientation="horizontal" data-invalid={invalid || undefined} className="grid grid-cols-[6rem_1fr]">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
    </Field>
  )
}

function EndpointRow({ disabled }: { readonly disabled: boolean }) {
  const add = useAtomSet(addAccount, { mode: "promiseExit" })
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const id = useId()
  const errorId = `${id}-error`
  const invalid = {
    "aria-invalid": refused !== undefined || undefined,
    "aria-describedby": refused === undefined ? undefined : errorId,
  }
  const [url, setUrl] = useState("")
  const [dialect, setDialect] = useState<Dialect>("chat")
  const [models, setModels] = useState("")
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (url.trim() === "" || busy) return
    setRefused(undefined)
    setBusy(true)
    void add({
      _tag: "Endpoint",
      url: url.trim().replace(/\/+$/, ""),
      dialect,
      models: patterns(models),
      ...(key.trim() === "" ? {} : { key: key.trim() }),
      ...(name.trim() === "" ? {} : { label: name.trim() }),
    }).then((exit) => {
      setBusy(false)
      if (Exit.isFailure(exit)) return setRefused(failureText(exit.cause))
      setUrl("")
      setModels("")
      setKey("")
      setName("")
    })
  }
  return (
    <div className="border-t first:border-t-0">
      <Item>
        <ItemContent>
          <ItemTitle>Compatible endpoint</ItemTitle>
          <ItemDescription>
            An API that speaks OpenAI's or Anthropic's format, such as a local model server or a gateway. Its key is
            checked before it is saved.
          </ItemDescription>
        </ItemContent>
        <ItemFooter>
          <form onSubmit={submit} className="flex w-full max-w-5xl flex-col gap-2">
            <Line label="Address" htmlFor={`${id}-url`} invalid={refused !== undefined}>
              <Input
                id={`${id}-url`}
                placeholder="https://example.com/v1"
                value={url}
                {...invalid}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Line>
            <Field orientation="horizontal" className="grid grid-cols-[6rem_1fr]">
              <FieldTitle>API</FieldTitle>
              <Segmented label="API" value={dialect} onChange={setDialect} options={dialects} />
            </Field>
            <Line label="Models" htmlFor={`${id}-models`}>
              <Input
                id={`${id}-models`}
                placeholder="Models it serves, as patterns (any if empty)"
                value={models}
                onChange={(e) => setModels(e.currentTarget.value)}
              />
            </Line>
            <Line label="Key" htmlFor={`${id}-key`} invalid={refused !== undefined}>
              <Input
                id={`${id}-key`}
                type="password"
                placeholder="Its API key"
                value={key}
                {...invalid}
                onChange={(e) => setKey(e.currentTarget.value)}
              />
            </Line>
            <Line label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </Line>
            <Field orientation="horizontal" className="justify-end">
              {refused !== undefined && (
                <FieldError id={errorId} className="min-w-0 flex-1">
                  {sentenceCase(refused)}
                </FieldError>
              )}
              <Button type="submit" disabled={disabled || busy || url.trim() === ""}>
                {busy ? "Adding…" : "Add endpoint"}
              </Button>
            </Field>
          </form>
        </ItemFooter>
      </Item>
    </div>
  )
}

function AddAccount() {
  const canChange = useAtomValue(canChangeAtom)
  const start = useAtomSet(signIn)
  const importAll = useAtomSet(importLogins, { mode: "promiseExit" })
  const [importing, setImporting] = useState(false)
  const runImport = () => {
    if (importing) return
    setImporting(true)
    void importAll().then(() => setImporting(false))
  }
  return (
    <Section title="Add an account">
      <Panel>
        <SettingRow
          title="Sign in"
          detail="With your browser, as the agent's own sign-in does. SuperGrok signs in with a code."
        >
          <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "claude" })}>
            Claude
          </Button>
          <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "codex" })}>
            ChatGPT
          </Button>
          <Button disabled={!canChange} variant="ghost" onClick={() => start({ provider: "codex", device: true })}>
            ChatGPT with a code
          </Button>
          <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "grok", device: true })}>
            SuperGrok
          </Button>
        </SettingRow>
        <SettingRow
          title="Import"
          detail="Logins Claude Code, Codex, or CLIProxyAPI (Claude, ChatGPT, and SuperGrok) already have."
        >
          <Button variant="outline" disabled={!canChange || importing} onClick={runImport}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </SettingRow>
        <KeyRow disabled={!canChange} />
        <EndpointRow disabled={!canChange} />
      </Panel>
    </Section>
  )
}

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
    <Section title="Client keys">
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
            <Field orientation="horizontal">
              <Input
                aria-label="Name, such as laptop"
                placeholder="Name, such as laptop"
                className="w-50 shrink-0"
                value={name}
                aria-invalid={refused !== undefined || undefined}
                aria-describedby={refused === undefined ? undefined : errorId}
                onChange={(e) => {
                  setName(e.currentTarget.value)
                  setRefused(undefined)
                }}
              />
              <Input
                aria-label="Models it may use, as patterns (any if empty)"
                placeholder="Models it may use, as patterns (any if empty)"
                value={models}
                onChange={(e) => setModels(e.currentTarget.value)}
              />
              <Button type="submit" disabled={!canChange || busy || name.trim() === ""}>
                {busy ? "Creating…" : "Create key"}
              </Button>
            </Field>
            {refused !== undefined && <FieldError id={errorId}>{sentenceCase(refused)}</FieldError>}
          </form>
        </Panel>
        <p className="text-xs text-muted-foreground">
          A tool presents its key as an API key. Revoking one refuses it at once; slopmax's own key, in config.json,
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
    <span className="flex min-w-0 items-center gap-1">
      <code className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs select-all">{text}</code>
      <Tip content={label}>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => copyText({ text })}>
          <Copy />
        </Button>
      </Tip>
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

export function AccessPage() {
  return (
    <>
      <p className="max-w-prose text-muted-foreground">
        The accounts slopmax sends requests to, and the keys other machines and tools reach it with.
      </p>
      <AddAccount />
      <ClientKeys />
      <OtherMachines />
    </>
  )
}
