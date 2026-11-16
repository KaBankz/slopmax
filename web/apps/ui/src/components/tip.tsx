// A tooltip on one control, in a line: shadcn/ui's Tooltip with the control
// as its trigger. Use the Tooltip parts directly for anything more.
import type { ReactElement, ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export interface TipProps {
  readonly content: ReactNode
  readonly children: ReactElement
  readonly side?: "top" | "bottom" | "left" | "right"
}

export function Tip({ content, children, side = "top" }: TipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="whitespace-pre-line">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
