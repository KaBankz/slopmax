// The commands: their table, and running the one asked for.
import { runHost } from "@slopmax/app"
import { Effect, Result, type Stdio } from "effect"

import {
  Account,
  type account,
  agent,
  auth,
  background,
  Config,
  config as configs,
  daemon,
  error,
  Failure,
  import_ as imports,
  net,
  notify,
  paths,
  ProviderId,
  type Store,
  Store as Stores,
  text,
  time,
  wire,
} from "@slopmax/core"

import {
  type App,
  type Arg,
  type Choice,
  type Command,
  completions,
  i32,
  Kind,
  type Matches,
  parse,
  Shell,
  usize,
} from "./args.ts"
import { importLogins, login, own, redeem, remove, setDisabled, useAccount } from "./commands/accounts.ts"
import { anyhow, ensureRunning, logs, service, start, stop } from "./commands/background.ts"
import * as doctor from "./commands/doctor.ts"
import * as init from "./commands/init.ts"
import * as status from "./commands/status.ts"
import * as usage from "./commands/usage.ts"
import type { Terminal } from "./term.ts"
import * as ui from "./ui.ts"

const ACCOUNT = "Number from `slopmax status`, or the account's id, email, or label"

export const PROVIDERS: ReadonlyArray<Choice> = [
  { value: "claude", help: "Claude Pro/Max, used by Claude Code" },
  { value: "codex", help: "ChatGPT Plus/Pro/Team, used by Codex" },
  { value: "anthropic", help: "An Anthropic API key (for Claude Code)" },
  { value: "openai", help: "An OpenAI API key" },
  { value: "xai", help: "An xAI API key, for Grok models" },
  { value: "compat", help: "Any OpenAI- or Anthropic-compatible endpoint (needs --url)" },
]

export const AGENTS: ReadonlyArray<Choice> = [
  { value: "claude", help: "Claude Code" },
  { value: "codex", help: "Codex" },
]

const SOURCES: ReadonlyArray<Choice> = [
  { value: "all", help: "Every source below" },
  { value: "claude-code", help: "Claude Code's login (~/.claude/.credentials.json or the macOS keychain)" },
  { value: "codex", help: "The Codex CLI login (~/.codex/auth.json)" },
  { value: "cliproxyapi", help: "CLIProxyAPI credential files (~/.cli-proxy-api/*.json)" },
]

const SERVICE_ACTIONS: ReadonlyArray<Choice> = [
  { value: "install", help: "Start slopmax at login (systemd user unit or launchd agent)" },
  { value: "uninstall", help: "Remove the service" },
  { value: "status", help: "Show whether the service is installed and running" },
]

const KEY_ACTIONS: ReadonlyArray<Choice> = [
  { value: "list", help: "Show the keys" },
  { value: "add", help: "Make a key for another machine or tool" },
  { value: "remove", help: "Revoke a key" },
]

const RANGES: ReadonlyArray<Choice> = [
  { value: "today", help: "Since midnight" },
  { value: "7d", help: "Today and the 6 days before" },
  { value: "30d", help: "Today and the 29 days before" },
  { value: "all", help: "Everything recorded" },
]

const SHELLS: ReadonlyArray<Choice> = [
  { value: "bash", help: "Bash" },
  { value: "zsh", help: "Zsh" },
  { value: "fish", help: "Fish" },
]

const arg = (name: string, help: string, kind: Kind): Arg => ({ name, help, kind })

const command = (name: string, about: string, args: ReadonlyArray<Arg>): Command => ({
  name,
  alias: undefined,
  about,
  args,
})

const ACCOUNT_ARG: Arg = arg("account", ACCOUNT, Kind.Required())

