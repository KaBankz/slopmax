// `slopmax setup`: from nothing to a running proxy, step by step. It
// connects accounts (importing logins, signing in, or taking API keys),
// chooses how requests are routed, points the agents at the proxy, and
// starts it at login.
//
// Every question has a flag, so the same setup runs unattended
// (`--yes`): an agent asked to set slopmax up can do it without a
// terminal, and a server can be set up from a script.
import { isatty } from "node:tty"

import { Config as Env, Effect, Option, Result } from "effect"

import {
  Account,
  type account,
  agent,
  auth,
  background,
  Config,
  config as configs,
  error,
  Failure,
  import_ as imports,
  net,
  paths,
  ProviderId,
  provider,
  service,
  type Store,
  text,
  toml,
} from "@slopmax/core"

import * as term from "../term.ts"
import * as ui from "../ui.ts"
import { login } from "./accounts.ts"
import { anyhow } from "./background.ts"

/**
 * How the setup answers its questions: `Ask` on the terminal, except what
 * the flags already answer; `Defaults` never asks, taking the flags, else
 * the recommended defaults (`--yes`).
 */
export type Answers = "Ask" | "Defaults"

/** Asks a yes/no question; the recommended answer is `fallback`. */
const confirm = (answers: Answers, question: string, fallback: boolean) =>
  answers === "Defaults" ? Effect.succeed(fallback) : term.confirm(`  ${question}`, fallback)

/**
 * What the flags decided before the setup starts; what they leave open is
 * asked, or, with `--yes`, takes its default.
 */
export interface Plan {
  /** `--import`: where to take logins from. */
  readonly import: ReadonlyArray<imports.Source> | undefined
  /** `--login`: subscriptions to sign in to. */
  readonly login: ReadonlyArray<ProviderId> | undefined
  /**
   * `--keys-from-env`: add the API keys set in ANTHROPIC_API_KEY,
   * OPENAI_API_KEY, and XAI_API_KEY.
   */
  readonly keysFromEnv: boolean
  readonly strategy: configs.Strategy | undefined
  readonly affinity: boolean | undefined
  /** `--agents`: the agents to point at the proxy; none for an empty list. */
  readonly agents: ReadonlyArray<agent.Agent> | undefined
  /** `--no-service`: don't start slopmax at login. */
  readonly noService: boolean
}

export const Plan = {
  empty: (): Plan => ({
    import: undefined,
    login: undefined,
    keysFromEnv: false,
    strategy: undefined,
    affinity: undefined,
    agents: undefined,
    noService: false,
  }),
} as const

/** The environment variable each key provider's key is read from. */
const KEY_ENV: ReadonlyArray<readonly [ProviderId, string]> = [
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["xai", "XAI_API_KEY"],
]

// Each name of a list, or the first reason one is not one.
const each = <T>(list: string, read: (name: string) => Result.Result<T, Failure>): Result.Result<Array<T>, Failure> => {
  const out: Array<T> = []
  for (const name of names(list)) {
    const item = read(name)
    if (Result.isFailure(item)) return Result.fail(item.failure)
    out.push(item.success)
  }
  return Result.succeed(out)
}

/** `claude-code,codex` → sources; `none` → none. */
export const sources = (list: string): Result.Result<Array<imports.Source>, Failure> =>
  each(list, (name) => Result.mapError(imports.Source.parse(name), (message) => new Failure({ message })))

/** `claude,codex` → subscriptions to sign in to. */
export const subscriptions = (list: string): Result.Result<Array<ProviderId>, Failure> =>
  each(list, (name) => {
    const parsed = ProviderId.parse(name)
    if (Result.isFailure(parsed)) return Result.fail(new Failure({ message: parsed.failure }))
    if (!provider.Spec.isSubscription(ProviderId.spec(parsed.success))) {
      return Result.fail(
        new Failure({
          message: `--login signs in to subscriptions (claude, codex); add ${name} keys with --keys-from-env or \`slopmax login ${name}\``,
        }),
      )
    }
    return Result.succeed(parsed.success)
  })

/** `claude,codex` → agents; `none` → none. */
export const agents = (list: string): Result.Result<Array<agent.Agent>, Failure> =>
  each(list, (name) => {
    const found = agent.find(name)
    return found === undefined
      ? Result.fail(new Failure({ message: `unknown agent ${text.debug(name)}` }))
      : Result.succeed(found)
  })

const names = (list: string): Array<string> =>
  list
    .split(",")
    .map(text.trim)
    .filter((n) => n !== "" && n !== "none")

/** Whether stdin is a terminal, someone there to answer. */
export const stdinIsTerminal = (): boolean => isatty(0)

/**
 * Whether `slopmax` alone should start the setup: nothing set up yet and
 * someone at a terminal to answer.
 */
