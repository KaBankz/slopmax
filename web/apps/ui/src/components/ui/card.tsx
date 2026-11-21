// Slopmax's shadcn Card uses shared surface spacing. The quota surface
// pairs with the window progress bar, and flush cards group edge-to-edge rows.
import * as React from "react"
import { cn } from "cn"

function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm" | "flush"
  variant?: "default" | "quota"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground border border-border [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)] data-[variant=quota]:bg-quota data-[variant=quota]:text-quota-foreground has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 data-[size=flush]:gap-0 data-[size=flush]:py-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading text-lg leading-snug font-semibold group-data-[size=sm]/card:text-sm", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground group-data-[variant=quota]/card:text-quota-muted", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  )
}

function CardContent({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"div"> & { density?: "default" | "table" }) {
  return (
    <div
      data-slot="card-content"
      data-density={density}
      className={cn(
        "px-(--card-spacing) data-[density=table]:px-2 @sm:data-[density=table]:px-(--card-spacing)",
        className,
      )}
      {...props}
    />
  )
}

function CardFooter({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"div"> & { density?: "default" | "compact" }) {
  return (
    <div
      data-slot="card-footer"
      data-density={density}
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/40 px-(--card-spacing) py-(--card-spacing) data-[density=compact]:py-2.5",
        className,
      )}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
