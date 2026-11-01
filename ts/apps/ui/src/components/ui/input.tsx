// A text field: 28 tall, body size.
import { Input as InputPrimitive } from "@base-ui/react/input"
import type { ComponentProps } from "react"
import { cn } from "../../lib/cn.ts"

export function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-body text-foreground outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  )
}
