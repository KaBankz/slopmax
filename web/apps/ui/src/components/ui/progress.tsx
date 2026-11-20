// Slopmax's shadcn Progress supports status colors, an even-pace marker,
// and a patterned gauge for the next account reset.
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const indicatorVariants = cva("h-full", {
  variants: {
    tone: {
      default: "bg-primary",
      quota: "quota-indicator bg-quota-fill",
      warning: "bg-warning",
      destructive: "bg-destructive",
    },
  },
  defaultVariants: { tone: "default" },
})

function Progress({
  className,
  children,
  value,
  tone,
  marker,
  ...props
}: ProgressPrimitive.Root.Props &
  VariantProps<typeof indicatorVariants> & {
    /** Where the tick sits, 0 to 100. */
    marker?: number | undefined
  }) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("relative flex flex-wrap gap-3", className)}
      data-tone={tone}
      style={marker === undefined ? undefined : { "--marker": `${Math.min(100, Math.max(0, marker))}%` }}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator className={indicatorVariants({ tone })} />
      </ProgressTrack>
      {marker !== undefined && (
        <div
          aria-hidden
          data-slot="progress-marker"
          className="absolute -bottom-1 left-(--marker) h-3 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground in-data-[tone=quota]:h-7 in-data-[tone=quota]:bg-quota-foreground in-data-[tone=quota]:ring-1 in-data-[tone=quota]:ring-quota"
        />
      )}
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted in-data-[tone=quota]:h-5 in-data-[tone=quota]:rounded-sm in-data-[tone=quota]:bg-quota-track",
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full bg-primary motion-safe:transition-[width]", className)}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label className={cn("text-sm font-medium", className)} data-slot="progress-label" {...props} />
  )
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn("ml-auto text-sm text-muted-foreground tabular-nums", className)}
      data-slot="progress-value"
      {...props}
    />
  )
}

export { Progress, ProgressTrack, ProgressIndicator, ProgressLabel, ProgressValue }
