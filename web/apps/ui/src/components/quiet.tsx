// Nothing has gone through slopmax yet: what the activity pages show in
// place of their figures, and the way to the page that changes that.
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChartColumn, type LucideIcon } from "lucide-react"
import { agentsAtom } from "../atoms.ts"
import { anyWired } from "../view/live.ts"
import { pageHash, Pages } from "../view/pages.ts"
import { unwiredLine } from "../view/words.ts"
import { Empty } from "./parts.tsx"
import { ButtonLink } from "./ui/button.tsx"

/** An activity page with nothing to show, saying so when no agent is wired yet, with a link to Coding agents. */
export function Quiet({
  title,
  detail = "Requests show here once an agent sends them through slopmax.",
  icon = ChartColumn,
}: {
  readonly title: string
  readonly detail?: string
  readonly icon?: LucideIcon
}) {
  const agents = useAtomValue(agentsAtom)
  const unwired = Option.exists(AsyncResult.value(agents), (list) => !anyWired(list))
  return (
    <Empty icon={icon} title={title} detail={unwired ? `${unwiredLine} ${detail}` : detail}>
      <ButtonLink variant={unwired ? "default" : "outline"} href={pageHash(Pages.connections("agents"))}>
        Connect an agent
      </ButtonLink>
    </Empty>
  )
}
