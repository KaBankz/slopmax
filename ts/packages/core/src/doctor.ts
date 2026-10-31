// `slopmax doctor`: what is wrong with this setup, and what to run to fix it.
//
// Each section is one small check, and they all run at once: the proxy and
// its login service, the accounts, each agent's wiring, the CLIProxyAPI
// logins slopmax follows, the network, and the files' permissions. A last
// pass over the results looks at agents nothing can serve: an agent wired
// to slopmax with no account to serve it fails every request, so that is
// said plainly and the fixes start with signing in. Findings never quote a
// key or a token.
import {
  Finding,
  type Level,
  parseHttpDate,
  providerFacts,
  providerOrder,
  Section,
  slopmaxVersion,
} from "@slopmax/domain"
import { duration } from "@slopmax/domain/format"
import { Config, DateTime, Duration, Effect, FileSystem, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { Accounts, type Account } from "./accounts.ts"
import { type Agent, onPath, realPath, servable, wireSettings, wiresToSlopmax } from "./agents/agent.ts"
import { agentList } from "./agents/index.ts"
import { Background } from "./background.ts"
import { causeText, Home } from "./home.ts"
import { accepts, portHolder, portTaken } from "./port-holder.ts"
import { SettingsService } from "./settings.ts"
import { isLoopback, Upstream } from "./upstream.ts"

/** The port CLIProxyAPI listens on by default. */
export const cliProxyApiPort = 8317

/** A provider endpoint the network check calls; any HTTP answer counts as reachable. */
export interface Reach {
  readonly name: string
  readonly url: string
}

export const defaultReach: ReadonlyArray<Reach> = [
  { name: "Anthropic", url: "https://api.anthropic.com/api/hello" },
  { name: "ChatGPT", url: "https://chatgpt.com/backend-api/wham/usage" },
]

export interface DoctorOptions {
  /** Where CLIProxyAPI is looked for; tests give a throwaway port. */
  readonly cliProxyApiPort?: number | undefined
  /** What the network check calls. */
  readonly reach?: ReadonlyArray<Reach> | undefined
  /** The system, for the checks that differ by platform. */
  readonly platform?: NodeJS.Platform | undefined
}

export type DoctorServices =
  | SettingsService
  | Accounts
  | Background
  | Home
  | Upstream
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner

const finding = (level: Level, text: string, fix?: string): Finding =>
  new Finding({ level, text, ...(fix === undefined ? {} : { fix }) })

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** `host` and `port` of a `host:port` address, the host without IPv6 brackets. */
export const splitListen = (listen: string): { readonly host: string; readonly port: number } => {
  const colon = listen.lastIndexOf(":")
  const host = listen.slice(0, Math.max(colon, 0))
  return {
    host: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
    port: Number(listen.slice(colon + 1)),
  }
}

// --- Proxy ------------------------------------------------------------------

const proxyCheck = Effect.gen(function* () {
  const settingsService = yield* SettingsService
  const background = yield* Background
  const settings = yield* settingsService.get
  const baseUrl = yield* settingsService.baseUrl
  const listen = settingsService.running.listen
  const { host, port } = splitListen(listen)
  const findings: Array<Finding> = []

  const running = yield* background.running
  if (Option.isSome(running)) {
    const version = running.value.version
    findings.push(
      version === slopmaxVersion
        ? finding("ok", `running on ${baseUrl}`)
        : finding(
            "warn",
            `running version ${version}, but this binary is ${slopmaxVersion}`,
            "slopmax stop && slopmax start",
          ),
    )
  } else if (yield* portTaken(host, port)) {
    const holder = Option.getOrElse(yield* portHolder(port), () => "another program")
    findings.push(finding("fail", `port ${port} is taken by ${holder}`, "set `listen` in config.json to a free port"))
  } else {
    findings.push(finding("warn", "not running", "slopmax start (or `slopmax service install` to start at login)"))
  }

  if (!isLoopback(host)) {
    findings.push(
      finding(
        "info",
        `listens beyond this machine on ${listen}: anyone who can reach it with the key (${plural(settings.keys.length, "client key")} besides apiKey) can use your accounts`,
        "give other machines their own keys with `slopmax key add <name>`",
      ),
    )
  }

  const service = background.service
  if (Option.isSome(yield* service.kind)) {
    const status = yield* service.status
    if (!status.installed) findings.push(finding("info", "not installed as a service", "slopmax service install"))
    else if (status.running) findings.push(finding("ok", "runs as a login service"))
    else findings.push(finding("warn", "the service is installed but not running", "slopmax start"))
    if (status.installed && Option.contains(status.lingering, false)) {
      findings.push(finding("info", "the service stops when you log out", "loginctl enable-linger $USER"))
    }
  }
  return new Section({ title: "Proxy", findings })
})

// --- Accounts ---------------------------------------------------------------

const toolName = (tool: string) => (tool === "cliproxyapi" ? "CLIProxyAPI" : tool)

const accountFindings = (account: Account, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const name = account.name
    const findings: Array<Finding> = []
    const credential = account.credential
    if (account.authError !== undefined) {
      findings.push(
        finding("fail", `${name} needs a new login (${account.authError})`, `slopmax login ${account.provider}`),
      )
    } else if (credential._tag === "OAuth" && credential.follows !== undefined) {
      const { tool, path } = credential.follows
      const there = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      if (!there) {
        findings.push(
          finding("warn", `${name} follows ${toolName(tool)}, but ${path} is gone`, `slopmax own ${account.id}`),
        )
      } else if (credential.tokens.isExpired(now)) {
        findings.push(
          finding(
            "warn",
            `${name}'s token expired and ${toolName(tool)} has not refreshed it`,
            `start ${toolName(tool)} again, or slopmax own ${account.id}`,
          ),
        )
      }
    }
    if (account.disabled) findings.push(finding("info", `${name} is disabled`))
    return findings
  })

