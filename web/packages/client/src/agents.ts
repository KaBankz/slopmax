// What every front end knows about the coding agents slopmax serves.
// Detecting them, wiring them up and running them lives with the engine.
import { Schema } from "effect"
import { AgentId, type ProviderId } from "./ids.ts"

export interface AgentFacts {
  readonly id: AgentId
  readonly title: string
  /** The program people run, and the name `slopmax run` and `slopmax setup` also take. */
  readonly program: string
  /** The subscription the agent is made for. */
  readonly provider: ProviderId
}

export const agentFacts: { readonly [K in AgentId]: AgentFacts & { readonly id: K } } = {
  "claude-code": { id: "claude-code", title: "Claude Code", program: "claude", provider: "claude" },
  codex: { id: "codex", title: "Codex", program: "codex", provider: "codex" },
}

/** Every agent, in the order requests are matched against them. */
export const agentOrder: ReadonlyArray<AgentId> = AgentId.literals

/** How an agent on this machine is set up, as the doctor, the CLI and the app show it. */
export class AgentWiring extends Schema.Class<AgentWiring>("AgentWiring")({
  id: AgentId,
  title: Schema.String,
  /** Whether its program is on `PATH`. */
  installed: Schema.Boolean,
  /** The settings file slopmax edits to wire it up. */
  configPath: Schema.String,
  /** The base URL the agent points at, when it points anywhere but its provider. */
  wiredTo: Schema.optionalKey(Schema.String),
  /** Whether it goes through this slopmax. */
  wired: Schema.Boolean,
  /** Whether slopmax kept what it replaced, so the setup can be undone. */
  backedUp: Schema.Boolean,
}) {}
