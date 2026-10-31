// What every agent is, and the work around the pure edits each one makes.
//
// An agent is a value: how to recognise its requests and name their
// session, how to launch it through the proxy, the shell lines that wire a
// shell to the proxy, and how to wire its own settings file and unwire it
// again. Those edits are text in, text out, so they are tested without a
// disk. This file adds what touches the disk: settings files behind
// symlinks are edited where they really live, every write is private
// (the files now hold slopmax's key), and what a setup replaced is kept in
// `backups.json` so it can be undone. The first setup's backup is the one
// kept, so running setup twice never loses what was there before slopmax.
import {
  type AgentFacts,
  agentFacts,
  type AgentId,
  AgentWiring,
  type Finding,
  providerFacts,
  ProviderId,
} from "@slopmax/domain"
import { scan } from "@slopmax/wire"
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Redacted,
  type Result,
  Schema,
  type Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Home, type Paths } from "../home.ts"
import { Lock } from "../lock.ts"
import { SpawnFailed } from "../service.ts"
import { SettingsService } from "../settings.ts"

/** What an agent is pointed at: the proxy's address, the owner key, and whether Codex may use WebSockets. */
export interface WireSettings {
  readonly baseUrl: string
  readonly apiKey: string
  readonly websockets: boolean
}

/** The running settings, as agents are wired with them. */
export const wireSettings: Effect.Effect<WireSettings, never, SettingsService> = Effect.gen(function* () {
  const settings = yield* SettingsService
  const current = yield* settings.get
  return {
    baseUrl: yield* settings.baseUrl,
    apiKey: Redacted.value(current.apiKey),
    websockets: current.websockets,
  }
})

/** A program to start: its name, its arguments, and the environment to add (undefined removes a variable). */
export interface Launch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
}

/** A settings file after setup, and what the setup replaced in it. */
export interface Wired {
  readonly text: string
  /** What to put back on undo, as JSON. */
  readonly backup: unknown
}

/** What a setup needs to know beyond the file itself. */
export interface SetupFacts {
  /** Whether the agent is signed in with its own login, which some agents keep showing beside the proxy. */
  readonly signedIn: boolean
}

/** One of the coding agents slopmax serves. */
export interface Agent extends AgentFacts {
  /** Whether a request comes from this agent, from the headers it always sends. */
  readonly detect: (headers: Headers) => boolean
  /** The conversation a request belongs to, so it stays on one account: from the headers, then a peek at the body. */
  readonly session: (headers: Headers, body: Uint8Array) => string | undefined
  /** The agent started through the proxy for one run, with `args` passed along. */
  readonly launch: (settings: WireSettings, args: ReadonlyArray<string>) => Launch
  /** Shell lines that wire the current shell to the proxy. `self` is how this slopmax is started. */
  readonly shell: (settings: WireSettings, self: ReadonlyArray<string>) => string
  /** The settings file setup edits. */
  readonly configFile: (paths: Paths) => string
  /** Points the settings file (none when it does not exist yet) at the proxy. Fails with why it cannot. */
  readonly setup: (
    doc: Option.Option<string>,
    settings: WireSettings,
    facts: SetupFacts,
  ) => Result.Result<Wired, string>
  /** Puts back what a setup replaced. */
  readonly undo: (doc: Option.Option<string>, backup: unknown) => Result.Result<string, string>
  /** Where the settings file sends the agent, when that is anywhere but its own provider. */
  readonly wiredTo: (doc: Option.Option<string>) => string | undefined
  /** What the doctor says about the settings file, judged against this proxy. */
  readonly inspect: (doc: Option.Option<string>, settings: WireSettings) => ReadonlyArray<Finding>
  /** What to tell people after setup. */
  readonly note: string
  /**
   * Whether the agent has a login of its own, checked without the network.
   * Only agents whose setup depends on it say, so setting up any other agent
   * never reads a login (Claude Code's may sit in the macOS keychain, which
   * would ask people for access). Importing that login is the importers' job.
   */
  readonly hasLogin?: (paths: Paths) => Effect.Effect<boolean, never, FileSystem.FileSystem>
}

/** The facts every agent starts from. */
export const factsOf = <K extends AgentId>(id: K): AgentFacts & { readonly id: K } => agentFacts[id]

/** A header's value, when the request has it. */
export const header = (headers: Headers, name: string): string | undefined => headers.get(name) ?? undefined

const utf8 = new TextEncoder()

/** The string at `path` in a JSON text, read without parsing the rest. */
export const stringField = (text: string | Uint8Array, ...path: ReadonlyArray<string>): string | undefined =>
  scan.findString(typeof text === "string" ? utf8.encode(text) : text, ...path)

/**
 * The conversation id clients other than the agents send: the usual
 * session headers, else the body's `prompt_cache_key`.
 */
