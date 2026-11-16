// A stepper over fixed steps: Less, the value, More. shadcn/ui's ButtonGroup
// of two outline buttons around the value; a button with nowhere to go is disabled.
import { Minus, Plus } from "lucide-react"
import { Button } from "./ui/button.tsx"
import { ButtonGroup, ButtonGroupText } from "./ui/button-group.tsx"

export interface StepperProps {
  readonly title: string
  readonly value: string
  readonly onLess: (() => void) | undefined
  readonly onMore: (() => void) | undefined
}

export function Stepper({ title, value, onLess, onMore }: StepperProps) {
  return (
    <ButtonGroup>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Less ${title}`}
        disabled={onLess === undefined}
        onClick={onLess}
      >
        <Minus />
      </Button>
      <ButtonGroupText className="min-w-20 justify-center">
        <span className="tabular-nums">{value}</span>
      </ButtonGroupText>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`More ${title}`}
        disabled={onMore === undefined}
        onClick={onMore}
      >
        <Plus />
      </Button>
    </ButtonGroup>
  )
}
