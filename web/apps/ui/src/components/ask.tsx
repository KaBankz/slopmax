// Asking before doing: one dialog for the whole app, opened with `ask(…)`,
// which resolves to what was typed (`""` for a plain confirmation) or to
// `null` when it was cancelled with Escape, a click outside, or Cancel. The
// field, else the confirming button, takes focus.
import { useAtom, useAtomSet } from "@effect/atom-react"
import { Option } from "effect"
import { Atom } from "effect/reactivity"
import { type FormEvent, useState } from "react"
import type { Ask } from "../view/asks.ts"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogDescription } from "./ui/dialog.tsx"
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
  const submit = (event: FormEvent) => {
    event.preventDefault()
    close(ask.field === undefined ? "" : value)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogDescription>{ask.body}</DialogDescription>
      {ask.facts !== undefined && ask.facts.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg bg-well px-3 py-2.5 text-small">
          {ask.facts.map((fact, i) => (
            <li key={fact} className={i === 0 ? "font-medium text-foreground" : "text-muted-foreground tabular"}>
              {fact}
            </li>
          ))}
        </ul>
      )}
      {ask.field !== undefined && (
        <label className="flex flex-col gap-1.5 text-small text-muted-foreground">
          {ask.field.label}
          <Input
            autoFocus
            value={value}
            inputMode={ask.field.kind === "number" ? "numeric" : "text"}
            placeholder={ask.field.placeholder}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={() => close(null)}>
          Cancel
        </Button>
        <Button type="submit" variant={ask.danger ? "danger" : "primary"} autoFocus={ask.field === undefined}>
          {ask.confirm}
        </Button>
      </div>
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
      title={Option.match(asking, { onNone: () => "", onSome: (a) => a.ask.title })}
    >
      {Option.isSome(asking) && <AskForm key={asking.value.ask.title} asking={asking.value} close={close} />}
    </Dialog>
  )
}
