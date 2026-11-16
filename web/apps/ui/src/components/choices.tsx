// A list of choices, one chosen, each a title over a sentence: shadcn/ui's
// RadioGroup laid out as choice cards (FieldLabel around a Field).
import { useId } from "react"
import { Badge } from "./ui/badge.tsx"
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "./ui/field.tsx"
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
      aria-label={label}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        const found = options.find((option) => option.value === next)
        if (found !== undefined) onChange(found.value)
      }}
    >
      {options.map((option) => (
        <FieldLabel key={option.value} htmlFor={`${id}-${option.value}`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                {option.title}
                {option.tag !== undefined && <Badge variant="secondary">{option.tag}</Badge>}
              </FieldTitle>
              <FieldDescription>{option.detail}</FieldDescription>
            </FieldContent>
            <RadioGroupItem value={option.value} id={`${id}-${option.value}`} aria-label={option.title} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
