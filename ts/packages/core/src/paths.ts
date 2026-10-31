// Filesystem locations used by slopmax and by the agents it wires up.
//
// Environment variables are read through `Config`, so tests set them with a
// `ConfigProvider`; each is read when asked for, as the Rust reads them.
import { homedir } from "node:os"

import { Config, Effect, Option } from "effect"

/**
 * `Path::join`: `name` under `base`, both kept as written (no `.` or `..`
 * is resolved, as `node:path` would); an absolute `name` replaces `base`.
 */
export const join = (base: string, name: string): string => {
  if (name.startsWith("/") || base === "") return name
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`
}

/** An environment variable, when it is set and not empty. */
const envDir = (name: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const value = Option.getOrUndefined(yield* Config.option(Config.String(name)))
    return value === undefined || value === "" ? undefined : value
  }).pipe(Effect.orElseSucceed(() => undefined))

/** The user's home directory: `$HOME`, else the system's record, else `.`. */
export const userHome: Effect.Effect<string> = Effect.gen(function* () {
  const home = yield* envDir("HOME")
  if (home !== undefined) return home
  try {
    return homedir() || "."
  } catch {
    return "."
  }
})

/**
 * A slopmax directory and the files in it. The proxy carries its own, so
 * it never reaches into another home (tests run several side by side).
 */
export class Home {
  private constructor(readonly dir: string) {}

  static at(dir: string): Home {
    return new Home(dir)
  }

  /** `$SLOPMAX_HOME`, else `~/.slopmax`. */
  static readonly current: Effect.Effect<Home> = Effect.gen(function* () {
    const dir = yield* envDir("SLOPMAX_HOME")
    return new Home(dir ?? join(yield* userHome, ".slopmax"))
  })

  /** One JSON file per connected account. */
  accounts(): string {
    return join(this.dir, "accounts")
  }

  config(): string {
    return join(this.dir, "config.toml")
  }

  /** Last known limits and sessions, written by the proxy. */
  state(): string {
    return join(this.dir, "state.json")
  }

  /** The usage ledger's monthly files. */
  usage(): string {
    return join(this.dir, "usage")
  }

  /** Log destination for a proxy started in the background. */
  log(): string {
    return join(this.dir, "slopmax.log")
  }

  /** Manual account preferences set by `slopmax use`. */
  pins(): string {
    return join(this.dir, "pins.json")
  }

  /** The nudges already told, so a restart doesn't tell them again. */
  nudged(): string {
    return join(this.dir, "nudged.json")
  }

  /** Each subscription window that reset, and how much of it was used. */
  windows(): string {
    return join(this.dir, "windows.jsonl")
  }
}

/** Root of all slopmax state: `$SLOPMAX_HOME`, else `~/.slopmax`. */
export const home: Effect.Effect<string> = Effect.map(Home.current, (h) => h.dir)

export const accountsDir: Effect.Effect<string> = Effect.map(Home.current, (h) => h.accounts())

export const configFile: Effect.Effect<string> = Effect.map(Home.current, (h) => h.config())

export const stateFile: Effect.Effect<string> = Effect.map(Home.current, (h) => h.state())

export const usageDir: Effect.Effect<string> = Effect.map(Home.current, (h) => h.usage())

export const logFile: Effect.Effect<string> = Effect.map(Home.current, (h) => h.log())

export const pinsFile: Effect.Effect<string> = Effect.map(Home.current, (h) => h.pins())

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeDir: Effect.Effect<string> = Effect.gen(function* () {
  return (yield* envDir("CLAUDE_CONFIG_DIR")) ?? join(yield* userHome, ".claude")
})

/** Codex's config dir: `$CODEX_HOME`, else `~/.codex`. */
export const codexDir: Effect.Effect<string> = Effect.gen(function* () {
  return (yield* envDir("CODEX_HOME")) ?? join(yield* userHome, ".codex")
})

/** CLIProxyAPI's default credential dir, used for imports. */
export const cliproxyapiDir: Effect.Effect<string> = Effect.map(userHome, (h) => join(h, ".cli-proxy-api"))
