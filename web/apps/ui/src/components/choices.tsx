// Described choices on shadcn RadioGroup and Item rows. The selected radio
// can be a draft, with tags for the currently applied choice and the default.
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
    readonly tags?: ReadonlyArray<"current" | "default">
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
      {options.map((option) => {
        const optionId = `${id}-${option.value}`
        const describedBy = [...(option.tags ?? []), "detail"].map((part) => `${optionId}-${part}`).join(" ")
        return (
          <div key={option.value} className="border-t first:border-t-0">
            <Item variant="choice" size="row" render={<label htmlFor={optionId} />}>
              <ItemContent>
                <ItemTitle>
                  {option.title}
                  {option.tags?.map((tag) => (
                    <Badge key={tag} id={`${optionId}-${tag}`} variant={tag === "current" ? "outline" : "secondary"}>
                      {tag}
                    </Badge>
                  ))}
                </ItemTitle>
                <ItemDescription id={`${optionId}-detail`}>{option.detail}</ItemDescription>
              </ItemContent>
              <RadioGroupItem
                value={option.value}
                id={optionId}
                aria-label={option.title}
                aria-describedby={describedBy}
              />
            </Item>
          </div>
        )
      })}
    </RadioGroup>
  )
}
