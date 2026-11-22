// A stepper over fixed steps: decrease, the current value, increase. shadcn/ui's ButtonGroup
// of two outline buttons around the value; a button with nowhere to go is disabled.
import { Minus, Plus } from "lucide-react"
import { useId } from "react"
import { Button } from "./ui/button.tsx"
import { ButtonGroup, ButtonGroupText } from "./ui/button-group.tsx"

export interface StepperProps {
  readonly title: string
  readonly value: string
  readonly onLess: (() => void) | undefined
  readonly onMore: (() => void) | undefined
}

export function Stepper({ title, value, onLess, onMore }: StepperProps) {
  const valueId = useId()
  return (
    <ButtonGroup aria-label={title}>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Decrease ${title}`}
        aria-describedby={valueId}
        disabled={onLess === undefined}
        onClick={onLess}
      >
        <Minus />
      </Button>
      <ButtonGroupText className="min-w-20 justify-center" id={valueId}>
        <span className="sr-only">Current value </span>
        <span className="tabular-nums">{value}</span>
      </ButtonGroupText>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Increase ${title}`}
        aria-describedby={valueId}
        disabled={onMore === undefined}
        onClick={onMore}
      >
        <Plus />
      </Button>
    </ButtonGroup>
  )
}
