// Codex (the CLI and the ChatGPT desktop app, which read the same
// `~/.codex/config.toml`), wired through a model provider of slopmax's own.
//
// The provider is named "OpenAI" so Codex keeps its first-party behavior,
// such as compaction on the server. For one run, `slopmax run codex` passes
// the provider as `-c` overrides and hands the key over in an environment
// variable; setup writes it into `config.toml`, editing only the lines it
// owns so people's comments and other settings stay as they wrote them.
import { Finding } from "@slopmax/domain"
import { Effect, FileSystem, Option, Result, Schema } from "effect"
import { type Agent, factsOf, header, shellQuote, stringField, type WireSettings } from "./agent.ts"
import { edit, isTable, load, render, type Scalar, type Table } from "./toml.ts"

/** The model provider slopmax adds to Codex. */
const provider = "slopmax"

/** The environment variable `slopmax run codex` hands the key over in. */
const keyVariable = "SLOPMAX_API_KEY"

/** Codex subcommands that start a session. Each reads its own `-c` flags, which replace the ones given before it. */
const sessionCommands: ReadonlySet<string> = new Set(["exec", "e", "review", "resume", "fork"])

const facts = factsOf("codex")

const codexBase = (settings: WireSettings) => `${settings.baseUrl}/codex`

/** One `-c key=value` override, the value written as TOML. */
const set = (key: string, value: Scalar) => ["-c", `${key}=${render(value)}`]

/** The `-c` overrides that send one run of Codex through the proxy. */
export const overrides = (settings: WireSettings): ReadonlyArray<string> => {
  return [
    ...set("model_provider", provider),
    ...set(`model_providers.${provider}.name`, "OpenAI"),
    ...set(`model_providers.${provider}.base_url`, codexBase(settings)),
    ...set(`model_providers.${provider}.wire_api`, "responses"),
    ...set(`model_providers.${provider}.env_key`, keyVariable),
    ...(settings.websockets ? set(`model_providers.${provider}.supports_websockets`, true) : []),
  ]
}

/** Codex's arguments: slopmax's overrides at the level of the user's own, so neither set drops the other. */
export const codexArgs = (settings: WireSettings, args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [first, ...rest] = args
  return first !== undefined && sessionCommands.has(first)
    ? [first, ...overrides(settings), ...rest]
    : [...overrides(settings), ...args]
}

/** The provider table setup writes. */
const providerTable = (settings: WireSettings, signedIn: boolean): ReadonlyArray<readonly [string, Scalar]> => [
  ["name", "OpenAI"],
  ["base_url", codexBase(settings)],
  ["wire_api", "responses"],
  ["experimental_bearer_token", settings.apiKey],
  ...(settings.websockets ? [["supports_websockets", true] as const] : []),
  // Keeps the desktop app's account screens for people signed in to Codex; requests still carry slopmax's key.
  ...(signedIn ? [["requires_openai_auth", true] as const] : []),
]

const tablePath = ["model_providers", provider]

/** What setup replaced: the provider Codex used before, if any. */
const Backup = Schema.Struct({ modelProvider: Schema.NullOr(Schema.String) })
const decodeBackup = Schema.decodeUnknownOption(Backup)

const loadDoc = (doc: Option.Option<string>) => load(Option.getOrElse(doc, () => ""))

const selectedProvider = (table: Table): string | undefined =>
  typeof table["model_provider"] === "string" ? table["model_provider"] : undefined

const providerEntry = (table: Table, name: string): Table | undefined => {
  const providers = table["model_providers"]
  const entry = isTable(providers) ? providers[name] : undefined
  return isTable(entry) ? entry : undefined
}

const stringIn = (table: Table | undefined, key: string): string | undefined => {
  const value = table?.[key]
  return typeof value === "string" ? value : undefined
}

const setup: Agent["setup"] = (doc, settings, { signedIn }) =>
  Result.flatMap(loadDoc(doc), (parsed) => {
    const providers = parsed.table["model_providers"]
    if (providers !== undefined && !isTable(providers)) return Result.fail("its `model_providers` is not a table")
    const previous = selectedProvider(parsed.table)
    return Result.map(
      edit(parsed, {
        root: [["model_provider", provider]],
        tables: [[tablePath, providerTable(settings, signedIn)]],
      }),
      (text) => ({ text, backup: { modelProvider: previous === provider ? null : (previous ?? null) } }),
    )
  })

