// A segmented control: a row of choices, one raised. Each choice is a radio
// button, so assistive tools read it as one choice among several.
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"

export interface SegmentedProps<T extends string> {
  readonly label: string
  readonly value: T
  readonly options: ReadonlyArray<{ readonly value: T; readonly title: string }>
  readonly onChange: (value: T) => void
  readonly disabled?: boolean
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: SegmentedProps<T>) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        const found = options.find((option) => option.value === next)
        if (found !== undefined) onChange(found.value)
      }}
      className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg border bg-well p-0.5"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-label={option.title}
          className="inline-flex h-full cursor-default items-center rounded-sm border border-transparent px-2.5 text-small font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:border-border data-checked:bg-raised data-checked:text-foreground data-checked:shadow-raised"
        >
          {option.title}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