export const wanted = (store: Store): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!isatty(0) || !isatty(1)) return false
    const listed = yield* Effect.result(store.list())
    return Result.isSuccess(listed) && listed.success.length === 0
  })

const { fail } = error

export const run: (
  config: Config,
  store: Store,
  answers: Answers,
  plan: Plan,
) => Effect.Effect<void, Failure, term.Terminal> = Effect.fn("init.run")(function* (
  config: Config,
  store: Store,
  answers: Answers,
  plan: Plan,
) {
  yield* ui.println(
    `\n${ui.bold("slopmax setup")}\n${ui.dim("One local endpoint that spreads your agents across your accounts.")}`,
  )

  yield* step("Accounts")
  const missed = yield* accounts(store, answers, plan)
  const connected = yield* store.list()
  if (connected.length === 0) {
    // Unattended, finding nothing to pool is a failure the caller must
    // see; at a terminal, the person chose to add nothing yet.
    if (answers === "Defaults") {
      return yield* fail(
        "no accounts are connected, so there is nothing to proxy. Add one of:\n  " +
          "--import claude-code,codex   use the logins Claude Code and Codex have here\n  " +
          "--import cliproxyapi         use CLIProxyAPI's logins\n  " +
          "--login claude,codex         sign in (a device code for ChatGPT without a browser)\n  " +
          "--keys-from-env              add ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY",
      )
    }
    yield* ui.println(
      "\n  No accounts yet. Run `slopmax setup` again, or add one with `slopmax login claude`\n  or `slopmax login codex`.",
    )
    return
  }

  yield* step("Routing")
  const routed = yield* routing(config, answers, plan)

  yield* step("Agents")
  for (const one of agent.AGENTS) {
    const named = plan.agents === undefined ? undefined : plan.agents.some((a) => a.id === one.id)
    if (named === false) continue
    // An agent pointed at slopmax with nothing to serve its own models
    // stops working; unless asked for by name, it is left as it is.
    if (!agent.servable(one, connected)) {
      const title = ProviderId.spec(one.provider).title
      if (named === undefined) {
        yield* ui.println(
          `  ${one.title} left as it is: no ${title} account to serve it. \`slopmax setup ${one.id}\` wires it once there is one.`,
        )
        continue
      }
      yield* ui.println(`  ${ui.yellow("note:")} ${one.title} has no ${title} account to serve it yet.`)
    }
    yield* wire(routed, one, answers)
  }

  yield* step("Background")
  yield* backgroundStep(routed, answers, plan)

  const count = connected.length === 1 ? "1 account" : `${connected.length} accounts`
  yield* ui.println(
    `\n${ui.green("Done.")} ${count} behind ${ui.bold(Config.baseUrl(routed))}.\n` +
      "  Restart Claude Code, Codex, and the apps that run them. `slopmax` shows each\n" +
      "  account's usage, `slopmax dashboard` opens the dashboard, and `slopmax doctor`\n" +
      "  checks the setup.",
  )
  // Unattended, a part of the setup that was asked for and did nothing is
  // a failure the caller must see, though the rest went through.
  if (answers === "Defaults" && missed.length > 0) {
    return yield* fail(`set up, but not all that was asked: ${missed.join("; ")}`)
  }
})

const step = (title: string): Effect.Effect<void> => ui.println(`\n${ui.bold(title)}`)

/** What each provider is, for choosing which to add. */
const offer = (id: ProviderId): string => {
  switch (id) {
    case "claude":
      return "Claude Pro or Max, for Claude Code"
    case "codex":
      return "ChatGPT Plus, Pro, or Team, for Codex"
    case "anthropic":
      return "an Anthropic API key, billed per token"
    case "openai":
      return "an OpenAI API key, billed per token"
    case "xai":
      return "an xAI API key, for Grok models"
    case "compat":
      return "any OpenAI- or Anthropic-compatible endpoint"
  }
}

