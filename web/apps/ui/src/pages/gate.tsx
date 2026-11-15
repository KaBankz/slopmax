// The web dashboard without a key: it asks for slopmax's owner key, which
// `slopmax dashboard` puts in the address, checks it with slopmax, and keeps
// it for this tab only.
import { useAtom, useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { type FormEvent, useId, useState } from "react"
import { checkKey, enterKey, keyRefusedAtom, refusedKey } from "../atoms.ts"
import { Logo } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
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
      <form
        onSubmit={submit}
        className="flex w-96 max-w-full animate-appear flex-col gap-4 rounded-2xl border bg-background p-6 shadow-popover"
      >
        <div className="flex items-center gap-3">
          <Logo size="lg" />
          <div className="flex flex-col">
            <h1 className="text-heading font-semibold">Open the slopmax dashboard</h1>
            <p className="text-small text-muted-foreground">
              Run {command} to open it with its key, or paste the owner key from config.json.
            </p>
          </div>
        </div>
        <Input
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
          <p id={errorId} role="alert" className="-mt-2 text-small text-danger">
            slopmax refused that key. Run {command} again, or paste the owner key from config.json.
          </p>
        ) : (
          failed !== undefined && (
            <p id={errorId} role="alert" className="-mt-2 text-small text-danger">
              {sentenceCase(failed)}
            </p>
          )
        )}
        <Button type="submit" variant="primary" disabled={checking || key.trim() === ""}>
          {checking ? "Checking…" : "Open"}
        </Button>
        <p className="text-caption text-faint">The key stays in this tab and is forgotten when it closes.</p>
      </form>
    </main>
  )
}