const undo: Agent["undo"] = (doc, backup) =>
  Option.match(decodeBackup(backup), {
    onNone: () => Result.fail("the saved Codex settings are unreadable"),
    onSome: ({ modelProvider }) =>
      Result.flatMap(loadDoc(doc), (parsed) =>
        edit(parsed, {
          root: [["model_provider", modelProvider ?? undefined]],
          tables: [[tablePath, undefined]],
        }),
      ),
  })

const wiredTo: Agent["wiredTo"] = (doc) =>
  Result.match(loadDoc(doc), {
    onFailure: () => undefined,
    onSuccess: ({ table }) => {
      const selected = selectedProvider(table)
      if (selected === undefined) return undefined
      const base = stringIn(providerEntry(table, selected), "base_url")
      return base === undefined ? selected : `${selected} (${base})`
    },
  })

const fix = `slopmax setup ${facts.program}`

const inspect: Agent["inspect"] = (doc, settings): ReadonlyArray<Finding> => {
  const table = Result.getOrUndefined(loadDoc(doc))?.table ?? {}
  const selected = selectedProvider(table)
  if (selected === undefined) {
    return [
      new Finding({
        level: "info",
        text: `not wired in config.toml (\`slopmax run ${facts.program}\` still works)`,
        fix,
      }),
    ]
  }
  if (selected !== provider)
    return [new Finding({ level: "warn", text: `config.toml sends Codex to the \`${selected}\` provider`, fix })]
  const entry = providerEntry(table, provider)
  if (entry === undefined) {
    return [
      new Finding({
        level: "warn",
        text: "config.toml selects slopmax, but its provider table is gone (the Codex desktop app can rewrite the file)",
        fix,
      }),
    ]
  }
  const current =
    stringIn(entry, "base_url") === codexBase(settings) &&
    stringIn(entry, "experimental_bearer_token") === settings.apiKey
  return current
    ? [new Finding({ level: "ok", text: "wired through config.toml, for the CLI and the desktop app" })]
    : [new Finding({ level: "warn", text: "config.toml's slopmax provider has an old address or key", fix })]
}

// --- Codex's own login (`auth.json`) -----------------------------------------

/** Enough of Codex's `auth.json` to know it holds a ChatGPT login; the importers read the rest. */
const AuthFile = Schema.Struct({ tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({}))) })
const decodeAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(AuthFile))

/** A ChatGPT login: `auth.json` parses and has tokens (an API key login has none). */
const hasLogin: Agent["hasLogin"] = (paths) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${paths.codexDir}/auth.json`).pipe(Effect.option)
    return Option.exists(
      Option.flatMap(text, decodeAuthFile),
      (file) => file.tokens !== undefined && file.tokens !== null,
    )
  })

export const codex: Agent & { readonly id: "codex" } & Required<Pick<Agent, "hasLogin">> = {
  ...facts,
  // Codex's clients name themselves `codex_exec/…`, `codex_cli_rs/…` and so on.
  detect: (headers) => header(headers, "user-agent")?.startsWith("codex") ?? false,
  // One `session-id` covers a whole tree of subagents, matching their `prompt_cache_key`, so the tree stays on one account.
  session: (headers, body) => {
    const metadata = header(headers, "x-codex-turn-metadata")
    return (
      header(headers, "session-id") ??
      header(headers, "session_id") ??
      (metadata === undefined ? undefined : stringField(metadata, "session_id")) ??
      stringField(body, "prompt_cache_key")
    )
  },
  launch: (settings, args) => ({
    command: facts.program,
    args: codexArgs(settings, args),
    env: { [keyVariable]: settings.apiKey },
  }),
  // A shell function that goes through `slopmax run`, which puts the overrides after any session subcommand.
  shell: (_settings, self) => `${facts.program}() { ${self.map(shellQuote).join(" ")} run ${facts.program} "$@"; }\n`,
  configFile: (paths) => `${paths.codexDir}/config.toml`,
  setup,
  undo,
  wiredTo,
  inspect,
  note: "Restart Codex. Quit and reopen the Codex (ChatGPT) desktop app, which reads the same config.",
  hasLogin,
}
