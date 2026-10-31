// The coding agents slopmax serves, as values in one registry. A new agent
// is one file, one literal in `AgentId`, one entry in `agentFacts` and one
// here; the type checker fails until all four exist.
import { type AgentId, agentOrder } from "@slopmax/domain"
import { type Agent, commonSession, connectAgent, disconnectAgent, runAgent, wiringOf } from "./agent.ts"
import { claudeCode } from "./claude-code.ts"
import { codex } from "./codex.ts"

export const agents: { readonly [K in AgentId]: Agent & { readonly id: K } } = { "claude-code": claudeCode, codex }

/** Every agent, in the order requests are matched against them. */
export const agentList: ReadonlyArray<Agent> = agentOrder.map((id) => agents[id])

/** The agent a request comes from, judged from its headers. */
export const detect = (headers: Headers): Agent | undefined => agentList.find((agent) => agent.detect(headers))

/** The conversation a request belongs to: the agent's own session id, or one other clients commonly send. */
export const session = (agent: Agent | undefined, headers: Headers, body: Uint8Array): string | undefined =>
  agent === undefined ? commonSession(headers, body) : agent.session(headers, body)

/** How the agent is wired on this machine. */
export const wiring = (id: AgentId) => wiringOf(agents[id])

/** Wires the agent's own settings to the proxy, keeping a backup for undo. */
export const connect = (id: AgentId) => connectAgent(agents[id])

/** Undoes the agent's setup. */
export const disconnect = (id: AgentId) => disconnectAgent(agents[id])

/** Runs the agent through the proxy and returns its exit status. */
export const run = (id: AgentId, args: ReadonlyArray<string>) => runAgent(agents[id], args)

export {
  type Agent,
  AgentConfigInvalid,
  commonSession,
  type Launch,
  NothingToUndo,
  onPath,
  realPath,
  servable,
  servedBy,
  type SetupFacts,
  shellQuote,
  type WireSettings,
  wireSettings,
  type Wired,
  wiresToSlopmax,
} from "./agent.ts"
