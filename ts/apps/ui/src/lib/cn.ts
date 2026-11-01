// Joins class names and settles conflicts between Tailwind classes, so a
// component's own classes give way to the ones its caller passes. slopmax's
// type scale has its own names (`text-body`, `text-caption`), which the
// merger is told are sizes, so `text-body text-muted-foreground` keeps both.
import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const merge = extendTailwindMerge({
  extend: {
    theme: { text: ["title", "figure", "heading", "body", "small", "caption", "axis"] },
  },
})

export const cn = (...inputs: ReadonlyArray<ClassValue>): string => merge(clsx(inputs))
