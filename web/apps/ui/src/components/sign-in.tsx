// The card above every page while a sign-in is under way: what to do next,
// the address or code, and a field for what a browser on another machine
// ended on: the address, or the code the provider's page shows. A Card.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { Copy, ExternalLink } from "lucide-react"
import { type FormEvent, useState } from "react"
import { cancelSignIn, copy, openExternal, pasteAddress, signInAtom } from "../atoms.ts"
import { signInView } from "../view/live.ts"
import { Dot } from "./parts.tsx"
import { Button } from "./ui/button.tsx"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx"
import { Input } from "./ui/input.tsx"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group.tsx"

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
    <Card aria-label={view.title}>
      <CardHeader>
        <CardTitle>{view.title}</CardTitle>
        <CardDescription>{view.detail}</CardDescription>
        <CardAction>
          <Button variant="outline" onClick={() => cancel()}>
            Cancel
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {view.code !== undefined && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3">
              <span className="text-2xl font-semibold tracking-widest tabular-nums">{view.code}</span>
              <span className="flex items-center gap-2">
                {view.codePage !== undefined && (
                  <Button variant="outline" size="sm" onClick={() => open(view.codePage ?? "")}>
                    <ExternalLink />
                    Open the page
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => copyText({ text: view.code ?? "" })}>
                  <Copy />
                  Copy code
                </Button>
              </span>
            </div>
          )}
          {view.link !== undefined && (
            <>
              <InputGroup>
                <InputGroupInput readOnly aria-label="Sign-in address" value={view.link} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={() => open(view.link ?? "")}>
                    <ExternalLink />
                    Open again
                  </InputGroupButton>
                  <InputGroupButton onClick={() => copyText({ text: view.link ?? "" })}>
                    <Copy />
                    Copy link
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {view.paste !== undefined && (
                <form onSubmit={submit} className="flex items-center gap-2">
                  <Input
                    aria-label={view.paste.hint}
                    placeholder={view.paste.hint}
                    value={address}
                    onChange={(event) => setAddress(event.currentTarget.value)}
                  />
                  <Button type="submit" disabled={address.trim() === ""}>
                    {view.paste.action}
                  </Button>
                </form>
              )}
            </>
          )}
          {view.notes !== "" && (
            <div className="flex items-start gap-2 text-sm text-warning">
              <span className="flex h-5 items-center">
                <Dot tone="warn" />
              </span>
              <span className="whitespace-pre-line">{view.notes}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
