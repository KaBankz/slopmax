// Starts the app in whichever host it finds itself: the web dashboard (the
// key arrives once in the address, `#key=…`, and is moved into this tab's
// storage at once) or the desktop window (its main process holds the key).
import { Effect, Option } from "effect"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { hostAtom, ownerKeyAtom } from "./api.ts"
import { Root, takeKeyFromAddress } from "./app.tsx"
import { prefsAtom } from "./atoms.ts"
import { detectHost } from "./host.ts"

const host = detectHost()

if (host.kind === "web") {
  const key = takeKeyFromAddress()
  if (key !== undefined) Effect.runSync(host.saveKey(key))
}

const [key, prefs] = await Promise.all([Effect.runPromise(host.key), Effect.runPromise(host.prefs)])

const element = document.getElementById("root")
if (element !== null) {
  createRoot(element).render(
    <StrictMode>
      <Root
        initialValues={[
          [hostAtom, Option.some(host)],
          [ownerKeyAtom, key],
          [prefsAtom, prefs],
        ]}
      />
    </StrictMode>,
  )
}
