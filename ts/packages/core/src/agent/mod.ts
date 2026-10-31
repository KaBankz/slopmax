// Agents: the programs slopmax serves.
//
// Each agent implements `Agent`: how to launch it through the proxy, the
// shell setup that wires it, how `setup` edits its own config (and undoes
// it), how its requests name their session, and where its own login lives.
// `agent/registry.ts` (`AGENTS`) is the one place that lists them.
//
// Three ways to connect an agent, from least to most invasive:
// - `slopmax run <agent>` launches the agent wired up for that session;
// - `slopmax env <agent>` prints shell setup to `eval`;
// - `slopmax setup <agent>` writes the wiring into the agent's own config,
//   keeping a backup for `--undo`.
import { spawn } from "node:child_process"
import process from "node:process"

import { Effect, Schema } from "effect"

import type { Client } from "@slopmax/net"
import type { json } from "@slopmax/wire"

import type { Account } from "../account.ts"
import { type Config, Config as Configs } from "../config.ts"
import { Failure, lift, text } from "../error.ts"
import * as fsx from "../fsx.ts"
import type { Found } from "../import.ts"
import { Home, join } from "../paths.ts"
import { ProviderId } from "../provider/mod.ts"
import { header } from "../proxy/headers.ts"
import * as rawjson from "../proxy/rawjson.ts"
import { byteOrder, JsonValue } from "../serde.ts"

/** A program to start: `std::process::Command` as the agents build it. */
export interface Command {
  readonly program: string
  readonly args: ReadonlyArray<string>
  /** Variables to set in its environment. */
  readonly env: Readonly<Record<string, string>>
  /** Variables to take out of it. */
  readonly envRemove: ReadonlyArray<string>
}

/** A program slopmax can serve. */
export interface Agent {
  /** Its name on the command line: `claude`, `codex`. */
  readonly id: string

  /** For people: "Claude Code". */
  readonly title: string

  /** The provider whose subscriptions it uses. */
  readonly provider: ProviderId

  /** Whether a request comes from this agent, judged from the headers it always sends. */
  detect(headers: Headers): boolean

  /**
   * The conversation id its requests carry, which keeps a session on one
   * account (and its prompt cache warm).
   */
  session(headers: Headers, body: Uint8Array): string | undefined

  /** The agent launched through the proxy, with `args` passed along. */
  command(config: Config, args: ReadonlyArray<string>): Command

  /** Shell commands that wire the current shell to the proxy. `exe` is this slopmax binary. */
  env(config: Config, exe: string): string

  /** The config file `setup` edits. */
  readonly configFile: Effect.Effect<string>

  /**
   * Points the config file at the proxy. When `saved` is undefined, it first
   * records what it replaces there, for `undo`; it returns what is saved now.
   */
  setup(config: Config, file: string, saved: json.Json | undefined): Effect.Effect<json.Json | undefined, Failure>

  /** Restores what `setup` replaced. */
  undo(file: string, saved: json.Json): Effect.Effect<void, Failure>

  /** What to tell the user after `setup`. */
  readonly setupNote: string

  /** Whether the agent has a saved login to import (checked without touching it). */
  readonly hasLogin: Effect.Effect<boolean>

  /**
   * Where the agent's config sends it today, when that is somewhere other
   * than its provider: a base URL or provider name.
   */
  readonly wiredTo: Effect.Effect<string | undefined>

  /** The agent's own saved login, if it has one. */
  import(http: Client): Effect.Effect<Found | undefined>
}

const SESSION_HEADERS = ["session-id", "session_id", "x-session-id"]

/**
 * The conversation a request belongs to: the agent's own session id, or one
 * of the ids other clients commonly send.
 */
export const session = (agent: Agent | undefined, headers: Headers, body: Uint8Array): string | undefined => {
  if (agent !== undefined) return agent.session(headers, body)
  for (const name of SESSION_HEADERS) {
    const value = header(headers, name)
    if (value !== undefined) return value
  }
  return rawjson.findStr(body, ["prompt_cache_key"])
}

/**
 * Whether any of `accounts` can serve `agent`'s own models: an account of
 * its provider, or an API key that backs it.
 */
export const servable = (agent: Agent, accounts: ReadonlyArray<Account>): boolean =>
  accounts.some((a) => {
    if (a.provider === agent.provider) return true
    const billing = ProviderId.spec(a.provider).billing
    return billing._tag === "Metered" && billing.backs === agent.provider
  })

/** Where an agent's own config sends it. */
export type Wiring =
  /** Through this slopmax. */
  | { readonly _tag: "Slopmax" }
  /** Somewhere else: a base URL or a provider's name. */
  | { readonly _tag: "Elsewhere"; readonly target: string }
  /** Straight to its provider, as installed. */
  | { readonly _tag: "Direct" }

