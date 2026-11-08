// The toasts at the bottom right: what the app just did, or why it could
// not. They rise in as they arrive; a failure stays until dismissed.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime } from "effect"
import { CircleCheck, CircleX, X } from "lucide-react"
import { dismissToast, nowAtom, toastsAtom } from "../atoms.ts"
import { visibleToasts } from "../view/toasts.ts"
import { Button } from "./ui/button.tsx"

export function Toasts() {
  const toasts = useAtomValue(toastsAtom)
  const now = DateTime.toEpochMillis(useAtomValue(nowAtom))
  const dismiss = useAtomSet(dismissToast)
  const shown = visibleToasts(toasts, now)
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-5 bottom-5 z-40 flex w-100 max-w-full flex-col items-stretch gap-2"
    >
      {shown.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-xl border bg-popover py-2.5 pr-2.5 pl-3.5 shadow-popover"
        >
          {toast.error ? (
            <CircleX aria-hidden className="mt-px size-4 shrink-0 text-danger" />
          ) : (
            <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-success" />
          )}
          <span className="min-w-0 flex-1 text-body break-words">{toast.text}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <X />
          </Button>
        </div>
      ))}
    </div>
  )
}
