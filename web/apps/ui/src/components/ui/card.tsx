// Ledger sections share a hairline and open edges. Raised cards contain standalone flows.
import * as React from "react"
import { cn } from "cn"

function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm" | "flush"
  variant?: "default" | "raised"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) border-t bg-card py-(--card-spacing) text-sm text-card-foreground [--card-inset:0px] [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)] data-[variant=raised]:overflow-hidden data-[variant=raised]:rounded-lg data-[variant=raised]:border data-[variant=raised]:shadow-overlay data-[variant=raised]:[--card-inset:var(--card-spacing)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 data-[size=flush]:gap-0 data-[size=flush]:py-0",
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
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-(--card-inset) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
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
  return <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
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

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-(--card-inset)", className)} {...props} />
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
        "flex items-center border-t px-(--card-inset) py-(--card-spacing) data-[density=compact]:py-2.5",
        className,
      )}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
