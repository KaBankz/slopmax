// The command tree. Every command's flags and arguments are declared here
// and handed, parsed and typed, to an action; the actions themselves live in
// `commands/`. Building the tree from a record of actions lets the tests
// parse every typical invocation with actions that only record what they got.
//
// Choices come from the registries: providers in `providerOrder`, agents by
// the program people run (`claude`, `codex`) or their id, strategies and
// ranges from their schemas, so a new provider or agent is offered as soon
// as it is registered.
import {
  agentFacts,
  type AgentId,
  agentOrder,
  type Dialect,
  Dialect as DialectSchema,
  type ProviderId,
  providerFacts,
  providerOrder,
  Strategy,
  type SummaryBy,
  SummaryBy as SummaryBySchema,
  type SummaryRange,
  SummaryRange as SummaryRangeSchema,
} from "@slopmax/domain"
import type { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { ImportInput, LoginInput, RedeemInput } from "./commands/accounts.ts"
import type { ServiceAction } from "./commands/background.ts"
import type { ConfigInput } from "./commands/config.ts"
import type { LogsInput } from "./commands/logs.ts"
import type { SetupInput } from "./commands/setup.ts"
import type { StatusInput } from "./commands/status.ts"
import type { UsageInput } from "./commands/usage.ts"

/** What each command does with its parsed input. */
export interface Actions<E, R> {
  /** `slopmax` alone: the status, or the guided setup at a terminal with no accounts yet. */
  readonly bare: Effect.Effect<void, E, R>
  readonly setup: (input: SetupInput) => Effect.Effect<void, E, R>
  readonly status: (input: StatusInput) => Effect.Effect<void, E, R>
  readonly login: (input: LoginInput) => Effect.Effect<void, E, R>
  readonly import: (input: ImportInput) => Effect.Effect<void, E, R>
  readonly own: (account: string) => Effect.Effect<void, E, R>
  readonly use: (account: string) => Effect.Effect<void, E, R>
  readonly label: (account: string, label: Option.Option<string>) => Effect.Effect<void, E, R>
  readonly priority: (account: string, priority: number) => Effect.Effect<void, E, R>
  readonly enable: (account: string) => Effect.Effect<void, E, R>
  readonly disable: (account: string) => Effect.Effect<void, E, R>
  readonly remove: (account: string) => Effect.Effect<void, E, R>
  readonly redeem: (input: RedeemInput) => Effect.Effect<void, E, R>
  readonly serve: (log: Option.Option<string>) => Effect.Effect<void, E, R>
  readonly start: (json: boolean) => Effect.Effect<void, E, R>
  readonly stop: Effect.Effect<void, E, R>
  readonly service: (action: ServiceAction, json: boolean) => Effect.Effect<void, E, R>
  readonly run: (agent: AgentId, args: ReadonlyArray<string>) => Effect.Effect<void, E, R>
  readonly env: (agent: AgentId) => Effect.Effect<void, E, R>
  readonly config: (input: ConfigInput) => Effect.Effect<void, E, R>
  readonly usage: (input: UsageInput) => Effect.Effect<void, E, R>
  readonly keyList: Effect.Effect<void, E, R>
  readonly keyAdd: (name: string, models: string) => Effect.Effect<void, E, R>
  readonly keyRemove: (name: string) => Effect.Effect<void, E, R>
  readonly logs: (input: LogsInput) => Effect.Effect<void, E, R>
  readonly notify: Effect.Effect<void, E, R>
  readonly dashboard: (print: boolean) => Effect.Effect<void, E, R>
  readonly doctor: (json: boolean) => Effect.Effect<void, E, R>
}

export const about = "One endpoint for Claude Code and Codex that pools every account you have, with failover"

const accountHelp = "Number from `slopmax status`, or the account's id, email, or label"

/** Agents by the program people run, or by their id. */
export const agentChoices: ReadonlyArray<readonly [string, AgentId]> = agentOrder.flatMap((id) => {
  const program = agentFacts[id].program
  return program === id ? [[id, id] as const] : [[program, id] as const, [id, id] as const]
})

/** Every provider an account can be added for, in the registry's order. */
export const providerChoices: ReadonlyArray<readonly [ProviderId, ProviderId]> = providerOrder.map(
  (id) => [id, id] as const,
)

const agentArgument = Argument.ChoiceWithValue("agent", agentChoices).pipe(
  Argument.withDescription(
    `Which agent: ${agentOrder.map((id) => `${agentFacts[id].program} (${agentFacts[id].title})`).join(", ")}`,
  ),
)

const accountArgument = Argument.String("account").pipe(Argument.withDescription(accountHelp))

/** A flag that is off unless given. */
const toggle = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false))

