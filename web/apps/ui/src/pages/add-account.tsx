// Upstream credentials: subscriptions, imported logins, keys, and compatible endpoints.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Dialect, providerFacts } from "@slopmax/client"
import { Exit } from "effect"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import { addAccount, canChangeAtom, importLogins, signIn } from "../atoms.ts"
import { ModelPatternHelp } from "../components/model-pattern-help.tsx"
import { Panel, Section, SettingRow } from "../components/parts.tsx"
import { ProviderMark } from "../components/provider-mark.tsx"
import { Segmented } from "../components/segmented.tsx"
import { Button } from "../components/ui/button.tsx"
import { Field, FieldError, FieldLabel, FieldTitle } from "../components/ui/field.tsx"
import { Input } from "../components/ui/input.tsx"
import { Item, ItemContent, ItemDescription, ItemFooter, ItemTitle } from "../components/ui/item.tsx"
import type { MeteredProvider } from "../view/pages.ts"
import { failureText, patterns, sentenceCase } from "../view/words.ts"

type KeyProvider = Exclude<MeteredProvider, "compat">
const keyProviders: ReadonlyArray<KeyProvider> = ["anthropic", "openai", "xai"]

const dialects: ReadonlyArray<{
  readonly value: Dialect
  readonly title: string
}> = [
  { value: "chat", title: "Chat completions" },
  { value: "responses", title: "Responses" },
  { value: "messages", title: "Messages" },
]

function KeyRow({ disabled, fixedProvider }: { readonly disabled: boolean; readonly fixedProvider?: KeyProvider }) {
  const add = useAtomSet(addAccount, { mode: "promiseExit" })
  const [choice, setChoice] = useState<KeyProvider>("anthropic")
  const provider = fixedProvider ?? choice
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
      <Item size="row">
        <ItemContent className="min-w-56">
          <ItemTitle>API key</ItemTitle>
          {refused === undefined ? (
            <ItemDescription>A key bills by the token; slopmax spends subscriptions first.</ItemDescription>
          ) : (
            <FieldError id={errorId}>{sentenceCase(refused)}</FieldError>
          )}
        </ItemContent>
        <ItemFooter>
          <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2">
            {fixedProvider === undefined && (
              <Segmented
                label="Provider"
                value={choice}
                onChange={setChoice}
                options={keyProviders.map((id) => ({
                  value: id,
                  title: providerFacts[id].title,
                }))}
              />
            )}
            <Input
              type="password"
              aria-label="Paste an API key"
              placeholder="Paste an API key"
              className="min-w-40 flex-1"
              value={key}
              aria-invalid={refused !== undefined || undefined}
              aria-describedby={refused === undefined ? undefined : errorId}
              onChange={(event) => setKey(event.currentTarget.value)}
            />
            <Button type="submit" disabled={disabled || busy || key.trim() === ""}>
              {busy ? "Checking key…" : "Add key"}
            </Button>
          </form>
        </ItemFooter>
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
    <Field
      orientation="horizontal"
      data-invalid={invalid || undefined}
      className="grid grid-cols-1 @md:grid-cols-[6rem_minmax(0,1fr)]"
    >
      <FieldLabel htmlFor={htmlFor} className="@md:min-h-9 @md:self-start">
        {label}
      </FieldLabel>
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
      <Item size="row">
        <ItemContent>
          <ItemTitle>Compatible endpoint</ItemTitle>
          <ItemDescription>
            An API that speaks OpenAI's or Anthropic's format, such as a local model server or a gateway. Its key is
            checked before it is saved.
          </ItemDescription>
        </ItemContent>
        <ItemFooter>
          <form onSubmit={submit} className="flex w-full flex-col gap-2">
            <Line label="Address" htmlFor={`${id}-url`} invalid={refused !== undefined}>
              <Input
                id={`${id}-url`}
                placeholder="https://example.com/v1"
                value={url}
                {...invalid}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Line>
            <Field orientation="horizontal" className="grid grid-cols-1 @md:grid-cols-[6rem_minmax(0,1fr)]">
              <FieldTitle>API</FieldTitle>
              <Segmented label="API" value={dialect} onChange={setDialect} options={dialects} />
            </Field>
            <Line label="Models" htmlFor={`${id}-models`}>
              <div className="flex min-w-0 flex-col gap-1">
                <Input
                  id={`${id}-models`}
                  aria-describedby={`${id}-models-help`}
                  placeholder="Any model"
                  value={models}
                  onChange={(e) => setModels(e.currentTarget.value)}
                />
                <ModelPatternHelp id={`${id}-models-help`} />
              </div>
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

export function AddAccountPage({ provider }: { readonly provider?: MeteredProvider | undefined }) {
  const canChange = useAtomValue(canChangeAtom)
  const start = useAtomSet(signIn)
  const importAll = useAtomSet(importLogins, { mode: "promiseExit" })
  const [importing, setImporting] = useState(false)
  const runImport = () => {
    if (importing) return
    setImporting(true)
    void importAll().then(() => setImporting(false))
  }
  if (provider !== undefined) {
    return (
      <Section title={provider === "compat" ? "Endpoint" : "Credentials"} layout="split">
        <Panel>
          {provider === "compat" ? (
            <EndpointRow disabled={!canChange} />
          ) : (
            <KeyRow key={provider} fixedProvider={provider} disabled={!canChange} />
          )}
        </Panel>
      </Section>
    )
  }
  return (
    <>
      <Section title="Subscriptions" layout="split">
        <Panel>
          <SettingRow
            title="Sign in"
            detail="With your browser, as the agent's own sign-in does. Grok signs in with a code."
          >
            <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "claude" })}>
              <ProviderMark provider="claude" />
              Claude
            </Button>
            <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "codex" })}>
              <ProviderMark provider="codex" />
              ChatGPT
            </Button>
            <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "codex", device: true })}>
              <ProviderMark provider="codex" />
              ChatGPT with a code
            </Button>
            <Button variant="outline" disabled={!canChange} onClick={() => start({ provider: "grok", device: true })}>
              <ProviderMark provider="grok" />
              Grok
            </Button>
          </SettingRow>
          <SettingRow title="Import" detail="Reuse logins from Claude Code, Codex, or CLIProxyAPI.">
            <Button variant="outline" disabled={!canChange || importing} onClick={runImport}>
              {importing ? "Importing…" : "Import"}
            </Button>
          </SettingRow>
        </Panel>
      </Section>
      <Section title="API keys and endpoints" layout="split">
        <Panel>
          <KeyRow disabled={!canChange} />
          <EndpointRow disabled={!canChange} />
        </Panel>
      </Section>
    </>
  )
}
