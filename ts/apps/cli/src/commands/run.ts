// `slopmax run <agent>` and `slopmax env <agent>`: an agent through the
// proxy for one run, or a shell set up so every run goes through it.
import { Agents, agents, Background, selfCommand } from "@slopmax/core"
import type { AgentId } from "@slopmax/domain"
import { Effect } from "effect"
import { ExitWith } from "../failure.ts"
import { Print } from "../print.ts"

/**
 * Starts the proxy if it is not running, then the agent with this terminal,
 * passing its arguments as they were given; slopmax exits with the agent's
 * status. A proxy started for it keeps running afterwards.
 */
export const run = Effect.fn("cli.run")(function* (agent: AgentId, args: ReadonlyArray<string>) {
  yield* (yield* Background).ensure
  const code = yield* Agents.run(agent, args)
  if (code !== 0) return yield* new ExitWith({ code })
})

/** Shell lines for `eval "$(slopmax env claude)"`, exactly as the agent wants them. */
export const env = Effect.fn("cli.env")(function* (agent: AgentId) {
  const print = yield* Print
  const text = agents[agent].shell(yield* Agents.wireSettings, selfCommand())
  yield* print.out(text.endsWith("\n") ? text.slice(0, -1) : text)
})