/** Where `agent`'s own config sends it, judged against this `config`. */
export const wiring = (agent: Agent, config: Config): Effect.Effect<Wiring> =>
  Effect.map(agent.wiredTo, (target): Wiring => {
    if (target === undefined) return { _tag: "Direct" }
    if (target.includes(Configs.baseUrl(config)) || target.startsWith("slopmax")) return { _tag: "Slopmax" }
    return { _tag: "Elsewhere", target }
  })

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * Launches the agent through the proxy and returns its exit status. Neither
 * Bun nor Node can replace the process as Rust's `exec` does, so the agent
 * runs as a child with this process's terminal, the signals sent here are
 * passed on, and its exit status (128 + the signal, if one ended it) is the
 * answer.
 *
 * The agent stands in for this process, so it is never left behind: if
 * `run` is interrupted, the interruption waits for the agent to exit (it
 * has had the signal).
 */
export const run = Effect.fn("agent.run")(function* (agent: Agent, config: Config, args: ReadonlyArray<string>) {
  const command = agent.command(config, args)
  return yield* Effect.callback<number, Failure>((resume) => {
    const env: Record<string, string | undefined> = { ...process.env, ...command.env }
    for (const name of command.envRemove) delete env[name]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command.program, [...command.args], { stdio: "inherit", env })
    } catch (error) {
      resume(Effect.fail(new Failure({ message: `could not start ${command.program}: ${text(error)}` })))
      return
    }
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal)
    }
    const handlers = SIGNALS.map((signal) => [signal, forward(signal)] as const)
    for (const [signal, handler] of handlers) process.on(signal, handler)
    let exited = false
    const waiters: Array<() => void> = []
    const done = () => {
      exited = true
      for (const [signal, handler] of handlers) process.off(signal, handler)
      for (const wake of waiters.splice(0)) wake()
    }
    child.once("error", (error) => {
      done()
      resume(Effect.fail(new Failure({ message: `could not start ${command.program}: ${fsx.ioError(error).message}` })))
    })
    child.once("exit", (code, signal) => {
      done()
      const number = signal === null ? undefined : (fsx.signalNumber(signal) ?? 0)
      resume(Effect.succeed(code ?? (number === undefined ? 1 : 128 + number)))
    })
    return Effect.callback<void>((wake) => {
      if (exited) wake(Effect.void)
      else waiters.push(() => wake(Effect.void))
    })
  })
})

/** `setup-backup.json`: each agent's saved settings, by agent id. */
const BackupSchema = Schema.Record(Schema.String, JsonValue)

// A BTreeMap: keys in byte order.
const sorted = (saved: Readonly<Record<string, json.Json>>): Record<string, json.Json> => {
  const out: Record<string, json.Json> = {}
  for (const key of Object.keys(saved).toSorted(byteOrder)) {
    const value = saved[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Where `setup` keeps what it replaced, per agent. */
const backupFile: Effect.Effect<string> = Effect.map(Home.current, (home) => join(home.dir, "setup-backup.json"))

/**
 * The agent's config file. A symlink (say, into a dotfiles repository) is
 * followed, so the file it points to is edited in place rather than the
 * link being replaced.
 */
const configFile = (agent: Agent): Effect.Effect<string> => Effect.flatMap(agent.configFile, resolve)

/** The real path of `path`, or `path` itself when it cannot be resolved (it does not exist yet). */
export const resolve = (path: string): Effect.Effect<string> => Effect.orElseSucceed(fsx.canonicalize(path), () => path)

const io = <A>(effect: Effect.Effect<A, fsx.IoError>): Effect.Effect<A, Failure> => Effect.mapError(effect, lift)

const readBackup = (file: string): Effect.Effect<Record<string, json.Json>, Failure> =>
  Effect.map(io(fsx.readJson(file, BackupSchema)), (saved) => ({ ...saved }))

/** Writes the wiring into the agent's config. Returns the file changed. */
export const setup = Effect.fn("agent.setup")(function* (agent: Agent, config: Config) {
  const file = yield* configFile(agent)
  const backup = yield* backupFile
  const saved = yield* readBackup(backup)
  const slot = Object.hasOwn(saved, agent.id) ? saved[agent.id] : undefined
  delete saved[agent.id]
  const fresh = slot === undefined
  const previous = yield* agent.setup(config, file, slot)
  if (fresh && previous !== undefined) {
    saved[agent.id] = previous
    yield* io(fsx.writeJson(backup, BackupSchema, sorted(saved)))
  }
  return file
})

/** Reverts `setup`. Returns the file changed. */
export const undo = Effect.fn("agent.undo")(function* (agent: Agent) {
  const file = yield* configFile(agent)
  const backup = yield* backupFile
  const saved = yield* readBackup(backup)
  const previous = Object.hasOwn(saved, agent.id) ? saved[agent.id] : undefined
  if (previous === undefined) return yield* Effect.fail(new Failure({ message: `no ${agent.title} setup to undo` }))
  delete saved[agent.id]
  yield* agent.undo(file, previous)
  yield* io(fsx.writeJson(backup, BackupSchema, sorted(saved)))
  return file
})

const SHELL_SAFE = /^[A-Za-z0-9\-_./:=@]+$/

/** Quotes `s` for a POSIX shell when it needs quoting. */
export const shellQuote = (s: string): string => (SHELL_SAFE.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`)