const accountsCheck = Effect.fn("doctor.accounts")(function* (accounts: ReadonlyArray<Account>) {
  if (accounts.length === 0) {
    return new Section({
      title: "Accounts",
      findings: [
        finding("fail", "no accounts connected", "slopmax login claude, slopmax login codex, or slopmax import"),
      ],
    })
  }
  const counts = providerOrder
    .map((id) => [id, accounts.filter((account) => account.provider === id).length] as const)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => plural(count, `${providerFacts[id].title} account`))
  const now = yield* DateTime.now
  const problems = yield* Effect.forEach(accounts, (account) => accountFindings(account, now))
  return new Section({ title: "Accounts", findings: [finding("ok", counts.join(", ")), ...problems.flat()] })
})

// --- Agents -----------------------------------------------------------------

/** One agent's section, with what the last pass needs: the agent, and whether its settings send it to slopmax. */
export interface AgentReport {
  readonly agent: Agent
  readonly wired: boolean
  readonly section: Section
}

/** An API key in the shell wins over the token the proxy hands Claude Code. */
const envKey = Config.String("ANTHROPIC_API_KEY")

const agentCheck = Effect.fn("doctor.agent")(function* (agent: Agent) {
  const home = yield* Home
  const settings = yield* wireSettings
  const path = yield* realPath(agent.configFile(home.paths))
  const doc = yield* home.readText(path).pipe(Effect.orElseSucceed(() => Option.none<string>()))
  const findings: Array<Finding> = []
  if (!(yield* onPath(agent.program))) findings.push(finding("info", `\`${agent.program}\` is not on PATH`))
  findings.push(...agent.inspect(doc, settings))
  if (agent.provider === "claude") {
    const key = yield* Config.option(envKey).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    if (Option.isSome(key) && key.value !== "") {
      findings.push(
        finding(
          "warn",
          "ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key",
          "unset ANTHROPIC_API_KEY",
        ),
      )
    }
  }
  const target = agent.wiredTo(doc)
  return {
    agent,
    wired: target !== undefined && wiresToSlopmax(target, settings.baseUrl),
    section: new Section({ title: agent.title, findings }),
  }
})

// --- CLIProxyAPI ------------------------------------------------------------

const cliProxyApiCheck = (port: number, accounts: ReadonlyArray<Account>) =>
  Effect.gen(function* () {
    const following = accounts.filter(
      (account) => account.credential._tag === "OAuth" && account.credential.follows?.tool === "cliproxyapi",
    ).length
    if (following === 0) return new Section({ title: "CLIProxyAPI", findings: [] })
    // Connects only: the port belongs to CLIProxyAPI, and slopmax never listens on it.
    const up = yield* accepts("127.0.0.1", port, Duration.millis(300))
    const accountsText = plural(following, "account")
    return new Section({
      title: "CLIProxyAPI",
      findings: [
        up
          ? finding(
              "info",
              `still running and refreshing ${accountsText} slopmax follows`,
              "once you stop CLIProxyAPI: slopmax own all",
            )
          : finding("warn", `not running, so nothing refreshes the ${accountsText} slopmax follows`, "slopmax own all"),
      ],
    })
  })

// --- Network ----------------------------------------------------------------

/** How long each provider gets to answer. */
const reachWait = Duration.seconds(10)

/** How far the clock may be off before it matters: token expiry and limit resets are judged by it. */
const skewLimit = Duration.minutes(1)

