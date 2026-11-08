// The accounts slopmax sends requests to, and the keys other machines and
// tools reach it with: sign in, import logins, add an API key or a
// compatible endpoint, and make or revoke client keys.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Dialect } from "@slopmax/client"
import { providerFacts } from "@slopmax/client"
import { Exit, Option } from "effect"
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
  proxyAtom,
  revokeKey,
  signIn,
} from "../atoms.ts"
import { useAsk } from "../components/ask.tsx"
import { Loaded, Panel, Section, SettingRow, Skeleton } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { Input } from "../components/ui/input.tsx"
import { Segmented } from "../components/ui/segmented.tsx"
import { askRevoke } from "../view/asks.ts"
import { needsProxy } from "../view/live.ts"
import { capitalize, failureText, patterns } from "../view/words.ts"

type KeyProvider = "anthropic" | "openai" | "xai"
const keyProviders: ReadonlyArray<KeyProvider> = ["anthropic", "openai", "xai"]

const dialects: ReadonlyArray<{ readonly value: Dialect; readonly title: string }> = [
  { value: "chat", title: "Chat completions" },
  { value: "responses", title: "Responses" },
  { value: "messages", title: "Messages" },
]

/** Why an add was refused, shown with the form that asked rather than as a toast. */
function Refused({ id, text, className }: { readonly id: string; readonly text: string; readonly className: string }) {
  return (
    <div id={id} role="alert" className={className}>
      {capitalize(text)}
    </div>
  )
}

function KeyRow({ disabled }: { readonly disabled: boolean }) {
  const add = useAtomSet(addAccount, { mode: "promiseExit" })
  const [provider, setProvider] = useState<KeyProvider>("anthropic")
  const [key, setKey] = useState("")
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const errorId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "") return
    setRefused(undefined)
    void add({ _tag: "Key", provider, key: key.trim() }).then((exit) => {
      if (Exit.isSuccess(exit)) setKey("")
      else setRefused(failureText(exit.cause))
    })
  }
  return (
    <SettingRow
      title="API key"
      detail={
        refused === undefined ? (
          "A key bills by the token; slopmax spends subscriptions first."
        ) : (
          <Refused id={errorId} text={refused} className="text-danger" />
        )
      }
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <Segmented
          label="Provider"
          value={provider}
          onChange={setProvider}
          options={keyProviders.map((id) => ({ value: id, title: providerFacts[id].title }))}
        />
        <span className="w-56">
          <Input
            type="password"
            aria-label="Paste an API key"
            placeholder="Paste an API key"
            value={key}
            aria-invalid={refused !== undefined || undefined}
            aria-describedby={refused === undefined ? undefined : errorId}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
        </span>
        <Button type="submit" variant="primary" disabled={disabled || key.trim() === ""}>
          Add key
        </Button>
      </form>
    </SettingRow>
  )
}

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-small text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

function EndpointRow({ disabled }: { readonly disabled: boolean }) {
  const add = useAtomSet(addAccount, { mode: "promiseExit" })
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const errorId = useId()
  const invalid = {
    "aria-invalid": refused !== undefined || undefined,
    "aria-describedby": refused === undefined ? undefined : errorId,
  }
  const [url, setUrl] = useState("")
  const [dialect, setDialect] = useState<Dialect>("chat")
  const [models, setModels] = useState("")
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (url.trim() === "") return
    setRefused(undefined)
    void add({
      _tag: "Endpoint",
      url: url.trim().replace(/\/+$/, ""),
      dialect,
      models: patterns(models),
      ...(key.trim() === "" ? {} : { key: key.trim() }),
      ...(name.trim() === "" ? {} : { label: name.trim() }),
    }).then((exit) => {
      if (Exit.isFailure(exit)) return setRefused(failureText(exit.cause))
      setUrl("")
      setModels("")
      setKey("")
      setName("")
    })
  }
  return (
    <div className="flex flex-col gap-3 border-t border-separator px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">Compatible endpoint</span>
        <span className="text-small text-muted-foreground">
          An API that speaks OpenAI's or Anthropic's format, such as a local model server or a gateway. Its key is
          checked before it is saved.
        </span>
      </div>
      <form onSubmit={submit} className="flex max-w-page flex-col gap-2">
        <Line label="Address">
          <Input
            placeholder="https://example.com/v1"
            value={url}
            {...invalid}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
        </Line>
        <div className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-small text-muted-foreground">API</span>
          <Segmented label="API" value={dialect} onChange={setDialect} options={dialects} />
        </div>
        <Line label="Models">
          <Input
            placeholder="Models it serves, as patterns (any if empty)"
            value={models}
            onChange={(e) => setModels(e.currentTarget.value)}
          />
        </Line>
        <Line label="Key">
          <Input
            type="password"
            placeholder="Its API key"
            value={key}
            {...invalid}
            onChange={(e) => setKey(e.currentTarget.value)}
          />
        </Line>
        <Line label="Name">
          <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </Line>
        <div className="flex items-center justify-end gap-3">
          {refused !== undefined && (
            <Refused id={errorId} text={refused} className="min-w-0 flex-1 text-small text-danger" />
          )}
          <Button type="submit" variant="primary" disabled={disabled || url.trim() === ""}>
            Add endpoint
          </Button>
        </div>
      </form>
    </div>
  )
}