export const APP: App = {
  name: "slopmax",
  about: "Multi-account switcher and proxy for Claude Code and Codex",
  afterHelp: "Run without a command to show account status.",
  default: "status",
  commands: [
    {
      name: "setup",
      alias: "init",
      about: "Set everything up step by step, or point one agent at the proxy",
      args: [
        arg("agent", "Wire just this agent (else run the whole setup)", Kind.Optional(AGENTS, "")),
        arg("undo", "With an agent: restore what setup replaced", Kind.Flag()),
        arg("yes", "Ask nothing: take the flags, else the recommended answers", Kind.Flag("y")),
        arg(
          "import",
          "Take logins from claude-code, codex, cliproxyapi, all, or none",
          Kind.Value(undefined, "SOURCES"),
        ),
        arg("login", "Sign in to these subscriptions: claude, codex", Kind.Value(undefined, "PROVIDERS")),
        arg("keys-from-env", "Add the keys in ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY", Kind.Flag()),
        arg("strategy", "reset-first, fill-first, least-used, or round-robin", Kind.Value(undefined, "STRATEGY")),
        arg(
          "affinity",
          "on: sessions keep their account; off: every request placed afresh",
          Kind.Value(undefined, "on|off"),
        ),
        arg("agents", "Point these agents at the proxy: claude, codex, or none", Kind.Value(undefined, "AGENTS")),
        arg("no-service", "Don't start slopmax at login", Kind.Flag()),
      ],
    },
    {
      name: "status",
      alias: "ls",
      about: "Show accounts, usage windows, and when limits reset",
      args: [
        arg("refresh", "Fetch fresh usage from the providers first", Kind.Flag("r")),
        arg("watch", "Keep the display updated", Kind.Flag("w")),
        arg("json", "Print machine-readable JSON", Kind.Flag()),
      ],
    },
    command("login", "Connect an account: sign in, or enter an API key", [
      arg("provider", "Which kind of account", Kind.Required(PROVIDERS)),
      arg("label", "Display name for the account", Kind.Value(undefined, "LABEL")),
      arg("device", "Sign in with a code instead of a browser redirect (Codex only)", Kind.Flag()),
      arg("no-browser", "Print the sign-in URL instead of opening a browser", Kind.Flag()),
      arg("url", "Compatible endpoint's base URL, e.g. http://localhost:11434/v1", Kind.Value(undefined, "URL")),
      arg("dialect", "Its format: chat (the default), responses, or messages", Kind.Value(undefined, "DIALECT")),
      arg(
        "models",
        "Models the endpoint serves, comma-separated (default: what it lists)",
        Kind.Value(undefined, "MODELS"),
      ),
    ]),
    command("import", "Copy existing logins from Claude Code, Codex, or CLIProxyAPI", [
      arg("source", "Where to import from", Kind.Optional(SOURCES, "all")),
      arg("own", "Refresh imported CLIProxyAPI logins here instead of following its files", Kind.Flag()),
    ]),
    command("own", "Take over refreshing an account slopmax follows from another tool", [
      arg("account", "Number from `slopmax status`, the account's id, email, or label, or `all`", Kind.Required()),
    ]),
    command("use", "Prefer an account for new sessions, or `auto` to let slopmax choose", [ACCOUNT_ARG]),
    command("label", "Set an account's display name", [ACCOUNT_ARG, arg("label", "The new name", Kind.Required())]),
    command("priority", "Set an account's priority; higher tiers are used first", [
      ACCOUNT_ARG,
      arg("priority", "Tier, 0 by default; negative values hold an account in reserve", Kind.Required()),
    ]),
    command("enable", "Route to an account again", [ACCOUNT_ARG]),
    command("disable", "Stop routing to an account (its tokens are still kept fresh)", [ACCOUNT_ARG]),
    command("remove", "Forget an account", [ACCOUNT_ARG]),
    command("redeem", "Redeem a banked limit reset, resetting a Claude or ChatGPT account's limits", [
      ACCOUNT_ARG,
      arg("yes", "Skip the confirmation prompt", Kind.Flag("y")),
    ]),
    command("serve", "Run the proxy in the foreground", []),
    command("start", "Start the proxy in the background", []),
    command("stop", "Stop the background proxy", []),
    command("service", "Run the proxy as a service that starts at login", [
      arg("action", "What to do", Kind.Required(SERVICE_ACTIONS)),
    ]),
    command("run", "Launch an agent through the proxy, starting the proxy if needed", [
      arg("agent", "Which agent", Kind.Required(AGENTS)),
      arg("args", "Arguments passed to the agent", Kind.Rest),
    ]),
    command("env", "Print shell setup that points an agent at the proxy, for `eval`", [
      arg("agent", "Which agent", Kind.Required(AGENTS)),
    ]),
    command("config", "Show the routing and redeem settings, or change one while the proxy runs", [
      arg("name", "The setting, e.g. strategy", Kind.Optional([], "")),
      arg("value", "Its new value, e.g. round-robin", Kind.Optional([], "")),
    ]),
    command("usage", "Show token usage and its API-equivalent cost", [
      arg("range", "Which period", Kind.Optional(RANGES, "7d")),
      arg("by", "Group by day, model, or account", Kind.Value("b", "BY")),
      arg("json", "Print machine-readable JSON", Kind.Flag()),
    ]),
    command("key", "Manage keys for other machines and tools", [
      arg("action", "What to do", Kind.Optional(KEY_ACTIONS, "list")),
      arg("name", "The key's name", Kind.Optional([], "")),
      arg("models", "Models it may use, comma-separated patterns (default: any)", Kind.Value(undefined, "MODELS")),
    ]),
    command("logs", "Show the background proxy's log", [
      arg("follow", "Keep printing new lines", Kind.Flag("f")),
      arg("lines", "How many lines to show first (default 40)", Kind.Value("n", "N")),
    ]),
    command("notify", "Send a test notification", []),
    command("dashboard", "Open the dashboard in a browser, starting the proxy if needed", [
      arg("print", "Print its address instead of opening a browser", Kind.Flag()),
    ]),
    command("doctor", "Check the setup and say how to fix problems", []),
    command("completions", "Print a shell completion script", [arg("shell", "Which shell", Kind.Required(SHELLS))]),
  ],
}

