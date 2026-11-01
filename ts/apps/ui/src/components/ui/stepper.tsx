// A stepper over fixed steps: Less, the value, More. A button with nowhere
// to go is faint and does nothing.
import { Minus, Plus } from "lucide-react"
import { Button } from "@base-ui/react/button"

export interface StepperProps {
  readonly title: string
  readonly value: string
  readonly onLess: (() => void) | undefined
  readonly onMore: (() => void) | undefined
}

const stepButton =
  "inline-flex size-6 cursor-default items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-faint disabled:opacity-60"

export function Stepper({ title, value, onLess, onMore }: StepperProps) {
  return (
    <div className="inline-flex h-7 shrink-0 items-center rounded-lg border bg-well p-px">
      <Button aria-label={`Less ${title}`} disabled={onLess === undefined} onClick={onLess} className={stepButton}>
        <Minus className="size-3.5" />
      </Button>
      <span className="min-w-16 text-center text-small font-medium tabular">{value}</span>
      <Button aria-label={`More ${title}`} disabled={onMore === undefined} onClick={onMore} className={stepButton}>
        <Plus className="size-3.5" />
      </Button>
    </div>
  )
}
