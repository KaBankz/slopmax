// What every front end knows about a provider without loading the engine:
// its name, how its accounts sign in and pay, and which models it serves.
// How it talks to its API lives with the engine's providers.
import { Duration, Result } from "effect"
import { type AgentId, type Dialect, ProviderId, type SubscriptionId } from "./ids.ts"

export interface ProviderFacts {
  readonly id: ProviderId
  /** For people: "your Claude account". */
  readonly title: string
  /** A plan with usage windows that reset, or paid per token. */
  readonly billing: "subscription" | "metered"
  /** The subscription whose models a metered provider also serves, as paid overflow. */
  readonly backs?: ProviderId
  /** The one agent these accounts may serve: Claude subscriptions serve Claude Code alone. */
  readonly agentOnly?: AgentId
  /**
   * How an account is added: a browser sign-in, a browser sign-in or a device
   * code on machines without one, an API key, or an endpoint's address with an
   * optional key.
   */
  readonly signIn: "browser" | "browser-or-device" | "key" | "endpoint"
  /** The base URL agents' request paths are appended to; per account for endpoints. */
  readonly api: string
  /** The formats that API speaks, preferred first; per account for endpoints. */
  readonly dialects: ReadonlyArray<Dialect>
  /** The models it serves, as patterns where `*` matches any run of characters; per account for endpoints. */
  readonly models: ReadonlyArray<string>
  /** How long before an access token expires it is refreshed. Keys never expire. */
  readonly refreshLead: Duration.Duration
  /** Whether its accounts bank limit resets that can be redeemed. */
  readonly hasResets: boolean
}

const openaiModels = ["gpt-*", "codex-*", "o1*", "o3*", "o4*"]

// A provider's billing follows from whether it is a SubscriptionId, so the two cannot drift apart.
export const providerFacts: {
  readonly [K in ProviderId]: ProviderFacts & {
    readonly id: K
    readonly billing: K extends SubscriptionId ? "subscription" : "metered"
  }
} = {
  claude: {
    id: "claude",
    title: "Claude",
    billing: "subscription",
    agentOnly: "claude-code",
    signIn: "browser",
    api: "https://api.anthropic.com",
    dialects: ["messages"],
    models: ["claude-*"],
    refreshLead: Duration.hours(1),
    hasResets: true,
  },
  codex: {
    id: "codex",
    title: "ChatGPT",
    billing: "subscription",
    signIn: "browser-or-device",
    api: "https://chatgpt.com/backend-api/codex",
    dialects: ["responses"],
    models: openaiModels,
    refreshLead: Duration.hours(24),
    hasResets: true,
  },
  anthropic: {
    id: "anthropic",
    title: "Anthropic API",
    billing: "metered",
    backs: "claude",
    agentOnly: "claude-code",
    signIn: "key",
    api: "https://api.anthropic.com",
    dialects: ["messages"],
    models: ["claude-*"],
    refreshLead: Duration.zero,
    hasResets: false,
  },
  openai: {
    id: "openai",
    title: "OpenAI API",
    billing: "metered",
    backs: "codex",
    signIn: "key",
    api: "https://api.openai.com/v1",
    dialects: ["responses", "chat"],
    models: openaiModels,
    refreshLead: Duration.zero,
    hasResets: false,
  },
  xai: {
    id: "xai",
    title: "xAI API",
    billing: "metered",
    signIn: "key",
    api: "https://api.x.ai/v1",
    dialects: ["chat"],
    models: ["grok-*"],
    refreshLead: Duration.zero,
    hasResets: false,
  },
  compat: {
    id: "compat",
    title: "Compatible endpoint",
    billing: "metered",
    signIn: "endpoint",
    api: "",
    dialects: [],
    models: [],
    refreshLead: Duration.zero,
    hasResets: false,
  },
}

/** Every provider, subscriptions first: the order requests try them in, and the order lists sort by. */
export const providerOrder: ReadonlyArray<ProviderId> = ProviderId.literals

export const isSubscription = (id: ProviderId): boolean => providerFacts[id].billing === "subscription"

const isProviderId = (text: string): text is ProviderId => providerOrder.some((id) => id === text)

/** Reads a provider id as people type it, saying which ids exist when it is none of them. */
export const parseProviderId = (text: string): Result.Result<ProviderId, string> =>
  isProviderId(text)
    ? Result.succeed(text)
    : Result.fail(`expected one of ${providerOrder.join(", ")}, got ${JSON.stringify(text)}`)

/**
 * Whether `model` matches `pattern`, where `*` matches any run of characters
 * (including none). Without a `*` the two must be equal. The last part
 * anchors at the end and may not overlap a part matched before it.
 */
export const matchesModel = (pattern: string, model: string): boolean => {
  if (!pattern.includes("*")) return pattern === model
  const [first = "", ...parts] = pattern.split("*")
  if (!model.startsWith(first)) return false
  let rest = model.slice(first.length)
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) return rest.length >= part.length && rest.endsWith(part)
    const at = rest.indexOf(part)
    if (at < 0) return false
    rest = rest.slice(at + part.length)
  }
  return rest === ""
}

/** Whether any of the patterns matches the model. */
export const matchesAny = (patterns: ReadonlyArray<string>, model: string): boolean =>
  patterns.some((pattern) => matchesModel(pattern, model))