// An environment variable, when it is set.
const env = (name: string): Effect.Effect<string | undefined> =>
  Env.option(Env.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Connects what the plan asks for, or what is chosen at the terminal.
 * Returns what was asked for by flag and added nothing.
 */
const accounts = Effect.fn("init.accounts")(function* (store: Store, answers: Answers, plan: Plan) {
  const http = yield* auth.httpClient(new net.Origins())
  const missed: Array<string> = []
  if (plan.import !== undefined) {
    for (const source of plan.import) {
      const found = yield* imports.discover(http, source)
      if ((yield* reportSaved(yield* imports.save(store, found, false))) === 0) {
        missed.push(`--import ${source} found no login to take`)
      }
    }
  } else {
    yield* offerImports(store, answers, http)
  }

  if (plan.keysFromEnv) {
    for (const [id, variable] of KEY_ENV) {
      const key = yield* env(variable)
      if (key === undefined || text.trim(key) === "") continue
      const options: auth.LoginOptions = { ...auth.LoginOptions.default(), key: text.trim(key) }
      const connected = yield* Effect.result(
        Effect.scoped(Effect.flatMap(term.signIn, (prompt) => auth.connect(store, id, undefined, options, prompt))),
      )
      if (Result.isSuccess(connected)) {
        const [a] = connected.success
        yield* ui.println(`    ${ui.green("+")} ${ui.bold(Account.name(a))} ${ui.dim(`from ${variable}`)}`)
      } else {
        yield* ui.println(`    ${ui.yellow("skipped")} ${variable}: ${error.chain(connected.failure)}`)
        missed.push(`${variable} was not added`)
      }
    }
  }

  let chosen: ReadonlyArray<ProviderId>
  if (plan.login !== undefined) chosen = plan.login
  else if (answers === "Defaults") chosen = []
  else {
    const have = yield* store.list()
    const options = ProviderId.ALL.map((p) => [p, offer(p)] as const)
    // Subscriptions without an account yet are the usual start.
    const defaults = ProviderId.ALL.flatMap((p, i) =>
      provider.Spec.isSubscription(ProviderId.spec(p)) && !have.some((a) => a.provider === p) ? [i] : [],
    )
    yield* ui.println()
    const picked = yield* term.chooseMany("  Which accounts will slopmax pool?", options, defaults)
    chosen = picked.flatMap((i) => {
      const p = ProviderId.ALL[i]
      return p === undefined ? [] : [p]
    })
  }
  const asked = plan.login !== undefined
  for (const id of chosen) {
    if (!(yield* add(store, id, answers)) && asked) missed.push(`--login ${id} did not sign in`)
  }
  const now = yield* store.list()
  const counts: Array<string> = []
  for (const id of ProviderId.ALL) {
    const n = now.filter((a) => a.provider === id).length
    if (n > 0) counts.push(`${n} ${ProviderId.spec(id).title}`)
  }
  if (counts.length > 0) yield* ui.println(`  ${ui.dim("connected:")} ${counts.join(", ")}`)
  return missed
})

/**
 * Offers the logins found on this machine: CLIProxyAPI's (linked, so
 * both can run) and the agents' own.
 */
const offerImports = Effect.fn("init.offerImports")(function* (store: Store, answers: Answers, http: net.Client) {
  const cliproxy = yield* imports.discover(http, "cliproxyapi")
  const found = cliproxy.filter((f) => Result.isSuccess(f.account)).length
  if (found > 0) {
    yield* ui.println(
      `  CLIProxyAPI has ${found} account${found === 1 ? "" : "s"} here. slopmax can follow them while\n  ` +
        "CLIProxyAPI keeps refreshing, so nothing gets signed out.",
    )
    if (yield* confirm(answers, "Import them?", true)) yield* reportSaved(yield* imports.save(store, cliproxy, false))
  }
  for (const one of agent.AGENTS) {
    const hasAccounts = (yield* store.list()).some((a) => a.provider === one.provider)
    if (hasAccounts || !(yield* one.hasLogin)) continue
    const question = `Import ${one.title}'s own login? (Signing in fresh below avoids sharing its tokens.)`
    if (!(yield* confirm(answers, question, false))) continue
    const item = yield* one.import(http)
    if (item === undefined) continue
    if (Result.isSuccess(item.account)) {
      const [a] = yield* store.upsert(item.account.success)
      yield* ui.println(`    ${ui.green("+")} ${ui.bold(Account.name(a))}`)
    } else {
      yield* ui.println(`    ${ui.dim("skipped:")} ${error.chain(item.account.failure)}`)
    }
  }
})

/** Prints what was imported; returns how many accounts were. */
const reportSaved = (saved: ReadonlyArray<imports.Saved>): Effect.Effect<number> =>
  Effect.gen(function* () {
    let added = 0
    for (const item of saved) {
      if (Result.isSuccess(item.account)) {
        added += 1
        yield* ui.println(`    ${ui.green("+")} ${ui.bold(Account.name(item.account.success[0]))}`)
      } else {
        yield* ui.println(`    ${ui.dim("skipped:")} ${error.chain(item.account.failure)}`)
      }
    }
    return added
  })

/**
 * Signs in to `id`, or takes its key or endpoint; at a terminal, offers to
 * add another of a subscription. Returns whether any was added.
 */
const add = Effect.fn("init.add")(function* (store: Store, id: ProviderId, answers: Answers) {
  const spec = ProviderId.spec(id)
  let added = false
  for (;;) {
    yield* ui.println(`\n  ${ui.bold(spec.title)}`)
    let options = auth.LoginOptions.default()
    if (spec.credential._tag === "OAuth") {
      // On a machine without a browser, Codex signs in with a code and
      // Claude by pasting the final URL back.
      const headless = !(yield* auth.callback.hasBrowser)
      options = { ...options, device: headless && provider.Spec.deviceLogin(spec), noBrowser: headless }
    }
    if (id === "compat") {
      if (answers === "Defaults")
        return yield* fail("a compatible endpoint needs `slopmax login compat --url <base url>`")
      const url = yield* term.ask("  Base URL, e.g. http://localhost:11434/v1:", "")
      if (url === "") return added
      const given = yield* term.ask("  Its API: chat, responses, or messages", "chat")
      const dialect = given === "responses" ? "responses" : given === "messages" ? "messages" : "chat"
      const endpoint: account.Endpoint = { baseUrl: url.replace(/\/+$/, ""), dialect, models: [] }
      options = { ...options, endpoint }
    }
    const logged = yield* Effect.result(login(store, id, undefined, options))
    if (Result.isSuccess(logged)) added = true
    else yield* ui.println(`    ${ui.yellow("not added:")} ${error.chain(logged.failure)}`)
    const more =
      provider.Spec.isSubscription(spec) &&
      answers === "Ask" &&
      (yield* term.confirm(`  Add another ${spec.title} account?`, false))
    if (!more) return added
  }
})

/**
 * Chooses the strategy and session affinity, and writes them to the
 * config if they changed.
 */
const routing = Effect.fn("init.routing")(function* (config: Config, answers: Answers, plan: Plan) {
  let strategy: configs.Strategy
  if (plan.strategy !== undefined) strategy = plan.strategy
  else if (answers === "Defaults") strategy = config.strategy
  else {
    const options = configs.Strategy.ALL.map((s) => [s, configs.Strategy.summary(s)] as const)
    const current = Math.max(0, configs.Strategy.ALL.indexOf(config.strategy))
    const picked = yield* term.choose("  How should a new session pick its account?", options, current)
    strategy = configs.Strategy.ALL[picked] ?? config.strategy
  }
  const affinity =
    plan.affinity ??
    (yield* confirm(
      answers,
      "Keep each session on the account it started on, so its prompt cache stays warm?",
      config.sessionAffinity,
    ))
  yield* ui.println(
    `  ${ui.dim("routing:")} ${strategy}, ${affinity ? "sessions keep their account" : "every request placed afresh"}`,
  )
  if (strategy === config.strategy && affinity === config.sessionAffinity) return config
  const changed = yield* Config.set(yield* paths.configFile, [
    ["strategy", toml.Value.of(strategy)],
    ["session_affinity", toml.Value.of(affinity)],
  ])
  // The address may come from the environment, not the file.
  return { ...changed, listen: config.listen }
})

const wire = Effect.fn("init.wire")(function* (config: Config, one: agent.Agent, answers: Answers) {
  const wiring = yield* agent.wiring(one, config)
  let replacing = ""
  if (wiring._tag === "Slopmax") {
    yield* ui.println(`  ${one.title} already uses slopmax.`)
    return
  }
  if (wiring._tag === "Elsewhere") {
    replacing = ` (it uses ${wiring.target} now; \`slopmax setup ${one.id} --undo\` restores that)`
  }
  if (yield* confirm(answers, `Point ${one.title} at slopmax?${replacing}`, true)) {
    const file = yield* agent.setup(one, config)
    yield* ui.println(`    ${ui.green("wired")} ${ui.dim(file)}`)
    yield* ui.println(`    ${ui.dim(one.setupNote)}`)
  }
})

const backgroundStep = Effect.fn("init.background")(function* (config: Config, answers: Answers, plan: Plan) {
  if (yield* (yield* background.Daemon.make(config)).isRunning) {
    yield* ui.println(`  The proxy is running on ${Config.baseUrl(config)}.`)
  }
  const manager = yield* service.detect
  const installed = manager !== undefined && (yield* service.status(manager)).installed
  const exe = yield* background.currentExe
  if (manager === undefined) {
    yield* ui.println(
      `  ${ui.dim("No login service here: the proxy runs until it is stopped; `slopmax start` brings it back.")}`,
    )
  } else if (!installed && !plan.noService) {
    if (yield* confirm(answers, "Start slopmax at login?", true)) {
      const file = yield* background.installService(config, manager, exe).pipe(Effect.mapError(anyhow))
      yield* ui.println(`    ${ui.green("installed")} ${ui.dim(file)}`)
    }
  } else if (installed) {
    yield* ui.println("  slopmax starts at login.")
  }
  if (yield* background.ensureRunning(config, exe).pipe(Effect.mapError(anyhow))) {
    yield* ui.println(`  The proxy is running on ${Config.baseUrl(config)} ${ui.dim(`(log: ${yield* paths.logFile})`)}`)
  }
})