/**
 * The hidden command the desktop app runs its engine with: `@slopmax/app`'s
 * host, speaking its protocol on stdin and stdout. Never listed, in help or
 * completions, and not in the table, which is the Rust's.
 */
export const APP_HOST = "app-host"

const { fail } = error

/**
 * Parses `args` (without the program name), runs the command, and returns
 * the process exit code.
 */
export const run: (args: ReadonlyArray<string>) => Effect.Effect<number, Failure, Terminal | Stdio.Stdio> = Effect.fn(
  "commands.run",
)(function* (args: ReadonlyArray<string>) {
  if (args[0] === APP_HOST) {
    yield* runHost().pipe(Effect.mapError(anyhow))
    return 0
  }
  const bare = args.length === 0
  const parsed = parse(APP, args)
  if (Result.isFailure(parsed)) {
    yield* ui.eprint(parsed.failure.toString())
    return 2
  }
  if (parsed.success._tag === "Print") {
    yield* ui.print(parsed.success.text)
    return 0
  }
  const m = parsed.success.matches
  const config = yield* Config.load()
  yield* Config.apply(config)
  const store = yield* Stores.open
  // A first run at a terminal starts the guided setup instead.
  if (bare && (yield* init.wanted(store))) {
    yield* init.run(config, store, "Ask", init.Plan.empty())
    return 0
  }
  switch (m.command.name) {
    case "setup": {
      if ((m.value("agent") ?? "") !== "") {
        yield* setup(config, store, yield* agentNamed(m), m.flag("undo"))
        break
      }
      if (m.flag("undo")) return yield* fail("--undo restores one agent: `slopmax setup claude --undo`")
      const answers: init.Answers = m.flag("yes") || !init.stdinIsTerminal() ? "Defaults" : "Ask"
      const listed = <T>(name: string, read: (list: string) => Result.Result<T, Failure>) => {
        const value = m.value(name)
        return value === undefined ? Effect.succeed(undefined) : Effect.fromResult(read(value))
      }
      const sources = yield* listed("import", init.sources)
      const logins = yield* listed("login", init.subscriptions)
      const strategyName = m.value("strategy")
      let strategy: configs.Strategy | undefined
      if (strategyName !== undefined) {
        strategy = configs.Strategy.parse(strategyName)
        if (strategy === undefined) {
          return yield* fail(
            `--strategy takes reset-first, fill-first, least-used, or round-robin, got ${text.debug(strategyName)}`,
          )
        }
      }
      const affinity = yield* listed("affinity", onOff)
      const agents = yield* listed("agents", init.agents)
      const plan: init.Plan = {
        import: sources,
        login: logins,
        keysFromEnv: m.flag("keys-from-env"),
        strategy,
        affinity,
        agents,
        noService: m.flag("no-service"),
      }
      yield* init.run(config, store, answers, plan)
      break
    }
    case "status": {
      const wanted: status.StatusArgs = { refresh: m.flag("refresh"), watch: m.flag("watch"), json: m.flag("json") }
      if (wanted.watch && wanted.json) return yield* fail("--json cannot be combined with --watch")
      yield* status.run(config, store, wanted)
      break
    }
    case "login": {
      const provider = yield* m.get("provider", ProviderId.parse)
      const url = m.value("url")
      let endpointGiven: account.Endpoint | undefined
      if (url !== undefined)
        endpointGiven = yield* Effect.fromResult(endpoint(url, m.value("dialect"), m.value("models")))
      else if (provider === "compat") return yield* fail("a compatible endpoint needs its address: --url <base url>")
      if (endpointGiven !== undefined && provider !== "compat") {
        return yield* fail("--url, --dialect, and --models are for `slopmax login compat`")
      }
      const options: auth.LoginOptions = {
        ...auth.LoginOptions.default(),
        device: m.flag("device"),
        noBrowser: m.flag("no-browser"),
        ...(endpointGiven === undefined ? {} : { endpoint: endpointGiven }),
      }
      yield* login(store, provider, m.value("label"), options)
      break
    }
    case "import":
      yield* importLogins(store, yield* m.get("source", imports.Source.parse), m.flag("own"))
      break
    case "own":
      yield* own(store, yield* m.string("account"))
      break
    case "use":
      yield* useAccount(store, yield* m.string("account"))
      break
    case "label": {
      const id = (yield* store.find(yield* m.string("account"))).id
      const label = yield* m.string("label")
      const a = yield* store.update(id, (current) => ({ ...current, label }))
      yield* ui.println(`Renamed ${a.id} to ${ui.bold(Account.name(a))}`)
      break
    }
    case "priority": {
      const id = (yield* store.find(yield* m.string("account"))).id
      const priority = yield* m.get("priority", i32)
      const a = yield* store.update(id, (current) => ({ ...current, priority }))
      yield* ui.println(`${ui.bold(Account.name(a))} now has priority ${priority}`)
      break
    }
    case "enable":
      yield* setDisabled(store, yield* m.string("account"), false)
      break
    case "disable":
      yield* setDisabled(store, yield* m.string("account"), true)
      break
    case "remove":
      yield* remove(store, yield* m.string("account"))
      break
    case "redeem":
      yield* redeem(config, store, yield* m.string("account"), m.flag("yes"))
      break
    case "serve":
      // Startup code runs in the interpreter (`--compile-jit-policy`); the
      // proxy's request path wants the normal JIT.
      normalJit()
      yield* daemon.run(config)
      break
    case "start":
      yield* start(config)
      break
    case "stop":
      yield* stop(config)
      break
    case "service":
      yield* service(config, yield* m.string("action"))
      break
    case "run": {
      yield* ensureRunning(config)
      return yield* agent.run(yield* agentNamed(m), config, m.rest)
    }
    case "env": {
      const exe = yield* background.currentExe
      yield* ui.print((yield* agentNamed(m)).env(config, exe))
      break
    }
    case "config":
      yield* settings(config, m.value("name") ?? "", m.value("value") ?? "")
      break
    case "usage": {
      const by = m.value("by") ?? "day"
      if (by !== "day" && by !== "model" && by !== "account") return yield* fail("--by takes day, model, or account")
      yield* usage.run(config, store, yield* m.string("range"), by, m.flag("json"))
      break
    }
    case "notify": {
      if (!configs.NotifySettings.isEnabled(config.notify)) {
        return yield* fail(
          `notifications are off; set a webhook or command under [notify] in ${yield* paths.configFile}`,
        )
      }
      const http = yield* auth.httpClient(new net.Origins())
      const event = notify.Event.test(yield* time.Timestamp.now)
      yield* notify.send(config.notify, http, event)
      yield* ui.println("Sent a test notification.")
      break
    }
    case "key":
      yield* key(config, yield* m.string("action"), m)
      break
    case "logs": {
      const given = m.value("lines")
      let lines = 40
      if (given !== undefined) {
        const n = usize(given)
        if (Result.isFailure(n)) {
          return yield* error.fail(n.failure).pipe(error.context("--lines takes a number"))
        }
        lines = n.success
      }
      yield* logs(lines, m.flag("follow"))
      break
    }
    case "dashboard": {
      yield* ensureRunning(config)
      const url = Config.dashboardUrl(config)
      if (!m.flag("print") && (yield* auth.callback.openBrowser(url))) {
        yield* ui.println("Opened the dashboard in your browser.")
      } else {
        yield* ui.println(`Open the dashboard at:\n\n  ${url}\n`)
        const port = config.listen.port
        yield* ui.println(
          ui.dim(`On another machine, forward the port first: ssh -L ${port}:127.0.0.1:${port} <this host>`),
        )
      }
      break
    }
    case "doctor":
      return yield* doctor.run(config, store)
    case "completions":
      yield* ui.print(completions(APP, yield* m.get("shell", Shell.parse)))
      break
    default:
      return yield* Effect.die(`\`${m.command.name}\` is in the command table but not dispatched`)
  }
  return 0
})

