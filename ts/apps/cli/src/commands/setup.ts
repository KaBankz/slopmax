// `slopmax setup`: everything step by step (accounts, routing, agents, the
// background proxy), asking at a terminal and taking the flags, else the
// recommended answers, when it cannot or is told not to (`--yes`). With an
// agent named, it wires just that agent to the proxy, or undoes that.
//
// Every flag list is checked before anything is touched, so a typo changes
// nothing. An unattended setup that could not do part of what it was asked
// finishes the rest and then fails, naming what it missed.
import {
  type Account,
  Accounts,
  Agents,
  agents,
  Background,
  Browser,
  Home,
  Importers,
  LoginUi,
  Providers,
  SettingsService,
} from "@slopmax/core"
import {
  agentFacts,
  type AgentId,
  agentOrder,
  Dialect,
  isSubscription,
  parseAgentId,
  parseProviderId,
  providerFacts,
  type ProviderId,
  providerOrder,
  signsInByDevice,
  Strategy,
  strategySummaries,
} from "@slopmax/domain"
import { Config, Effect, Layer, Option, Redacted, Result, Stream } from "effect"
import { CliFailure } from "../failure.ts"
import { plural, Print } from "../print.ts"
import { runningClient, syncRunning } from "../reach.ts"
import { type Choice, Prompter } from "../terminal.ts"
import { endpointUrl, loginUi, splitList } from "./accounts.ts"

export interface SetupInput {
  readonly agent: Option.Option<AgentId>
  readonly undo: boolean
  readonly yes: boolean
  readonly import: Option.Option<string>
  readonly login: Option.Option<string>
  readonly keysFromEnv: boolean
  readonly strategy: Option.Option<Strategy>
  readonly affinity: Option.Option<boolean>
  readonly agents: Option.Option<string>
  readonly noService: boolean
}

/** What each format a compatible endpoint can speak is, as the guided setup offers them. */
const dialectHelp = {
  chat: "OpenAI Chat Completions (most local servers)",
  responses: "OpenAI Responses",
  messages: "Anthropic Messages",
} as const satisfies Record<Dialect, string>

const dialectChoices: ReadonlyArray<Choice<Dialect>> = Dialect.literals.map((value) => ({
  value,
  title: value,
  help: dialectHelp[value],
}))

// ---------------------------------------------------------------------------
// Flag lists, checked before anything runs

/** A flag's list: split on commas, trimmed, without empty entries or `none` (alone it means nothing). */
export const flagList = (text: string): ReadonlyArray<string> => splitList(text).filter((item) => item !== "none")

type ImportSource = Exclude<Importers.Source, "all">

/** What the flags ask for, read and checked. */
export interface Plan {
  /** Sources to import from; none means `--import` was not given. */
  readonly import: Option.Option<ReadonlyArray<ImportSource>>
  readonly login: Option.Option<ReadonlyArray<ProviderId>>
  /** The agents to wire; none means every agent that can be served. */
  readonly agents: Option.Option<ReadonlyArray<AgentId>>
}

const sourceOrder: ReadonlyArray<ImportSource> = ["claude-code", "codex", "cliproxyapi"]

/** Every list flag read into what it names, or the first mistake in them. */
export const readPlan = (input: Pick<SetupInput, "import" | "login" | "agents">): Result.Result<Plan, string> => {
  const sources: Array<ImportSource> = []
  for (const name of Option.match(input.import, { onNone: () => [], onSome: flagList })) {
    if (name === "all") sources.push(...sourceOrder)
    else {
      const source = sourceOrder.find((known) => known === name)
      if (source === undefined) return Result.fail(`unknown source ${JSON.stringify(name)}`)
      sources.push(source)
    }
  }
  const providers: Array<ProviderId> = []
  for (const name of Option.match(input.login, { onNone: () => [], onSome: flagList })) {
    const parsed = parseProviderId(name)
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    if (!isSubscription(parsed.success)) {
      return Result.fail(
        `--login signs in to subscriptions (claude, codex); add ${name} keys with --keys-from-env or \`slopmax login ${name}\``,
      )
    }
    providers.push(parsed.success)
  }
  const wanted: Array<AgentId> = []
  for (const name of Option.match(input.agents, { onNone: () => [], onSome: flagList })) {
    const parsed = parseAgentId(name)
    if (Result.isFailure(parsed)) return Result.fail(`unknown agent ${JSON.stringify(name)}`)
    wanted.push(parsed.success)
  }
  return Result.succeed({
    import: Option.map(input.import, () => [...new Set(sources)]),
    login: Option.map(input.login, () => [...new Set(providers)]),
    agents: Option.map(input.agents, () => [...new Set(wanted)]),
  })
}

