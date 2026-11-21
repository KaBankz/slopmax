// Shared input guidance for account endpoints and client keys.
import { FieldDescription } from "./ui/field.tsx"

export function ModelPatternHelp({ id }: { readonly id: string }) {
  return (
    <FieldDescription id={id}>
      Separate model patterns with commas, for example <code className="font-mono">gpt-*, claude-haiku-*</code>.
    </FieldDescription>
  )
}
