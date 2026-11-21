// A segmented control: one choice among a few, side by side. shadcn/ui's
// ToggleGroup with one item pressed.
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx"

export interface SegmentedProps<T extends string> {
  readonly label: string
  readonly value: T
  readonly options: ReadonlyArray<{ readonly value: T; readonly title: string; readonly detail?: string }>
  readonly onChange: (value: T) => void
  readonly disabled?: boolean
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      size="sm"
      value={[value]}
      disabled={disabled ?? false}
      onValueChange={(next: ReadonlyArray<unknown>) => {
        const found = options.find((option) => option.value === next[0])
        if (found !== undefined) onChange(found.value)
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.title}
          aria-description={option.detail === undefined ? undefined : `Next reset in ${option.detail}`}
        >
          {option.title}
          {option.detail !== undefined && <span aria-hidden>in {option.detail}</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