// ---------------------------------------------------------------------------
// One agent

const setupOne = Effect.fn("cli.setup.agent")(function* (agent: AgentId, undo: boolean) {
  const print = yield* Print
  const { dim, yellow } = print.paint
  const facts = agentFacts[agent]
  if (undo) {
    const { path } = yield* Agents.disconnect(agent)
    yield* print.out(`Restored ${facts.title} ${dim(`(${path})`)}`)
    return
  }
  const { path, note } = yield* Agents.connect(agent)
  yield* print.out(`${facts.title} now uses slopmax ${dim(`(${path})`)}`)
  yield* print.out(dim(note))
  if (!Agents.servable(facts, yield* (yield* Accounts).list)) {
    const provider = providerFacts[facts.provider]
    yield* print.out(
      `${yellow("Note:")} no ${provider.title} account is connected to serve it; until one is, its requests fail. Add one with \`slopmax login ${facts.provider}\`, or undo with \`--undo\`.`,
    )
  }
  const running = Option.isSome(yield* runningClient)
  yield* print.out(
    dim(
      running
        ? "Undo with `--undo`."
        : "Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`.",
    ),
  )
})

// ---------------------------------------------------------------------------
// The whole setup

/** How each kind of account is offered when asking which to pool. */
const offered: { readonly [K in ProviderId]: string } = {
  claude: "Claude Pro or Max, for Claude Code",
  codex: "ChatGPT Plus, Pro, or Team, for Codex",
  anthropic: "an Anthropic API key, billed per token",
  openai: "an OpenAI API key, billed per token",
  xai: "an xAI API key, for Grok models",
  compat: "any OpenAI- or Anthropic-compatible endpoint",
}

/** The keys `--keys-from-env` reads, in order. */
const envKeys: ReadonlyArray<readonly [string, ProviderId]> = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["XAI_API_KEY", "xai"],
]

/** A sign-in that needs nobody: keys are checked with their provider, and nothing opens or is pasted. */
const quietLogin = Layer.succeed(LoginUi)({ tell: () => Effect.void, pasted: Stream.empty, openBrowser: false })

const noAccounts = [
  "no accounts are connected, so there is nothing to proxy. Add one of:",
  "  --import claude-code,codex   the logins Claude Code and Codex already have",
  "  --import cliproxyapi         CLIProxyAPI's logins, which slopmax follows",
  "  --login claude,codex         sign in to the subscriptions here",
  "  --keys-from-env              the keys in ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY",
].join("\n")

/** The agent whose own login an import source reads. */
const agentSource: { readonly [K in AgentId]: ImportSource } = { "claude-code": "claude-code", codex: "codex" }

