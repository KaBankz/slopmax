// The one place that lists the agents (`AGENTS` in the Rust). Apart from
// `agent/mod.ts`, which the agents import, so the list can import them.
import { ClaudeCode } from "./claude-code.ts"
import { Codex } from "./codex.ts"
import type { Agent } from "./mod.ts"

/** Every agent slopmax knows, in the order `detect` asks them. */
export const AGENTS: ReadonlyArray<Agent> = [ClaudeCode, Codex]

/** The agent with this CLI name. */
export const find = (id: string): Agent | undefined => AGENTS.find((a) => a.id === id)

/** The agent a request comes from, judged from its headers. */
export const detect = (headers: Headers): Agent | undefined => AGENTS.find((a) => a.detect(headers))