const jsonFlag = toggle("json").pipe(Flag.withDescription("Print machine-readable JSON"))

const onOff = [
  ["on", true],
  ["true", true],
  ["yes", true],
  ["off", false],
  ["false", false],
  ["no", false],
] as const

/** The tree over `actions`. */
export const makeCli = <E, R>(actions: Actions<E, R>) => {
  const setup = Command.make(
    "setup",
    {
      agent: agentArgument.pipe(
        Argument.withDescription("Wire just this agent to the proxy (else run the whole setup)"),
        Argument.optional,
      ),
      undo: toggle("undo").pipe(Flag.withDescription("With an agent: put back what its setup replaced")),
      yes: toggle("yes").pipe(
        Flag.withAlias("y"),
        Flag.withDescription("Ask nothing: take the flags, else the recommended answers"),
      ),
      import: Flag.String("import").pipe(
        Flag.withMetavar("sources"),
        Flag.withDescription("Take logins from claude-code, codex, cliproxyapi, all, or none"),
        Flag.optional,
      ),
      login: Flag.String("login").pipe(
        Flag.withMetavar("providers"),
        Flag.withDescription("Sign in to these subscriptions: claude, codex"),
        Flag.optional,
      ),
      keysFromEnv: toggle("keys-from-env").pipe(
        Flag.withDescription("Add the keys in ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY"),
      ),
      strategy: Flag.Literals("strategy", Strategy.literals).pipe(
        Flag.withDescription("How a new session picks its account"),
        Flag.optional,
      ),
      affinity: Flag.ChoiceWithValue("affinity", onOff).pipe(
        Flag.withMetavar("on|off"),
        Flag.withDescription("on: sessions keep their account; off: every request is placed afresh"),
        Flag.optional,
      ),
      agents: Flag.String("agents").pipe(
        Flag.withMetavar("agents"),
        Flag.withDescription("Point these agents at the proxy: claude, codex, or none"),
        Flag.optional,
      ),
      noService: toggle("no-service").pipe(Flag.withoutNegation, Flag.withDescription("Don't start slopmax at login")),
    },
    actions.setup,
  ).pipe(
    Command.withAlias("init"),
    Command.withDescription("Set everything up step by step, or point one agent at the proxy"),
  )

  const status = Command.make(
    "status",
    {
      refresh: toggle("refresh").pipe(
        Flag.withAlias("r"),
        Flag.withDescription("Read fresh usage from the providers first"),
      ),
      watch: toggle("watch").pipe(Flag.withAlias("w"), Flag.withDescription("Keep the display updated")),
      json: jsonFlag,
    },
    actions.status,
  ).pipe(Command.withAlias("ls"), Command.withDescription("Show accounts, usage windows, and when limits reset"))

  const login = Command.make(
    "login",
    {
      provider: Argument.ChoiceWithValue("provider", providerChoices).pipe(
        Argument.withDescription(
          `Which kind of account: ${providerOrder.map((id) => `${id} (${providerFacts[id].title})`).join(", ")}`,
        ),
      ),
      device: toggle("device").pipe(
        Flag.withDescription("Sign in with a code instead of a browser redirect (ChatGPT only)"),
      ),
      noBrowser: toggle("no-browser").pipe(
        Flag.withoutNegation,
        Flag.withDescription("Print the sign-in address instead of opening a browser"),
      ),
      label: Flag.String("label").pipe(Flag.withDescription("Display name for the account"), Flag.optional),
      url: Flag.String("url").pipe(
        Flag.withDescription("A compatible endpoint's base URL, e.g. http://localhost:11434/v1"),
        Flag.optional,
      ),
      dialect: Flag.Literals("dialect", DialectSchema.literals).pipe(
        Flag.withDescription("Its format: chat (the default), responses, or messages"),
        Flag.optional,
      ),
      models: Flag.String("models").pipe(
        Flag.withDescription("Models the endpoint serves, comma-separated (default: what it lists)"),
        Flag.optional,
      ),
    },
    (input): Effect.Effect<void, E, R> =>
      actions.login({
        ...input,
        dialect: input.dialect satisfies Option.Option<Dialect>,
      }),
  ).pipe(Command.withDescription("Connect an account: sign in, or enter an API key"))

  const importCommand = Command.make(
    "import",
    {
      source: Argument.Literals("source", ["all", "claude-code", "codex", "cliproxyapi"]).pipe(
        Argument.withDescription(
          "Where from: all, claude-code (its login or the macOS keychain), codex (~/.codex/auth.json), cliproxyapi (~/.cli-proxy-api)",
        ),
        Argument.withDefault("all" as const),
      ),
      own: toggle("own").pipe(
        Flag.withDescription("Refresh imported CLIProxyAPI logins here instead of following its files"),
      ),
    },
    actions.import,
  ).pipe(Command.withDescription("Copy existing logins from Claude Code, Codex, or CLIProxyAPI"))

  const own = Command.make(
    "own",
    { account: Argument.String("account").pipe(Argument.withDescription(`${accountHelp}, or \`all\``)) },
    ({ account }) => actions.own(account),
  ).pipe(Command.withDescription("Take over refreshing an account slopmax follows from another tool"))

  const use = Command.make(
    "use",
    { account: Argument.String("account").pipe(Argument.withDescription(`${accountHelp}, or \`auto\``)) },
    ({ account }) => actions.use(account),
  ).pipe(Command.withDescription("Prefer an account for new sessions, or `auto` to let slopmax choose"))

  const labelCommand = Command.make(
    "label",
    {
      account: accountArgument,
      label: Argument.String("label").pipe(
        Argument.withDescription("The new name; leave it out to show the email again"),
        Argument.optional,
      ),
    },
    ({ account, label }) => actions.label(account, label),
  ).pipe(Command.withDescription("Set or clear an account's display name"))

  const priorityCommand = Command.make(
    "priority",
    {
      account: accountArgument,
      priority: Argument.Int("priority").pipe(
        Argument.withDescription("Tier, 0 by default; higher tiers go first, negative ones are held in reserve"),
      ),
    },
    ({ account, priority }) => actions.priority(account, priority),
  ).pipe(Command.withDescription("Set an account's priority; higher tiers are used first"))

  const enable = Command.make("enable", { account: accountArgument }, ({ account }) => actions.enable(account)).pipe(
    Command.withDescription("Route to an account again"),
  )
  const disable = Command.make("disable", { account: accountArgument }, ({ account }) => actions.disable(account)).pipe(
    Command.withDescription("Stop routing to an account (its sign-in is still kept fresh)"),
  )
  const remove = Command.make("remove", { account: accountArgument }, ({ account }) => actions.remove(account)).pipe(
    Command.withDescription("Forget an account"),
  )

  const redeem = Command.make(
    "redeem",
    {
      account: accountArgument,
      reset: Argument.String("reset").pipe(
        Argument.withDescription("Which limit reset (the soonest to expire when left out)"),
        Argument.optional,
      ),
      yes: toggle("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Skip the confirmation")),
    },
    actions.redeem,
  ).pipe(Command.withDescription("Redeem a banked limit reset, starting a Claude or ChatGPT account's windows over"))

  const serve = Command.make(
    "serve",
    {
      log: Flag.String("log").pipe(
        Flag.withMetavar("file"),
        Flag.withDescription("Append the log to this file instead of writing it to stderr"),
        Flag.optional,
      ),
    },
    ({ log }) => actions.serve(log),
  ).pipe(Command.withDescription("Run the proxy in the foreground"))

  const start = Command.make("start", { json: jsonFlag }, ({ json }) => actions.start(json)).pipe(
    Command.withDescription("Start the proxy in the background"),
  )
  const stop = Command.make("stop", {}, () => actions.stop).pipe(Command.withDescription("Stop the background proxy"))

  const serviceStatus = Command.make("status", { json: jsonFlag }, ({ json }) => actions.service("status", json)).pipe(
    Command.withDescription("Show whether the service is installed and running"),
  )
  const service = Command.make("service", {}, () => actions.service("status", false)).pipe(
    Command.withDescription("Run the proxy as a service that starts at login"),
    Command.withSubcommands([
      Command.make("install", {}, () => actions.service("install", false)).pipe(
        Command.withDescription("Start slopmax at login (a systemd user unit or a launchd agent)"),
      ),
      Command.make("uninstall", {}, () => actions.service("uninstall", false)).pipe(
        Command.withDescription("Remove the service"),
      ),
      serviceStatus,
    ]),
  )

  const run = Command.make(
    "run",
    {
      agent: agentArgument,
      args: Argument.String("args").pipe(
        Argument.withDescription("Arguments passed to the agent as they are"),
        Argument.variadic(),
      ),
    },
    ({ agent, args }) => actions.run(agent, args),
  ).pipe(Command.withDescription("Launch an agent through the proxy, starting the proxy if needed"))

  const env = Command.make("env", { agent: agentArgument }, ({ agent }) => actions.env(agent)).pipe(
    Command.withDescription("Print shell setup that points an agent at the proxy, for `eval`"),
  )

  const config = Command.make(
    "config",
    {
      name: Argument.String("name").pipe(Argument.withDescription("The setting, e.g. strategy"), Argument.optional),
      value: Argument.String("value").pipe(
        Argument.withDescription("Its new value, e.g. round-robin, on, 30"),
        Argument.optional,
      ),
    },
    actions.config,
  ).pipe(Command.withDescription("Show the settings that change while the proxy runs, or change one"))

  const usage = Command.make(
    "usage",
    {
      range: Argument.Literals("range", SummaryRangeSchema.literals).pipe(
        Argument.withDescription("Which period: today, 7d (today and the 6 days before), 30d, or all"),
        Argument.withDefault<SummaryRange>("7d"),
      ),
      by: Flag.Literals("by", SummaryBySchema.literals).pipe(
        Flag.withAlias("b"),
        Flag.withDescription("Group by day, model, or account"),
        Flag.withDefault<SummaryBy>("day"),
      ),
      json: jsonFlag,
    },
    actions.usage,
  ).pipe(Command.withDescription("Show token usage and what it would cost at API prices"))

  const keyName = Argument.String("name").pipe(Argument.withDescription("The key's name"))
  const key = Command.make("key", {}, () => actions.keyList).pipe(
    Command.withDescription("Manage keys for other machines and tools"),
    Command.withSubcommands([
      Command.make("list", {}, () => actions.keyList).pipe(Command.withDescription("Show the keys")),
      Command.make(
        "add",
        {
          name: keyName,
          models: Flag.String("models").pipe(
            Flag.withDescription("Models it may use, comma-separated patterns (default: any)"),
            Flag.withDefault(""),
          ),
        },
        ({ name, models }) => actions.keyAdd(name, models),
      ).pipe(Command.withDescription("Make a key for another machine or tool")),
      Command.make("remove", { name: keyName }, ({ name }) => actions.keyRemove(name)).pipe(
        Command.withDescription("Revoke a key"),
      ),
    ]),
  )

  const logs = Command.make(
    "logs",
    {
      follow: toggle("follow").pipe(Flag.withAlias("f"), Flag.withDescription("Keep printing new lines")),
      lines: Flag.Int("lines").pipe(
        Flag.withAlias("n"),
        Flag.withDescription("How many lines to show first"),
        Flag.filter(
          (count) => count >= 0,
          () => "a count of 0 or more",
        ),
        Flag.withDefault(40),
      ),
    },
    actions.logs,
  ).pipe(Command.withDescription("Show the background proxy's log"))

  const notify = Command.make("notify", {}, () => actions.notify).pipe(
    Command.withDescription("Send a test notification"),
  )
  const dashboard = Command.make(
    "dashboard",
    { print: toggle("print").pipe(Flag.withDescription("Print its address instead of opening a browser")) },
    ({ print }) => actions.dashboard(print),
  ).pipe(Command.withDescription("Open the dashboard in a browser, starting the proxy if needed"))
  const doctor = Command.make("doctor", { json: jsonFlag }, ({ json }) => actions.doctor(json)).pipe(
    Command.withDescription("Check the setup and say how to fix problems"),
  )

  return Command.make("slopmax", {}, () => actions.bare).pipe(
    Command.withDescription(`${about}. Run without a command to see your accounts.`),
    Command.withSubcommands([
      setup,
      status,
      login,
      importCommand,
      own,
      use,
      labelCommand,
      priorityCommand,
      enable,
      disable,
      remove,
      redeem,
      serve,
      start,
      stop,
      service,
      run,
      env,
      config,
      usage,
      key,
      logs,
      notify,
      dashboard,
      doctor,
    ]),
  )
}

/**
 * The arguments as the parser should see them: everything after `run
 * <agent>` belongs to the agent, flags and all, so it goes after a `--`.
 */
export const argsFor = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [first, agent, ...rest] = argv
  if (first !== "run" || agent === undefined || agent.startsWith("-")) return argv
  return [first, agent, "--", ...rest]
}