// `Bun.unsafe.setJITPolicy(1)` where the runtime has it (a JIT build).
const normalJit = (): void => {
  const unsafe: { readonly setJITPolicy?: (scale: number) => void } = Bun.unsafe
  try {
    unsafe.setJITPolicy?.(1)
  } catch {
    // Nothing to reset in a build without a JIT.
  }
}

/** `slopmax key list|add|remove`. */
const key = Effect.fn("commands.key")(function* (config: Config, action: string, m: Matches) {
  const path = yield* paths.configFile
  const named = m.value("name")
  const name = named === undefined || named === "" ? undefined : named
  if (action === "list") {
    if (config.keys.length === 0) yield* ui.println("No client keys. Make one with `slopmax key add <name>`.")
    for (const k of config.keys) {
      const models = k.models.length === 0 ? "any model" : k.models.join(", ")
      yield* ui.println(`${ui.bold(k.name)}  ${ui.dim(models)}`)
    }
    return
  }
  if (name === undefined) return yield* fail(`\`slopmax key ${action}\` needs the key's name`)
  if (action === "add") {
    const models = list(m.value("models") ?? "")
    const made = yield* Config.addKey(path, name, models)
    yield* ui.println(made)
    yield* ui.eprintln(
      ui.dim(
        `Added the key ${text.debug(name)}. Clients present it as a bearer token or x-api-key; a running proxy takes it within seconds.`,
      ),
    )
    return
  }
  if (action === "remove") {
    if (!(yield* Config.removeKey(path, name))) return yield* fail(`no key named ${text.debug(name)}`)
    yield* ui.println(`Revoked the key ${text.debug(name)}.`)
    return
  }
  return yield* Effect.die("key actions are checked by the parser")
})

