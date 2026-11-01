// An on/off switch.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "../../lib/cn.ts"

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-8 shrink-0 cursor-default items-center rounded-full border border-transparent p-0.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary data-unchecked:bg-control-off data-disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-background shadow-raised transition-transform duration-150 ease-out data-checked:translate-x-3 data-unchecked:translate-x-0" />
    </SwitchPrimitive.Root>
  )
}