const networkCheck = (reach: ReadonlyArray<Reach>) =>
  Effect.gen(function* () {
    const upstream = yield* Upstream
    const answers = yield* Effect.forEach(
      reach,
      (target) =>
        upstream.http.get(target.url).pipe(
          Effect.timeout(reachWait),
          Effect.map((response) => response.headers["date"]),
          Effect.result,
          Effect.map((result) => ({ target, result })),
        ),
      { concurrency: "unbounded" },
    )
    const findings = answers.map(({ target, result }) =>
      result._tag === "Success"
        ? finding("ok", `${target.name} is reachable`)
        : finding(
            "fail",
            `cannot reach ${target.name}: ${causeText(result.failure)}`,
            "check the network, or set HTTPS_PROXY",
          ),
    )
    // The first answer that carries a date tells how far off this clock is.
    const dated = answers.flatMap(({ result }) =>
      result._tag === "Success" && result.success !== undefined ? [result.success] : [],
    )[0]
    const theirs = dated === undefined ? Option.none() : parseHttpDate(dated)
    if (Option.isSome(theirs)) {
      const now = yield* DateTime.now
      const off = Duration.abs(DateTime.distance(now, theirs.value))
      if (Duration.isGreaterThan(off, skewLimit)) {
        findings.push(
          finding(
            "warn",
            `the system clock is off by ${duration(off)}`,
            "enable time sync (e.g. `timedatectl set-ntp true`)",
          ),
        )
      }
    }
    return new Section({ title: "Network", findings })
  })

// --- Files ------------------------------------------------------------------

/** Group or other permission bits. */
const shared = (mode: number) => (mode & 0o077) !== 0

const filesCheck = (platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    if (platform === "win32") return new Section({ title: "Files", findings: [] })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = (yield* Home).paths.accounts
    const findings: Array<Finding> = []
    const info = yield* fs.stat(dir).pipe(Effect.option)
    if (Option.isNone(info)) return new Section({ title: "Files", findings })
    if (shared(info.value.mode)) findings.push(finding("warn", `${dir} is readable by other users`, `chmod 700 ${dir}`))
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []))
    const modes = yield* Effect.forEach(names, (name) =>
      fs.stat(path.join(dir, name)).pipe(
        Effect.map((entry) => entry.mode),
        Effect.orElseSucceed(() => 0),
      ),
    )
    const open = modes.filter(shared).length
    if (open > 0) {
      findings.push(
        finding(
          "warn",
          open === 1
            ? "1 account file is readable by other users"
            : `${open} account files are readable by other users`,
          `chmod 600 ${dir}/*`,
        ),
      )
    }
    return new Section({ title: "Files", findings })
  })

// --- The unserved-agent pass ---------------------------------------------------

/**
 * An agent's section, judged against the accounts. One nothing can serve
 * has its setup fix start with signing in, and gets a failure when it is
 * already wired to slopmax, since its every request would fail.
 */
export const unserved = (
  report: AgentReport,
  accounts: ReadonlyArray<{ readonly provider: Account["provider"] }>,
): Section => {
  const { agent, section } = report
  if (servable(agent, accounts)) return section
  const provider = agent.provider
  const setupFix = `slopmax setup ${agent.program}`
  const findings = section.findings.map((found) =>
    found.fix === setupFix ? new Finding({ ...found, fix: `slopmax login ${provider}, then ${setupFix}` }) : found,
  )
  if (report.wired) {
    findings.push(
      finding(
        "fail",
        `points at slopmax, but no ${providerFacts[provider].title} account is connected to serve it`,
        `slopmax login ${provider}, or \`${setupFix} --undo\``,
      ),
    )
  }
  return new Section({ title: section.title, findings })
}

// --- All together -------------------------------------------------------------

/** Every check, in the order people read them; sections with nothing to say are left out. */
export const doctor = Effect.fn("doctor")(function* (
  options: DoctorOptions = {},
): Effect.fn.Return<ReadonlyArray<Section>, never, DoctorServices> {
  const accounts = yield* (yield* Accounts).list
  const [proxy, accountsSection, agentReports, cliProxyApi, network, files] = yield* Effect.all(
    [
      proxyCheck,
      accountsCheck(accounts),
      Effect.forEach(agentList, agentCheck, { concurrency: "unbounded" }),
      cliProxyApiCheck(options.cliProxyApiPort ?? cliProxyApiPort, accounts),
      networkCheck(options.reach ?? defaultReach),
      filesCheck(options.platform ?? process.platform),
    ],
    { concurrency: "unbounded" },
  )
  return [
    proxy,
    accountsSection,
    ...agentReports.map((report) => unserved(report, accounts)),
    cliProxyApi,
    network,
    files,
  ].filter((section) => section.findings.length > 0)
})