// `a, b ,` → `["a", "b"]`: split on commas, trimmed, empties dropped.
const list = (value: string): Array<string> =>
  value
    .split(",")
    .map(text.trim)
    .filter((s) => s !== "")

/** A compatible endpoint from `login compat` arguments. */
export const endpoint = (
  url: string,
  dialect: string | undefined,
  models: string | undefined,
): Result.Result<account.Endpoint, Failure> => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return Result.fail(new Failure({ message: `--url takes an http:// or https:// base URL, got ${text.debug(url)}` }))
  }
  const given = dialect ?? "chat"
  if (given !== "chat" && given !== "responses" && given !== "messages") {
    return Result.fail(
      new Failure({ message: `--dialect takes chat, responses, or messages, got ${text.debug(given)}` }),
    )
  }
  const chosen: wire.Dialect = given
  return Result.succeed({ baseUrl: url.replace(/\/+$/, ""), dialect: chosen, models: list(models ?? "") })
}

/**
 * `slopmax config [name [value]]`: shows the live settings, or one, or
 * sets one and has the running proxy apply it at once.
 */
const settings = Effect.fn("commands.settings")(function* (config: Config, name: string, value: string) {
  if (name === "") {
    const width = Math.max(0, ...configs.LIVE.map(([n]) => text.width(n)))
    for (const [setting, about] of configs.LIVE) {
      const current = Config.live(config, setting) ?? ""
      yield* ui.println(`${ui.pad(setting, width)}  ${ui.bold(ui.pad(current, 11))}  ${ui.dim(about)}`)
    }
    yield* ui.println(
      `\n${ui.dim(`\`slopmax config <name> <value>\` changes one; the rest live in ${yield* paths.configFile}.`)}`,
    )
    return
  }
  if (value === "") {
    const current = Config.live(config, name)
    if (current === undefined) {
      const why = configs.liveValue(name, "")
      return yield* fail(Result.isFailure(why) ? why.failure : "")
    }
    yield* ui.println(current)
    return
  }
  const setting = configs.liveValue(name, value)
  if (Result.isFailure(setting)) return yield* fail(setting.failure)
  const changed = yield* Config.set(yield* paths.configFile, [setting.success])
  const now = Config.live(changed, name) ?? ""
  const synced = yield* (yield* background.Daemon.make(config)).sync
  const applied = synced !== undefined ? "applied now" : "the proxy applies it when it starts"
  yield* ui.println(`${name} = ${ui.bold(now)} ${ui.dim(`(${applied})`)}`)
})

/** `on` or `off`, as switches are given. */
export const onOff = (value: string): Result.Result<boolean, Failure> => {
  switch (value) {
    case "on":
    case "true":
    case "yes":
      return Result.succeed(true)
    case "off":
    case "false":
    case "no":
      return Result.succeed(false)
    default:
      return Result.fail(new Failure({ message: `expected on or off, got ${text.debug(value)}` }))
  }
}

/** The agent named by the `agent` argument. */
const agentNamed = Effect.fn("commands.agentNamed")(function* (m: Matches) {
  const name = yield* m.string("agent")
  const found = agent.find(name)
  if (found === undefined) return yield* fail(`unknown agent ${text.debug(name)}`)
  return found
})

const setup = Effect.fn("commands.setup")(function* (config: Config, store: Store, chosen: agent.Agent, undo: boolean) {
  const app = chosen.title
  if (undo) {
    const path = yield* agent.undo(chosen)
    yield* ui.println(`Restored ${app} ${ui.dim(`(${path})`)}`)
    return
  }
  const path = yield* agent.setup(chosen, config)
  yield* ui.println(`${app} now uses slopmax ${ui.dim(`(${path})`)}`)
  yield* ui.println(ui.dim(chosen.setupNote))
  if (!agent.servable(chosen, yield* store.list())) {
    const provider = chosen.provider
    yield* ui.println(
      `${ui.yellow("Note:")} no ${ProviderId.spec(provider).title} account is connected to serve it; until one is, its requests fail. ` +
        `Add one with \`slopmax login ${provider}\`, or undo with \`--undo\`.`,
    )
  }
  const running = yield* (yield* background.Daemon.make(config)).isRunning
  const next = running
    ? "Undo with `--undo`."
    : "Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`."
  yield* ui.println(ui.dim(next))
})
