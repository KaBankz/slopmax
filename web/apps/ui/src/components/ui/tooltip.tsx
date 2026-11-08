// Tooltips: shown at once, no motion, small and inverted.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"

export const TooltipProvider = TooltipPrimitive.Provider

export interface TipProps {
  readonly content: ReactNode
  readonly children: ReactElement
  readonly side?: "top" | "bottom" | "left" | "right"
}

/** Wraps a control with a tooltip; the control is rendered as the trigger. */
export function Tip({ content, children, side = "top" }: TipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className="max-w-xs rounded-md bg-primary px-2 py-1 text-small whitespace-pre-line text-primary-foreground">
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
