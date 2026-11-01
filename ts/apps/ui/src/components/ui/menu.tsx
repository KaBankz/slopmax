// A dropdown menu, opened from a trigger. No motion: it is there at once.
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import type { ReactElement, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn.ts"

export interface MenuProps {
  readonly trigger: ReactElement
  readonly children: ReactNode
  readonly align?: "start" | "end"
  readonly onOpenChange?: (open: boolean) => void
}

export function Menu({ trigger, children, align = "end", onOpenChange }: MenuProps) {
  return (
    <MenuPrimitive.Root
      {...(onOpenChange === undefined ? {} : { onOpenChange: (open: boolean) => onOpenChange(open) })}
    >
      <MenuPrimitive.Trigger render={trigger} />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner align={align} sideOffset={4} className="z-50 outline-none">
          <MenuPrimitive.Popup className="min-w-56 rounded-xl bg-popover p-1 text-body text-foreground shadow-popover outline-none">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}

const itemVariants = cva(
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-disabled:opacity-45 data-highlighted:bg-selected [&_svg]:size-4 [&_svg]:text-muted-foreground",
  { variants: { tone: { default: "", danger: "text-danger" } }, defaultVariants: { tone: "default" } },
)

export function MenuItem({ className, tone, ...props }: MenuPrimitive.Item.Props & VariantProps<typeof itemVariants>) {
  return <MenuPrimitive.Item className={cn(itemVariants({ tone }), className)} {...props} />
}

export function MenuLabel({ children }: { readonly children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-caption text-muted-foreground">{children}</div>
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="mx-1 my-1 h-px bg-separator" />
}