function AddAccount() {
  const canChange = useAtomValue(canChangeAtom)
  const start = useAtomSet(signIn)
  const importAll = useAtomSet(importLogins)
  return (
    <Section title="Add an account">
      <Panel>
        <SettingRow title="Sign in" detail="With your browser, as the agent's own sign-in does.">
          <Button disabled={!canChange} onClick={() => start({ provider: "claude" })}>
            Claude
          </Button>
          <Button disabled={!canChange} onClick={() => start({ provider: "codex" })}>
            ChatGPT
          </Button>
          <Button disabled={!canChange} variant="ghost" onClick={() => start({ provider: "codex", device: true })}>
            ChatGPT with a code
          </Button>
        </SettingRow>
        <SettingRow title="Import" detail="Logins Claude Code, Codex, or CLIProxyAPI already have.">
          <Button disabled={!canChange} onClick={() => importAll()}>
            Import
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
    <div className="flex animate-appear flex-col gap-2.5 border-b border-separator bg-well px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">The key {made.name}</span>
        <span className="text-small text-muted-foreground">
          Copy it now: you won't see it again. Give it to the tool as its API key, with slopmax's address.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2.5 py-1.5 font-mono text-small select-all">
          {made.key}
        </code>
        <Button variant="primary" onClick={() => copyText({ text: made.key })}>
          Copy
        </Button>
        <Button onClick={() => done()}>Done</Button>
      </div>
    </div>
  )
}

function ClientKeys() {
  const keys = useAtomValue(keysAtom)
  const canChange = useAtomValue(canChangeAtom)
  const waiting = needsProxy(useAtomValue(proxyAtom), "list and make keys")
  const make = useAtomSet(makeKey)
  const revoke = useAtomSet(revokeKey)
  const ask = useAsk()
  const [name, setName] = useState("")
  const [models, setModels] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === "") return
    make({ name, models: patterns(models) })
    setName("")
    setModels("")
  }
  return (
    <Section title="Client keys">
      <div className="flex flex-col gap-2">
        <Panel>
          <NewKeyWell />
          {!canChange ? (
            waiting === undefined ? (
              <Skeleton lines={2} />
            ) : (
              <div className="px-4 py-3.5 text-small text-muted-foreground">{waiting}.</div>
            )
          ) : (
            <Loaded result={keys} title="Could not read the keys" loading={<Skeleton lines={2} />}>
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
                          <span className="font-mono text-caption">{key.models.join(", ")}</span>
                        )
                      }
                    >
                      <Button
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
                  {list.length === 0 && (
                    <div className="px-4 py-3.5 text-small text-muted-foreground">
                      No client keys yet. Agents on this machine use slopmax's own key.
                    </div>
                  )}
                </>
              )}
            </Loaded>
          )}
          <form onSubmit={submit} className="flex items-center gap-2 border-t border-separator px-4 py-3">
            <span className="w-50 shrink-0">
              <Input
                aria-label="Name, such as laptop"
                placeholder="Name, such as laptop"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </span>
            <Input
              aria-label="Models it may use, as patterns (any if empty)"
              placeholder="Models it may use, as patterns (any if empty)"
              value={models}
              onChange={(e) => setModels(e.currentTarget.value)}
            />
            <Button type="submit" variant="primary" disabled={!canChange || name.trim() === ""}>
              Create key
            </Button>
          </form>
        </Panel>
        <p className="text-caption text-faint">
          A tool presents its key as an API key. Revoking one refuses it at once; slopmax's own key, in config.json,
          stays as it is.
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
    </>
  )
}
