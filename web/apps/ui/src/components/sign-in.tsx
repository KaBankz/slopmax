// The card above every page while a sign-in is under way: what to do next,
// the address or code, and a field for the address a browser on another
// machine ended on.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { Copy, ExternalLink } from "lucide-react"
import { type FormEvent, useState } from "react"
import { cancelSignIn, copy, openExternal, pasteAddress, signInAtom } from "../atoms.ts"
import { signInView } from "../view/live.ts"
import { Dot } from "./parts.tsx"
import { Button } from "./ui/button.tsx"
import { Input } from "./ui/input.tsx"

export function SignInCard() {
  const signIn = useAtomValue(signInAtom)
  const cancel = useAtomSet(cancelSignIn)
  const open = useAtomSet(openExternal)
  const copyText = useAtomSet(copy)
  const paste = useAtomSet(pasteAddress)
  const [address, setAddress] = useState("")
  if (Option.isNone(signIn)) return null
  const view = signInView(signIn.value)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (address.trim() === "") return
    paste(address)
    setAddress("")
  }
  return (
    <section
      aria-label={view.title}
      className="flex animate-appear flex-col gap-3 rounded-xl border bg-background p-4 shadow-raised"
    >
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="font-semibold">{view.title}</div>
          <div className="text-small text-muted-foreground">{view.detail}</div>
        </div>
        <Button onClick={() => cancel()}>Cancel</Button>
      </div>
      {view.code !== undefined && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-well px-4 py-3">
          <span className="text-figure font-semibold tracking-widest tabular">{view.code}</span>
          <span className="flex items-center gap-2">
            {view.codePage !== undefined && (
              <Button size="sm" onClick={() => open(view.codePage ?? "")}>
                <ExternalLink />
                Open the page
              </Button>
            )}
            <Button size="sm" onClick={() => copyText({ text: view.code ?? "" })}>
              <Copy />
              Copy code
            </Button>
          </span>
        </div>
      )}
      {view.link !== undefined && (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md bg-well px-2.5 py-1.5 font-mono text-caption text-muted-foreground">
              {view.link}
            </span>
            <Button size="sm" onClick={() => open(view.link ?? "")}>
              <ExternalLink />
              Open again
            </Button>
            <Button size="sm" onClick={() => copyText({ text: view.link ?? "" })}>
              <Copy />
              Copy link
            </Button>
          </div>
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              aria-label="Browser on another machine? Paste the address it ended on"
              placeholder="Browser on another machine? Paste the address it ended on"
              value={address}
              onChange={(event) => setAddress(event.currentTarget.value)}
            />
            <Button type="submit" disabled={address.trim() === ""}>
              Use address
            </Button>
          </form>
        </>
      )}
      {view.notes !== "" && (
        <div className="flex items-start gap-2 text-small text-warning">
          <span className="flex h-4 items-center">
            <Dot tone="warn" />
          </span>
          <span className="whitespace-pre-line">{view.notes}</span>
        </div>
      )}
    </section>
  )
}
