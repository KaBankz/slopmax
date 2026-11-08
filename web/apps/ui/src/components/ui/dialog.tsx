// A modal over a scrim: Escape, a click on the scrim, or Cancel closes it.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import type { ReactNode } from "react"

export interface DialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly children: ReactNode
}

export function Dialog({ open, onOpenChange, title, children }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 flex w-96 max-w-full -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl bg-popover p-5 text-body shadow-popover outline-none">
          <DialogPrimitive.Title className="text-heading font-semibold">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** What the dialog asks about, under its title. */
export function DialogDescription({ children }: { readonly children: ReactNode }) {
  return (
    <DialogPrimitive.Description className="text-body text-muted-foreground">{children}</DialogPrimitive.Description>
  )
}
