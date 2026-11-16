// Starts the web dashboard. The key arrives once in the address, `#key=…`,
// and is moved into this tab's storage at once.
import { Effect, Option } from "effect"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { hostAtom, ownerKeyAtom } from "./api.ts"
import { Root, takeKeyFromAddress } from "./app.tsx"
import { prefsAtom } from "./atoms.ts"
import { webHost } from "./host.ts"

const host = webHost()

const handed = takeKeyFromAddress()
if (handed !== undefined) Effect.runSync(host.saveKey(handed))

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
