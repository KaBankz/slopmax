// The web dashboard without a key: it asks for slopmax's owner key, which
// `slopmax dashboard` puts in the address, checks it with slopmax, and keeps
// it for this tab only.
import { useAtom, useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { type FormEvent, useId, useState } from "react"
import { checkKey, enterKey, keyRefusedAtom, refusedKey } from "../atoms.ts"
import { Logo } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.tsx"
import { Field, FieldError, FieldLabel } from "../components/ui/field.tsx"
import { Input } from "../components/ui/input.tsx"
import { failureText, sentenceCase } from "../view/words.ts"

export function Gate() {
  const setKey = useAtomSet(enterKey)
  const check = useAtomSet(checkKey, { mode: "promiseExit" })
  const [refused, setRefused] = useAtom(keyRefusedAtom)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [key, setText] = useState("")
  const errorId = useId()
  const inputId = useId()
  // The key is kept only once slopmax takes it, so a wrong one never opens the dashboard.
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = key.trim()
    if (trimmed === "" || checking) return
    setFailed(undefined)
    setChecking(true)
    void check(trimmed).then((exit) => {
      setChecking(false)
      if (Exit.isSuccess(exit)) setKey(trimmed)
      else if (refusedKey(exit.cause)) setRefused(true)
      else setFailed(failureText(exit.cause))
    })
  }
  const command = <code className="font-mono">slopmax dashboard</code>
  return (
    <main className="flex h-full items-center justify-center bg-sidebar p-6">
      <form onSubmit={submit} className="w-96 max-w-full animate-in fade-in slide-in-from-top-1">
        <Card>
          <CardHeader>
            <Logo size="lg" />
            <CardTitle>
              <h1>Open the slopmax dashboard</h1>
            </CardTitle>
            <CardDescription>
              Run {command} to open it with its key, or paste the owner key from config.toml.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <Field data-invalid={refused || failed !== undefined || undefined}>
                <FieldLabel htmlFor={inputId}>Owner key</FieldLabel>
                <Input
                  id={inputId}
                  autoFocus
                  type="password"
                  aria-label="Owner key"
                  placeholder="sm-…"
                  autoComplete="off"
                  value={key}
                  aria-invalid={refused || undefined}
                  aria-describedby={refused || failed !== undefined ? errorId : undefined}
                  onChange={(event) => {
                    setText(event.currentTarget.value)
                    if (refused) setRefused(false)
                    setFailed(undefined)
                  }}
                />
                {refused ? (
                  <FieldError id={errorId}>
                    slopmax refused that key. Run {command} again, or paste the owner key from config.toml.
                  </FieldError>
                ) : (
                  failed !== undefined && <FieldError id={errorId}>{sentenceCase(failed)}</FieldError>
                )}
              </Field>
              <Button type="submit" disabled={checking || key.trim() === ""} className="w-full">
                {checking ? "Checking…" : "Open"}
              </Button>
            </div>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">The key stays in this tab and is forgotten when it closes.</p>
          </CardFooter>
        </Card>
      </form>
    </main>
  )
}
