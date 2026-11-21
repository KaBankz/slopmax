// A list of choices, one chosen, each a title over a sentence: shadcn/ui's
// RadioGroup laid out as dividing shadcn Item rows.
import { useId } from "react"
import { Badge } from "./ui/badge.tsx"
import { Item, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx"
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx"

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
  const id = useId()
  return (
    <RadioGroup
      layout="rows"
      aria-label={label}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        const found = options.find((option) => option.value === next)
        if (found !== undefined) onChange(found.value)
      }}
    >
      {options.map((option) => (
        <div key={option.value} className="border-t first:border-t-0">
          <Item variant="choice" size="row" render={<label htmlFor={`${id}-${option.value}`} />}>
            <ItemContent>
              <ItemTitle>
                {option.title}
                {option.tag !== undefined && <Badge variant="secondary">{option.tag}</Badge>}
              </ItemTitle>
              <ItemDescription id={`${id}-${option.value}-detail`}>{option.detail}</ItemDescription>
            </ItemContent>
            <RadioGroupItem
              value={option.value}
              id={`${id}-${option.value}`}
              aria-label={option.title}
              aria-describedby={`${id}-${option.value}-detail`}
            />
          </Item>
        </div>
      ))}
    </RadioGroup>
  )
}