export const commonSession = (headers: Headers, body: Uint8Array): string | undefined =>
  header(headers, "session-id") ??
  header(headers, "session_id") ??
  header(headers, "x-session-id") ??
  stringField(body, "prompt_cache_key")

/**
 * Quotes a word for a POSIX shell when it needs it: plain words of letters,
 * digits and `-_./:=@` stay as they are, anything else is single-quoted.
 */
export const shellQuote = (word: string): string =>
  word !== "" && /^[A-Za-z0-9\-_./:=@]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

// --- Files ---------------------------------------------------------------

/** There is nothing to undo: setup never ran for this agent, or it was undone already. */
export class NothingToUndo extends Data.TaggedError("NothingToUndo")<{ readonly agent: AgentId }> {
  override get message(): string {
    return `no ${agentFacts[this.agent].title} setup to undo`
  }
}

/** The agent's settings file is not something slopmax can edit. */
export class AgentConfigInvalid extends Data.TaggedError("AgentConfigInvalid")<{
  readonly path: string
  readonly reason: string
}> {
  override get message(): string {
    return `cannot edit ${this.path}: ${this.reason}`
  }
}

/** `backups.json`: what each agent's first setup replaced. */
const Backups = Schema.Record(Schema.String, Schema.Unknown)
type Backups = typeof Backups.Type

/** The path to edit: a symlink's real file, so a link into a dotfiles repository stays a link; a missing file as it is. */
export const realPath = (path: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path)))

/** The agent's settings file, followed through symlinks. */
const settingsFile = (agent: Agent) =>
  Effect.gen(function* () {
    const home = yield* Home
    return yield* realPath(agent.configFile(home.paths))
  })

const readBackups = Effect.gen(function* () {
  const home = yield* Home
  return Option.getOrElse(yield* home.read(home.paths.backups, Backups), (): Backups => ({}))
})

/** How the agent is wired on this machine, as the doctor, the CLI and the app show it. */
export const wiringOf = Effect.fn("Agents.wiring")(function* (agent: Agent) {
  const home = yield* Home
  const settings = yield* wireSettings
  const path = yield* settingsFile(agent)
  const doc = yield* home.readText(path).pipe(Effect.orElseSucceed(() => Option.none<string>()))
  const wiredTo = agent.wiredTo(doc)
  const backups = yield* readBackups.pipe(Effect.orElseSucceed((): Backups => ({})))
  return new AgentWiring({
    id: agent.id,
    title: agent.title,
    installed: yield* onPath(agent.program),
    configPath: path,
    ...(wiredTo === undefined ? {} : { wiredTo }),
    wired: wiredTo !== undefined && wiresToSlopmax(wiredTo, settings.baseUrl),
    backedUp: Object.hasOwn(backups, agent.id),
  })
})

/** Whether a place an agent is sent to is this slopmax: its address, or a provider named for slopmax. */
export const wiresToSlopmax = (target: string, baseUrl: string): boolean =>
  target.includes(baseUrl) || target.startsWith("slopmax")

/** Wires the agent's settings file to the proxy, keeping what it replaced unless a backup is already kept. */
export const connectAgent = Effect.fn("Agents.connect")(function* (agent: Agent) {
  const home = yield* Home
  const lock = yield* Lock
  const settings = yield* wireSettings
  const signedIn = agent.hasLogin === undefined ? false : yield* agent.hasLogin(home.paths)
  return yield* lock.with("backups")(
    Effect.gen(function* () {
      const path = yield* settingsFile(agent)
      const doc = yield* home.readText(path)
      const wired = yield* Effect.mapError(
        Effect.fromResult(agent.setup(doc, settings, { signedIn })),
        (reason) => new AgentConfigInvalid({ path, reason }),
      )
      const backups = yield* readBackups
      // The backup is saved before the file changes, so a failed write never leaves a setup that cannot be undone.
      if (!Object.hasOwn(backups, agent.id)) {
        yield* home.write(home.paths.backups, Backups, { ...backups, [agent.id]: wired.backup })
      }
      yield* home.writeText(path, wired.text)
      return { path, note: agent.note }
    }),
  )
})

/** Puts back what the agent's setup replaced, and forgets the backup. */
export const disconnectAgent = Effect.fn("Agents.disconnect")(function* (agent: Agent) {
  const home = yield* Home
  const lock = yield* Lock
  return yield* lock.with("backups")(
    Effect.gen(function* () {
      const backups = yield* readBackups
      if (!Object.hasOwn(backups, agent.id)) return yield* new NothingToUndo({ agent: agent.id })
      const path = yield* settingsFile(agent)
      const doc = yield* home.readText(path)
      const text = yield* Effect.mapError(
        Effect.fromResult(agent.undo(doc, backups[agent.id])),
        (reason) => new AgentConfigInvalid({ path, reason }),
      )
      yield* home.writeText(path, text)
      const { [agent.id]: _undone, ...rest } = backups
      yield* home.write(home.paths.backups, Backups, rest)
      return { path }
    }),
  )
})

