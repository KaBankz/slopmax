// Claude Code, and every app that runs it (the Agent SDK, IDE extensions,
// desktop wrappers): all of them read `~/.claude/settings.json`, so wiring
// its `env` block reaches them all. Claude Code reaches the proxy at
// `<base>/claude`, carrying slopmax's owner key as its auth token.
import { Finding } from "@slopmax/domain"
import { Option, Result, Schema } from "effect"
import { prettyJson } from "../home.ts"
import { isRecord } from "../providers/provider.ts"
import { type Agent, factsOf, header, shellQuote, stringField, type WireSettings } from "./agent.ts"

const facts = factsOf("claude-code")

/** The `env` keys setup manages, saved before it changes them. */
const managed = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_API_KEY",
] as const

/** Where Claude Code reaches the proxy. */
export const claudeBase = (settings: WireSettings): string => `${settings.baseUrl}/claude`

/**
 * The environment that sends Claude Code through the proxy.
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` makes these win over provider
 * settings in `settings.json`, and gateway model discovery lists the
 * models the proxy serves.
 */
export const claudeEnv = (settings: WireSettings): ReadonlyArray<readonly [string, string]> => [
  ["ANTHROPIC_BASE_URL", claudeBase(settings)],
  ["ANTHROPIC_AUTH_TOKEN", settings.apiKey],
  ["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1"],
  ["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1"],
]

type JsonObject = { readonly [key: string]: unknown }

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** settings.json's object; a missing file is an empty one. */
const readSettings = (doc: Option.Option<string>): Result.Result<JsonObject, string> => {
  if (Option.isNone(doc)) return Result.succeed({})
  const value = parseJson(doc.value)
  if (Option.isNone(value)) return Result.fail("it is not valid JSON")
  return isRecord(value.value) ? Result.succeed(value.value) : Result.fail("it is not a JSON object")
}

const setup: Agent["setup"] = (doc, settings) =>
  Result.flatMap(readSettings(doc), (file) => {
    const env = file["env"] ?? {}
    if (!isRecord(env)) return Result.fail("its `env` is not an object")
    const backup = Object.fromEntries(managed.map((key) => [key, Object.hasOwn(env, key) ? env[key] : null]))
    // A key beside the token makes Claude Code warn about the conflict, so it goes.
    const { ANTHROPIC_API_KEY: _key, ...kept } = env
    const wired = {
      ...kept,
      ANTHROPIC_BASE_URL: claudeBase(settings),
      ANTHROPIC_AUTH_TOKEN: settings.apiKey,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    }
    return Result.succeed({ text: prettyJson({ ...file, env: wired }), backup })
  })

const Backup = Schema.Record(Schema.String, Schema.Unknown)
const decodeBackup = Schema.decodeUnknownOption(Backup)

const undo: Agent["undo"] = (doc, backup) =>
  Option.match(decodeBackup(backup), {
    onNone: () => Result.fail("the saved Claude Code settings are unreadable"),
    onSome: (saved) =>
      Result.map(readSettings(doc), (file) => {
        const env = file["env"]
        if (!isRecord(env)) return prettyJson(file)
        const restored: Record<string, unknown> = { ...env }
        for (const [key, value] of Object.entries(saved)) {
          if (value === null) delete restored[key]
          else restored[key] = value
        }
        return prettyJson({ ...file, env: restored })
      }),
  })

const envValue = (doc: Option.Option<string>, key: string): string | undefined => {
  const env = Result.getOrUndefined(readSettings(doc))?.["env"]
  const value = isRecord(env) ? env[key] : undefined
  return typeof value === "string" ? value : undefined
}

const fix = `slopmax setup ${facts.program}`

const inspect: Agent["inspect"] = (doc, settings): ReadonlyArray<Finding> => {
  const base = envValue(doc, "ANTHROPIC_BASE_URL")
  if (base === undefined) {
    return [
      new Finding({
        level: "info",
        text: `not wired in settings.json (\`slopmax run ${facts.program}\` still works)`,
        fix,
      }),
    ]
  }
  if (base !== claudeBase(settings)) {
    return [new Finding({ level: "warn", text: `settings.json sends Claude Code to ${base}`, fix })]
  }
  return envValue(doc, "ANTHROPIC_AUTH_TOKEN") === settings.apiKey
    ? [new Finding({ level: "ok", text: "wired through settings.json, for the CLI and the apps that run it" })]
    : [new Finding({ level: "warn", text: "settings.json points at slopmax with a different key", fix })]
}

export const claudeCode: Agent & { readonly id: "claude-code" } = {
  ...facts,
  // Every entrypoint (CLI, Agent SDK, IDE, desktop) sends `claude-cli/<version>` on API calls and `claude-code/<version>` on others.
  detect: (headers) => {
    const agent = header(headers, "user-agent") ?? ""
    return agent.startsWith("claude-cli/") || agent.startsWith("claude-code/")
  },
  session: (headers, body) => {
    const id = header(headers, "x-claude-code-session-id")
    if (id !== undefined) return id
    const userId = stringField(body, "metadata", "user_id")
    if (userId === undefined) return undefined
    // Newer versions put JSON there; older ones `user_<hash>_account_<uuid>_session_<id>`.
    const inner = stringField(userId, "session_id")
    if (inner !== undefined) return inner
    const at = userId.lastIndexOf("_session_")
    return at < 0 ? undefined : userId.slice(at + "_session_".length)
  },
  launch: (settings, args) => ({
    command: facts.program,
    args,
    // An API key in the environment would win over the proxy's token.
    env: { ...Object.fromEntries(claudeEnv(settings)), ANTHROPIC_API_KEY: undefined },
  }),
  shell: (settings) =>
    `${claudeEnv(settings)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
      .join("")}unset ANTHROPIC_API_KEY\n`,
  configFile: (paths) => `${paths.claudeDir}/settings.json`,
  setup,
  undo,
  wiredTo: (doc) => envValue(doc, "ANTHROPIC_BASE_URL"),
  inspect,
  note: "Restart Claude Code and the apps that run it. The Claude desktop app's Code tab and Cowork keep using the app's own login.",
}
