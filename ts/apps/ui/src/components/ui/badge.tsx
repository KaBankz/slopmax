// A small bordered tag: `Next`, `Pinned`, a count.
import { cva, type VariantProps } from "class-variance-authority"
import type { ReactNode } from "react"

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-caption whitespace-nowrap",
  {
    variants: {
      tone: {
        muted: "border-border text-muted-foreground",
        brand: "border-brand text-brand",
        good: "border-success text-success",
        warn: "border-warning text-warning",
        bad: "border-danger text-danger",
      },
    },
    defaultVariants: { tone: "muted" },
  },
)

export function Badge({ tone, children }: VariantProps<typeof badgeVariants> & { readonly children: ReactNode }) {
  return <span className={badgeVariants({ tone })}>{children}</span>
}
