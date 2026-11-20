// The toasts at the bottom right, through shadcn/ui's Sonner: what the app
// just did, or why it could not. The toasts atom stays the record of what
// shows; this hands each new one to Sonner and takes back each that closes.
// A failure stays until dismissed.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Duration } from "effect"
import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { dismissToast, prefsAtom, toastsAtom } from "../atoms.ts"
import { toastLife, toastLimit } from "../view/toasts.ts"
import { Toaster } from "./ui/sonner.tsx"

export function Toasts() {
  const toasts = useAtomValue(toastsAtom)
  const prefs = useAtomValue(prefsAtom)
  const dismiss = useAtomSet(dismissToast)
  const shown = useRef(new Set<number>())
  useEffect(() => {
    const live = new Set(toasts.map((item) => item.id))
    for (const item of toasts) {
      if (shown.current.has(item.id)) continue
      shown.current.add(item.id)
      const options = {
        id: item.id,
        duration: item.error ? Number.POSITIVE_INFINITY : Duration.toMillis(toastLife),
        onDismiss: () => dismiss(item.id),
        onAutoClose: () => dismiss(item.id),
      }
      if (item.error) toast.error(item.text, options)
      else toast.success(item.text, options)
    }
    for (const id of shown.current) {
      if (live.has(id)) continue
      toast.dismiss(id)
      shown.current.delete(id)
    }
  }, [toasts, dismiss])
  return (
    <Toaster
      theme={prefs.appearance}
      position="bottom-right"
      offset={{ bottom: "calc(1.5rem + var(--dashboard-dock, 0px))" }}
      mobileOffset={{ bottom: "calc(1rem + var(--dashboard-dock, 0px))" }}
      closeButton
      visibleToasts={toastLimit}
    />
  )
}