// --- PATH ----------------------------------------------------------------

const pathVariable = Config.option(Config.String("PATH")).pipe(Config.map(Option.getOrElse(() => "")))

/** Whether some `PATH` entry holds a file of exactly this name. */
export const onPath = Effect.fn("Agents.onPath")(function* (program: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = (yield* pathVariable.pipe(Effect.orElseSucceed(() => "")))
    .split(process.platform === "win32" ? ";" : ":")
    .filter((dir) => dir !== "")
  for (const dir of entries) {
    const found = yield* fs.stat(path.join(dir, program)).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    )
    if (found) return true
  }
  return false
})

// --- Running ---------------------------------------------------------------

/** The signals `slopmax run` passes on to the agent. */
const forwardedSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const
type Forwarded = (typeof forwardedSignals)[number]

/** Signal numbers that are the same on Linux and macOS, for the exit status of an agent a signal ended. */
const signalNumbers: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}

/**
 * The signal that ended the agent, as the process runner reports it: an
 * agent that dies on a signal has no exit code, only the signal's name in
 * the runner's error.
 */
const endingSignal = (error: PlatformError.PlatformError): string | undefined => {
  const cause = error.reason.cause
  return cause instanceof Error ? /signal: '(SIG[A-Z0-9]+)'/.exec(cause.message)?.[1] : undefined
}

/**
 * Makes slopmax's answer to SIGHUP, SIGINT and SIGTERM, until the scope
 * closes, just passing them on to the agent, and remembers the last one.
 * Whatever else listens for them (the runtime interrupts the program on
 * SIGINT and SIGTERM) is set aside meanwhile and put back afterwards: a
 * signal meant for the agent must not stop slopmax first and lose the
 * agent's exit status. Ctrl-C at a terminal already reaches the agent,
 * which shares slopmax's process group, so SIGINT is passed on only when
 * stdin is not a terminal; passing it on as well would read as a second
 * Ctrl-C, which quits Claude Code.
 */
const forwardSignals = (
  pid: number,
): Effect.Effect<{ readonly last: () => Forwarded | undefined }, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let last: Forwarded | undefined
      const owned = forwardedSignals.map((signal) => {
        const others = process.listeners(signal)
        for (const listener of others) process.off(signal, listener)
        const handler = () => {
          last = signal
          if (signal === "SIGINT" && process.stdin.isTTY) return
          try {
            process.kill(pid, signal)
          } catch {
            // The agent has already gone.
          }
        }
        process.on(signal, handler)
        return { signal, handler, others }
      })
      return { owned, last: () => last }
    }),
    ({ owned }) =>
      Effect.sync(() => {
        for (const { signal, handler, others } of owned) {
          process.off(signal, handler)
          for (const listener of others) process.on(signal, listener)
        }
      }),
  )

/**
 * Runs the agent through the proxy with this terminal, passing signals on,
 * and returns its exit status: its own code, or 128 plus the signal that
 * ended it. Once started it runs to its end even if slopmax is interrupted,
 * so a Ctrl-C meant for the agent never takes the agent down with slopmax.
 * The caller exits with the status itself.
 */
export const runAgent = Effect.fn("Agents.run")(function* (agent: Agent, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const launch = agent.launch(yield* wireSettings, args)
  const command = ChildProcess.make(launch.command, launch.args, {
    env: launch.env,
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // In slopmax's process group, so the terminal treats the agent as the foreground program.
    detached: false,
  })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause: PlatformError.PlatformError) => new SpawnFailed({ program: launch.command, cause })),
        )
      const signals = yield* forwardSignals(handle.pid)
      return yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.catch((error) =>
          Effect.sync(() => {
            // It ended on a signal: report it as a shell would, else the last one slopmax passed on.
            const signal = endingSignal(error) ?? signals.last()
            const number = signal === undefined ? undefined : signalNumbers[signal]
            return number === undefined ? 1 : 128 + number
          }),
        ),
      )
    }),
  ).pipe(Effect.uninterruptible)
})

/** Every provider an agent can be served by: its own, and the API keys that back it. */
export const servedBy = (agent: AgentFacts): ReadonlyArray<ProviderId> =>
  ProviderId.literals.filter((id) => id === agent.provider || backerOf(id) === agent.provider)

const backerOf = (id: ProviderId): ProviderId | undefined => {
  const facts: { readonly backs?: ProviderId } = providerFacts[id]
  return facts.backs
}

/** Whether any account can serve the agent: one of its own provider, or an API key that backs it. */
export const servable = (agent: AgentFacts, accounts: ReadonlyArray<{ readonly provider: ProviderId }>): boolean => {
  const providers = servedBy(agent)
  return accounts.some((account) => providers.includes(account.provider))
}
