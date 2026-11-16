// A small filter: one choice of a few, or "any". shadcn/ui's Select, small,
// with "any" first and the choices after a separator.
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx"

const any = "\u0000any"

export interface PickProps {
  readonly label: string
  /** What "any" reads as: `Any account`. */
  readonly anyTitle: string
  readonly value: string | undefined
  readonly options: ReadonlyArray<{ readonly value: string; readonly title: string }>
  readonly onChange: (value: string | undefined) => void
}

export function Pick({ label, anyTitle, value, options, onChange }: PickProps) {
  const items = [{ value: any, label: anyTitle }, ...options.map((o) => ({ value: o.value, label: o.title }))]
  return (
    <Select
      items={items}
      value={value ?? any}
      onValueChange={(next: unknown) => onChange(typeof next !== "string" || next === any ? undefined : next)}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={any}>{anyTitle}</SelectItem>
        </SelectGroup>
        {options.length > 0 && <SelectSeparator />}
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.title}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
