// Buttons: 28 tall, quiet (a hairline) unless primary, which is inverted.
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn.ts"

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md border text-body font-medium whitespace-nowrap select-none outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground hover:bg-hover active:bg-selected",
        primary: "border-primary bg-primary text-primary-foreground hover:opacity-90 active:opacity-80",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground active:bg-selected",
        danger: "border-danger bg-danger text-primary-foreground hover:opacity-90 active:opacity-80",
        link: "h-auto border-transparent px-0 text-muted-foreground hover:text-foreground",
      },
      size: {
        default: "h-7 px-3",
        sm: "h-6 rounded-sm px-2 text-small",
        icon: "size-7",
        "icon-sm": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