export const setup = Effect.fn("cli.setup")(function* (input: SetupInput) {
  if (Option.isSome(input.agent)) return yield* setupOne(input.agent.value, input.undo)
  if (input.undo) return yield* new CliFailure({ message: "--undo restores one agent: `slopmax setup claude --undo`" })
  const planned = readPlan(input)
  if (Result.isFailure(planned)) return yield* new CliFailure({ message: planned.failure })
  const plan = planned.success

  const print = yield* Print
  const prompter = yield* Prompter
  const accounts = yield* Accounts
  const settings = yield* SettingsService
  const background = yield* Background
  const { bold, dim, green, yellow } = print.paint
  const ask = !input.yes && prompter.interactive
  const confirm = (question: string, initial: boolean) =>
    ask ? prompter.confirm(question, initial) : Effect.succeed(initial)
  const missed: Array<string> = []

  yield* print.out()
  yield* print.out(bold("slopmax setup"))
  yield* print.out(dim("One local endpoint that spreads your agents across your accounts."))
  const step = (title: string) => Effect.andThen(print.out(), print.out(bold(title)))

  // --- Accounts ----------------------------------------------------------

  yield* step("Accounts")
  /** Imports what `source` has, printing each; how many were saved. */
  const importFrom = (source: ImportSource) =>
    Effect.gen(function* () {
      const saved = yield* Importers.save(yield* Importers.discover(source), false)
      let count = 0
      for (const item of saved) {
        if (Result.isSuccess(item.account)) {
          count += 1
          yield* print.out(`    ${green("+")} ${bold(item.account.success.account.name)}`)
        } else {
          yield* print.out(`    ${dim("skipped:")} ${item.account.failure.message}`)
        }
      }
      return count
    })

  if (Option.isSome(plan.import)) {
    for (const source of plan.import.value) {
      if ((yield* importFrom(source)) === 0) missed.push(`--import ${source} found no login to take`)
    }
  } else {
    const linked = yield* Importers.discover("cliproxyapi")
    if (linked.length > 0) {
      yield* print.out(
        `  CLIProxyAPI has ${plural(linked.length, "account")} here. slopmax can follow them while\n  CLIProxyAPI keeps refreshing, so nothing gets signed out.`,
      )
      if (yield* confirm("  Import them?", true)) yield* importFrom("cliproxyapi")
    }
    // Only asked at a terminal: the answer would be no, and looking for a login can mean the keychain.
    if (ask) {
      for (const id of agentOrder) {
        const facts = agentFacts[id]
        const have = yield* accounts.list
        if (have.some((account) => account.provider === facts.provider)) continue
        if ((yield* Importers.discover(agentSource[id])).length === 0) continue
        const question = `  Import ${facts.title}'s own login? (Signing in fresh below avoids sharing its tokens.)`
        if (yield* confirm(question, false)) yield* importFrom(agentSource[id])
      }
    }
  }

  if (input.keysFromEnv) {
    for (const [variable, provider] of envKeys) {
      const value = yield* Config.option(Config.String(variable)).pipe(Effect.orElseSucceed(() => Option.none()))
      if (Option.isNone(value) || value.value.trim() === "") continue
      const added = yield* Providers.signIn(provider, { key: Redacted.make(value.value.trim()) }).pipe(
        Effect.provide(quietLogin),
        Effect.result,
      )
      if (Result.isSuccess(added)) {
        yield* print.out(`    ${green("+")} ${bold(added.success.account.name)} ${dim(`from ${variable}`)}`)
      } else {
        yield* print.out(`    ${yellow("skipped")} ${variable}: ${added.failure.message}`)
        missed.push(`${variable} was not added`)
      }
    }
  }

  const machine = yield* Browser.desktop
  const headless = !Browser.hasBrowser(machine)
  /** Adds one account of `provider`, saying how it went; whether it was added. */
  const addOne = (provider: ProviderId) =>
    Effect.gen(function* () {
      const facts = providerFacts[provider]
      // Keys and endpoints are only offered when someone is asked; unattended, `--login` takes subscriptions only.
      if (facts.signIn === "endpoint") {
        const url = yield* prompter.text("  Base URL, e.g. http://localhost:11434/v1:")
        if (url === "") return false
        const base = endpointUrl(url)
        if (Result.isFailure(base)) return yield* new CliFailure({ message: base.failure })
        const dialect = yield* prompter.choose("  Its API:", dialectChoices, "chat")
        const key = yield* prompter.secret("  API key (leave empty if it needs none)")
        yield* Providers.signIn(provider, {
          endpoint: { baseUrl: base.success, dialect, models: [] },
          ...(key === "" ? {} : { key: Redacted.make(key) }),
        }).pipe(Effect.provide(quietLogin))
        return true
      }
      if (facts.signIn === "key") {
        const key = yield* prompter.secret(`  ${facts.title} key`)
        yield* Providers.signIn(provider, { key: Redacted.make(key) }).pipe(Effect.provide(quietLogin))
        return true
      }
      const device = headless && signsInByDevice(provider)
      yield* Providers.signIn(provider, { device }).pipe(Effect.provide(loginUi(!headless)))
      return true
    }).pipe(Effect.catch((error) => Effect.as(print.out(`    ${yellow("not added:")} ${error.message}`), false)))

  const have = yield* accounts.list
  const signIns = Option.isSome(plan.login)
    ? plan.login.value
    : !ask
      ? []
      : yield* prompter.chooseMany(
          "  Which accounts will slopmax pool?",
          providerOrder.map((provider) => ({ value: provider, title: provider, help: offered[provider] })),
          providerOrder.filter(
            (provider) => isSubscription(provider) && !have.some((account) => account.provider === provider),
          ),
        )
  for (const provider of signIns) {
    const facts = providerFacts[provider]
    yield* print.out()
    yield* print.out(`  ${bold(facts.title)}`)
    let added = yield* addOne(provider)
    if (!added && Option.isSome(plan.login)) missed.push(`--login ${provider} did not sign in`)
    if (ask && isSubscription(provider)) {
      while (added && (yield* prompter.confirm(`  Add another ${facts.title} account?`, false))) {
        added = yield* addOne(provider)
      }
    }
  }

  const connected = yield* accounts.list
  if (connected.length === 0) {
    if (!ask) return yield* new CliFailure({ message: noAccounts })
    yield* print.out()
    yield* print.out("  No accounts yet. Run `slopmax setup` again, or add one with `slopmax login claude`")
    yield* print.out("  or `slopmax login codex`.")
    return
  }
  const counts = providerOrder
    .map((provider) => [provider, connected.filter((account) => account.provider === provider).length] as const)
    .filter(([, count]) => count > 0)
    .map(([provider, count]) => `${count} ${providerFacts[provider].title}`)
  yield* print.out(`  ${dim("connected:")} ${counts.join(", ")}`)

  // --- Routing -----------------------------------------------------------

  yield* step("Routing")
  const current = yield* settings.get
  const strategy = Option.isSome(input.strategy)
    ? input.strategy.value
    : !ask
      ? current.strategy
      : yield* prompter.choose(
          "  How should a new session pick its account?",
          Strategy.literals.map((id) => ({ value: id, title: id, help: strategySummaries[id] })),
          current.strategy,
        )
  const affinity = Option.isSome(input.affinity)
    ? input.affinity.value
    : !ask
      ? current.sessionAffinity
      : yield* prompter.confirm(
          "  Keep each session on the account it started on, so its prompt cache stays warm?",
          current.sessionAffinity,
        )
  if (strategy !== current.strategy || affinity !== current.sessionAffinity) {
    yield* settings.setLive({ strategy, sessionAffinity: affinity })
  }
  yield* print.out(
    `  ${dim("routing:")} ${strategy}, ${affinity ? "sessions keep their account" : "every request placed afresh"}`,
  )

  // --- Agents ------------------------------------------------------------

  yield* step("Agents")
  for (const id of agentOrder) {
    const facts = agentFacts[id]
    const named = Option.isSome(plan.agents) && plan.agents.value.includes(id)
    if (Option.isSome(plan.agents) && !named) continue
    const provider = providerFacts[facts.provider]
    if (!Agents.servable(facts, connected)) {
      if (!named) {
        yield* print.out(
          `  ${facts.title} left as it is: no ${provider.title} account to serve it. \`slopmax setup ${facts.program}\` wires it once there is one.`,
        )
        continue
      }
      yield* print.out(`  ${yellow("note:")} ${facts.title} has no ${provider.title} account to serve it yet.`)
    }
    const wiring = yield* Agents.wiring(id)
    if (wiring.wired) {
      yield* print.out(`  ${facts.title} already uses slopmax.`)
      continue
    }
    const elsewhere =
      wiring.wiredTo === undefined
        ? ""
        : ` (it uses ${wiring.wiredTo} now; \`slopmax setup ${facts.program} --undo\` restores that)`
    if (!(yield* confirm(`  Point ${facts.title} at slopmax?${elsewhere}`, true))) continue
    const done = yield* Agents.connect(id)
    yield* print.out(`    ${green("wired")} ${dim(done.path)}`)
    yield* print.out(`    ${dim(agents[id].note)}`)
  }

  // --- Background --------------------------------------------------------

  yield* step("Background")
  const base = background.baseUrl
  if (Option.isSome(yield* background.running)) {
    yield* print.out(`  The proxy is running on ${base}.`)
    yield* syncRunning
  }
  const manager = background.service
  if (Option.isNone(yield* manager.kind)) {
    yield* print.out(
      `  ${dim("No login service here: the proxy runs until it is stopped; `slopmax start` brings it back.")}`,
    )
  } else if ((yield* manager.status).installed) {
    yield* print.out("  slopmax starts at login.")
  } else if (!input.noService && (yield* confirm("  Start slopmax at login?", true))) {
    const file = yield* manager.install
    yield* print.out(`    ${green("installed")} ${dim(file)}`)
  }
  const { started } = yield* background.ensure
  if (started) {
    yield* print.out(`  The proxy is running on ${base} ${dim(`(log: ${(yield* Home).paths.log})`)}`)
  }

  yield* print.out()
  yield* print.out(`${green("Done.")} ${plural(connected.length, "account")} behind ${bold(base)}.`)
  yield* print.out("  Restart Claude Code, Codex, and the apps that run them. `slopmax` shows each")
  yield* print.out("  account's usage, `slopmax dashboard` opens the dashboard, and `slopmax doctor`")
  yield* print.out("  checks the setup.")
  if (!ask && missed.length > 0) {
    return yield* new CliFailure({ message: `set up, but not all that was asked: ${missed.join("; ")}` })
  }
})

/** For the guided setup on a bare `slopmax`: whether there are no accounts yet. */
export const noAccountsYet: Effect.Effect<boolean, never, Accounts> = Effect.map(
  Effect.flatMap(Accounts, (accounts) => accounts.list),
  (list: ReadonlyArray<Account>) => list.length === 0,
)
