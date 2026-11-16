// Asking before doing: one dialog for the whole app, opened with `ask(…)`,
// which resolves to what was typed (`""` for a plain confirmation) or to
// `null` when it was cancelled with Escape, a click outside, or Cancel. The
// field, else the confirming button, takes focus.
import { useAtom, useAtomSet } from "@effect/atom-react"
import { Option } from "effect"
import { Atom } from "effect/reactivity"
import { type FormEvent, useId, useState } from "react"
import type { Ask } from "../view/asks.ts"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx"
import { Field, FieldError, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"

interface Asking {
  readonly ask: Ask
  readonly resolve: (answer: string | null) => void
}

const askingAtom = Atom.make<Option.Option<Asking>>(Option.none()).pipe(Atom.keepAlive)

/** Asks a question in the app's dialog; resolves to the answer, or `null` when cancelled. */
export const useAsk = (): ((ask: Ask) => Promise<string | null>) => {
  const set = useAtomSet(askingAtom)
  return (ask) =>
    new Promise((resolve) => {
      set(Option.some({ ask, resolve }))
    })
}

function AskForm({ asking, close }: { readonly asking: Asking; readonly close: (answer: string | null) => void }) {
  const { ask } = asking
  const [value, setValue] = useState(ask.field?.value ?? "")
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const fieldId = useId()
  const errorId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const why = ask.field?.check?.(value)
    if (why !== undefined) return setRefused(why)
    close(ask.field === undefined ? "" : value)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{ask.title}</DialogTitle>
        <DialogDescription>{ask.body}</DialogDescription>
      </DialogHeader>
      {ask.facts !== undefined && ask.facts.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2.5 text-sm">
          {ask.facts.map((fact, i) => (
            <li key={fact} className={i === 0 ? "font-medium" : "text-muted-foreground tabular-nums"}>
              {fact}
            </li>
          ))}
        </ul>
      )}
      {ask.field !== undefined && (
        <Field data-invalid={refused !== undefined || undefined}>
          <FieldLabel htmlFor={fieldId}>{ask.field.label}</FieldLabel>
          <Input
            id={fieldId}
            autoFocus
            aria-label={ask.field.label}
            value={value}
            inputMode={ask.field.kind === "number" ? "numeric" : "text"}
            placeholder={ask.field.placeholder}
            aria-invalid={refused !== undefined || undefined}
            aria-describedby={refused === undefined ? undefined : errorId}
            onChange={(event) => {
              setValue(event.currentTarget.value)
              setRefused(undefined)
            }}
          />
          {refused !== undefined && <FieldError id={errorId}>{refused}</FieldError>}
        </Field>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => close(null)}>
          Cancel
        </Button>
        <Button type="submit" variant={ask.danger ? "destructive" : "default"} autoFocus={ask.field === undefined}>
          {ask.confirm}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Where the app's dialog appears; mounted once. */
export function AskHost() {
  const [asking, setAsking] = useAtom(askingAtom)
  const close = (answer: string | null) => {
    if (Option.isSome(asking)) asking.value.resolve(answer)
    setAsking(Option.none())
  }
  return (
    <Dialog
      open={Option.isSome(asking)}
      onOpenChange={(open) => {
        if (!open) close(null)
      }}
    >
      <DialogContent showCloseButton={false}>
        {Option.isSome(asking) && <AskForm key={asking.value.ask.title} asking={asking.value} close={close} />}
      </DialogContent>
    </Dialog>
  )
}
