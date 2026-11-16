// Nothing has gone through slopmax yet: what the activity pages show in
// place of their figures, and the way to the page that changes that.
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ChartColumn, type LucideIcon } from "lucide-react"
import { agentsAtom, go } from "../atoms.ts"
import { anyWired } from "../view/live.ts"
import { Pages } from "../view/pages.ts"
import { unwiredLine } from "../view/words.ts"
import { Empty } from "./parts.tsx"
import { Button } from "./ui/button.tsx"

/** An activity page with nothing to show, saying so when no agent is wired yet, with a button to the Agents page. */
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
      <Button variant={unwired ? "default" : "outline"} onClick={() => go(Pages.agents)}>
        Connect an agent
      </Button>
    </Empty>
  )
}
