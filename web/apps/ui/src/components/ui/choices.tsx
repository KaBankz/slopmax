// A list of choices, one chosen, each with a title over a sentence: a radio
// group whose rows read as settings rows.
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"

export interface ChoicesProps<T extends string> {
  readonly label: string
  readonly value: T
  readonly options: ReadonlyArray<{
    readonly value: T
    readonly title: string
    readonly detail: string
    /** A word beside the title, such as `default`. */
    readonly tag?: string
  }>
  readonly onChange: (value: T) => void
  readonly disabled?: boolean
}

export function Choices<T extends string>({ label, value, options, onChange, disabled }: ChoicesProps<T>) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        const found = options.find((option) => option.value === next)
        if (found !== undefined) onChange(found.value)
      }}
      className="flex flex-col"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-default items-start gap-3 border-t border-separator px-4 py-3 first:border-t-0 hover:bg-hover has-data-disabled:opacity-45"
        >
          <Radio.Root
            value={option.value}
            aria-label={option.title}
            className="peer mt-px flex size-4 shrink-0 items-center justify-center rounded-full border border-faint outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:border-foreground data-checked:bg-foreground"
          >
            <Radio.Indicator className="size-1.5 rounded-full bg-background" />
          </Radio.Root>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="font-medium">{option.title}</span>
              {option.tag !== undefined && <span className="text-caption text-faint">{option.tag}</span>}
            </span>
            <span className="text-small text-muted-foreground">{option.detail}</span>
          </span>
        </label>
      ))}
    </RadioGroup>
  )
}
