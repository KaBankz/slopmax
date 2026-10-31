// Checks of the whole setup, each saying how to fix what is wrong: what
// `slopmax doctor` prints and the app shows. Findings never include a key
// or token.
import { connect } from "node:net"
import process from "node:process"

import { Config as EffectConfig, Duration, Effect, Option, Schema, SchemaGetter } from "effect"

import { human, SignedDuration, Timestamp } from "@slopmax/common"
import { type Client, Origins, server } from "@slopmax/net"
import { json } from "@slopmax/wire"

import { Account, type Store, Tokens } from "./account.ts"
import { servable, wiring } from "./agent/mod.ts"
import { AGENTS } from "./agent/registry.ts"
import { httpClient } from "./auth/mod.ts"
import { Daemon } from "./background.ts"
import { Config, SocketAddr } from "./config.ts"
import type { Failure } from "./error.ts"
import * as fsx from "./fsx.ts"
import * as paths from "./paths.ts"
import { ProviderId } from "./provider/mod.ts"
import { JsonValue } from "./serde.ts"
import * as service from "./service.ts"
import * as toml from "./toml.ts"
import { VERSION } from "./version.ts"

/** CLIProxyAPI's default port, for spotting it beside slopmax. */
const CLIPROXYAPI_PORT = 8317

/** How much a finding matters, least first; lowercase in JSON. */
export const LevelSchema = Schema.Literals(["ok", "note", "warn", "fail"])

export type Level = typeof LevelSchema.Type

export const Level = {
  /** In order, least first. */
  ALL: LevelSchema.literals,

  /** The order of severity (`Ord`). */
  compare: (a: Level, b: Level): number => Level.ALL.indexOf(a) - Level.ALL.indexOf(b),
} as const

// `Option<String>`, written as `null` when absent.
const FixSchema = Schema.NullOr(Schema.String).pipe(
  Schema.decodeTo(Schema.UndefinedOr(Schema.String), {
    decode: SchemaGetter.transform((fix: string | null) => fix ?? undefined),
    encode: SchemaGetter.transform((fix: string | undefined) => fix ?? null),
  }),
)

export const FindingSchema = Schema.Struct({
  level: LevelSchema,
  text: Schema.String,
  /** What to run or change to fix it. */
  fix: FixSchema,
})

export interface Finding {
  readonly level: Level
  readonly text: string
  /** What to run or change to fix it. */
  readonly fix: string | undefined
}

/** The findings about one part of the setup: `{"title","findings"}` in JSON. */
export const SectionSchema = Schema.Struct({
  title: Schema.String,
  findings: Schema.Array(FindingSchema),
})

export interface Section {
  readonly title: string
  readonly findings: Array<Finding>
}

export const Section = {
  make: (title: string): Section => ({ title, findings: [] }),

  add: (self: Section, level: Level, text: string, fix?: string): void => {
    self.findings.push({ level, text, fix })
  },

  /** The sections as JSON, as `GET /slopmax/doctor` answers them. */
  json: Schema.encodeSync(Schema.Array(SectionSchema)),
} as const

/** Runs every check. Sections without findings are left out. */
export const check = Effect.fn("doctor.check")(function* (
  config: Config,
  store: Store,
): Effect.fn.Return<ReadonlyArray<Section>, Failure> {
  const accounts = yield* store.list()
  const manager = yield* service.detect
  const status = manager === undefined ? undefined : yield* service.status(manager)
  const http = yield* httpClient(new Origins())
  const sections = [
    yield* proxy(config, status),
    yield* accountsSection(accounts),
    yield* claudeCode(config, yield* paths.claudeDir),
    yield* codex(config, yield* paths.codexDir),
    yield* cliproxyapi(accounts, CLIPROXYAPI_PORT),
    yield* network(http),
    yield* files(yield* paths.accountsDir),
  ]
  yield* unserved(sections, config, accounts)
  return sections.filter((s) => s.findings.length > 0)
})

/**
 * @internal An agent wired to slopmax with no account to serve its own
 * models gets an error for every request it sends; exported for tests.
 */
export const unserved = Effect.fn("doctor.unserved")(function* (
  sections: ReadonlyArray<Section>,
  config: Config,
  accounts: ReadonlyArray<Account>,
) {
  for (const agent of AGENTS) {
    if (servable(agent, accounts)) continue
    const wired = (yield* wiring(agent, config))._tag === "Slopmax"
    const section = sections.find((s) => s.title === agent.title)
    if (section === undefined) continue
    const provider = agent.provider
    // Wiring it now would only break it.
    const first = `slopmax login ${provider}, then slopmax setup ${agent.id}`
    section.findings.forEach((finding, i) => {
      if (finding.fix === `slopmax setup ${agent.id}`) section.findings[i] = { ...finding, fix: first }
    })
    if (!wired) continue
    Section.add(
      section,
      "fail",
      `points at slopmax, but no ${ProviderId.spec(provider).title} account is connected to serve it`,
      `slopmax login ${provider}, or \`slopmax setup ${agent.id} --undo\``,
    )
  }
})

/** @internal The proxy and its service; exported for tests. */
export const proxy = Effect.fn("doctor.proxy")(function* (config: Config, status: service.Status | undefined) {
  const s = Section.make("Proxy")
  const ours = VERSION
  const version = yield* (yield* Daemon.make(config)).version
  if (version === ours) {
    Section.add(s, "ok", `running on ${Config.baseUrl(config)}`)
  } else if (version !== undefined) {
    Section.add(s, "warn", `running version ${version}, but this binary is ${ours}`, "slopmax stop && slopmax start")
  } else if (yield* portTaken(config.listen)) {
    const port = config.listen.port
    const holder = (yield* server.portHolder(port)) ?? "another program"
    Section.add(s, "fail", `port ${port} is taken by ${holder}`, "set `listen` in config.toml to a free port")
  } else {
    Section.add(s, "warn", "not running", "slopmax start (or `slopmax service install` to start at login)")
  }
  if (!isLoopback(config.listen)) {
    const named = config.keys.length
    Section.add(
      s,
      "note",
      `listens beyond this machine on ${SocketAddr.display(config.listen)}: anyone who can reach it with the key ` +
        `(${named} client key${named === 1 ? "" : "s"} besides api_key) can use your accounts`,
      "give other machines their own keys with `slopmax key add <name>`",
    )
  }
  if (status !== undefined) {
    if (!status.installed) Section.add(s, "note", "not installed as a service", "slopmax service install")
    else if (status.running) Section.add(s, "ok", "runs as a login service")
    else Section.add(s, "warn", "the service is installed but not running", "slopmax start")
    if (status.installed && status.lingering === false) {
      Section.add(s, "note", "the service stops when you log out", "loginctl enable-linger $USER")
    }
  }
  return s
})

/** `IpAddr::is_loopback`: 127.0.0.0/8, or `::1`. */
const isLoopback = (addr: SocketAddr): boolean =>
  addr.ip.includes(":") ? addr.ip === "::1" : addr.ip.startsWith("127.")

/** Whether binding `listen` fails because something holds the port. */
const portTaken = (listen: SocketAddr): Effect.Effect<boolean> =>
  Effect.scoped(server.bind({ hostname: listen.ip, port: listen.port })).pipe(
    Effect.as(false),
    Effect.catch((e) => Effect.succeed(e.code === "EADDRINUSE")),
  )

/** @internal The accounts and what each needs; exported for tests. */
export const accountsSection = Effect.fn("doctor.accountsSection")(function* (accounts: ReadonlyArray<Account>) {
  const s = Section.make("Accounts")
  if (accounts.length === 0) {
    Section.add(s, "fail", "no accounts connected", "slopmax login claude, slopmax login codex, or slopmax import")
    return s
  }
  const counts: Array<string> = []
  for (const provider of ProviderId.ALL) {
    const n = accounts.filter((a) => a.provider === provider).length
    if (n > 0) counts.push(`${n} ${ProviderId.spec(provider).title} account${n === 1 ? "" : "s"}`)
  }
  Section.add(s, "ok", counts.join(", "))
  const now = yield* Timestamp.now
  for (const account of accounts) {
    const name = Account.name(account)
    const link = account.link
    if (account.authError !== undefined) {
      Section.add(s, "fail", `${name} needs a new login (${account.authError})`, `slopmax login ${account.provider}`)
    } else if (link !== undefined) {
      const fix = `slopmax own ${account.id}`
      if (!(yield* fsx.exists(link.path))) {
        Section.add(s, "warn", `${name} follows ${link.tool}, but ${link.path} is gone`, fix)
      } else if (Tokens.isExpired(account.tokens, now)) {
        Section.add(
          s,
          "warn",
          `${name}'s token expired and ${link.tool} has not refreshed it`,
          `start ${link.tool} again, or ${fix}`,
        )
      }
    }
    if (account.disabled) Section.add(s, "note", `${name} is disabled`)
  }
  return s
})

/** @internal Claude Code's wiring, from the settings.json in `dir`; exported for tests. */
export const claudeCode = Effect.fn("doctor.claudeCode")(function* (config: Config, dir: string) {
  const s = Section.make("Claude Code")
  if (!(yield* onPath("claude"))) Section.add(s, "note", "`claude` is not on PATH")
  const settings = yield* Effect.orElseSucceed(fsx.readJson(paths.join(dir, "settings.json"), JsonValue), () => null)
  const env = (key: string): string | undefined => json.str(json.get(json.get(settings ?? null, "env"), key))
  const base = env("ANTHROPIC_BASE_URL")
  const token = env("ANTHROPIC_AUTH_TOKEN")
  const ours = Config.baseUrl(config)
  if (base !== undefined && token !== undefined && base === ours && token === config.apiKey) {
    Section.add(s, "ok", "wired through settings.json, for the CLI and the apps that run it")
  } else if (base !== undefined && base === ours) {
    Section.add(s, "warn", "settings.json points at slopmax with a different key", "slopmax setup claude")
  } else if (base !== undefined) {
    Section.add(s, "warn", `settings.json sends Claude Code to ${base}`, "slopmax setup claude")
  } else {
    Section.add(s, "note", "not wired in settings.json (`slopmax run claude` still works)", "slopmax setup claude")
  }
  if ((yield* envVar("ANTHROPIC_API_KEY")) !== undefined) {
    Section.add(
      s,
      "warn",
      "ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key",
      "unset ANTHROPIC_API_KEY",
    )
  }
  return s
})

/** @internal Codex's wiring, from the config.toml in `dir`; exported for tests. */
export const codex = Effect.fn("doctor.codex")(function* (config: Config, dir: string) {
  const s = Section.make("Codex")
  if (!(yield* onPath("codex"))) Section.add(s, "note", "`codex` is not on PATH")
  const text = yield* Effect.orElseSucceed(fsx.readText(paths.join(dir, "config.toml")), () => undefined)
  const parsed = text === undefined ? undefined : toml.Document.parse(text)
  const doc = parsed?._tag === "Success" ? parsed.success : undefined
  const selected = doc?.root.get("model_provider")
  const provider = selected instanceof toml.Value ? selected.asStr() : undefined
  const table = doc === undefined ? undefined : slopmaxTable(doc)
  const field = (key: string): string | undefined => {
    const value = table?.[key]
    return typeof value === "string" ? value : undefined
  }
  const expected = `${Config.baseUrl(config)}/codex`
  if (
    provider === "slopmax" &&
    field("base_url") === expected &&
    field("experimental_bearer_token") === config.apiKey
  ) {
    Section.add(s, "ok", "wired through config.toml, for the CLI and the desktop app")
  } else if (provider === "slopmax" && table === undefined) {
    Section.add(
      s,
      "warn",
      "config.toml selects slopmax, but its provider table is gone (the Codex desktop app can rewrite the file)",
      "slopmax setup codex",
    )
  } else if (provider === "slopmax") {
    Section.add(s, "warn", "config.toml's slopmax provider has an old address or key", "slopmax setup codex")
  } else if (provider !== undefined) {
    Section.add(s, "warn", `config.toml sends Codex to the \`${provider}\` provider`, "slopmax setup codex")
  } else {
    Section.add(s, "note", "not wired in config.toml (`slopmax run codex` still works)", "slopmax setup codex")
  }
  return s
})

/**
 * `doc["model_providers"]["slopmax"].as_table()`: a table (with a header,
 * or one that dotted keys make), never an inline one, as toml_edit tells
 * them apart.
 */
const slopmaxTable = (doc: toml.Document): toml.TomlTable | undefined => {
  let item: toml.Item | undefined = doc.root
  for (const key of ["model_providers", "slopmax"]) {
    item = item instanceof toml.Table ? item.get(key) : undefined
    if (item instanceof toml.Value || item instanceof toml.ArrayOfTables) return undefined
  }
  const providers = doc.data["model_providers"]
  const table = toml.isTable(providers) ? providers["slopmax"] : undefined
  return toml.isTable(table) ? table : undefined
}

/** @internal CLIProxyAPI beside slopmax, on `port`; exported for tests. */
export const cliproxyapi = Effect.fn("doctor.cliproxyapi")(function* (accounts: ReadonlyArray<Account>, port: number) {
  const s = Section.make("CLIProxyAPI")
  const linked = accounts.filter((a) => a.link?.tool === "cliproxyapi").length
  if (linked === 0) return s
  if (yield* answers("127.0.0.1", port, Duration.millis(300))) {
    Section.add(
      s,
      "note",
      `still running and refreshing ${linked} account${linked === 1 ? "" : "s"} slopmax follows`,
      "once you stop CLIProxyAPI: slopmax own all",
    )
  } else {
    Section.add(
      s,
      "warn",
      `not running, so nothing refreshes the ${linked} accounts slopmax follows`,
      "slopmax own all",
    )
  }
  return s
})

/**
 * Whether something accepts a TCP connection on `host:port` within
 * `timeout` (`TcpStream::connect_timeout`), timed on the `Clock`. An
 * abandoned connect is destroyed.
 */
const answers = (host: string, port: number, timeout: Duration.Duration): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resume(Effect.succeed(ok))
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    return Effect.sync(() => socket.destroy())
  }).pipe(Effect.timeoutOption(timeout), Effect.map(Option.getOrElse(() => false)))

/** @internal Whether Anthropic and ChatGPT answer, and the clock; exported for tests. */
export const network = Effect.fn("doctor.network")(function* (http: Client) {
  const s = Section.make("Network")
  let skewChecked = false
  for (const [name, url] of [
    ["Anthropic", "https://api.anthropic.com/api/hello"],
    ["ChatGPT", "https://chatgpt.com/backend-api/wham/usage"],
  ] as const) {
    const sent = yield* Effect.result(http.get(url).timeout("10 seconds").send())
    if (sent._tag === "Failure") {
      Section.add(s, "fail", `cannot reach ${name}: ${sent.failure.message}`, "check the network, or set HTTPS_PROXY")
      continue
    }
    const response = sent.success
    yield* response.close
    Section.add(s, "ok", `${name} is reachable`)
    const dateHeader = response.headers.get("date")
    const date = dateHeader === null ? undefined : Timestamp.fromHttpDate(dateHeader)
    if (date === undefined || skewChecked) continue
    skewChecked = true
    const skew = Math.abs(SignedDuration.asSecs(Timestamp.durationSince(yield* Timestamp.now, date)))
    if (SignedDuration.fromSecs(skew) > SignedDuration.fromMins(1)) {
      Section.add(
        s,
        "warn",
        `the system clock is off by ${human.duration(SignedDuration.fromSecs(skew))}`,
        "enable time sync (e.g. `timedatectl set-ntp true`)",
      )
    }
  }
  return s
})

/** @internal Who can read the account files in `dir` (Unix); exported for tests. */
export const files = Effect.fn("doctor.files")(function* (dir: string) {
  const s = Section.make("Files")
  if (process.platform === "win32") return s
  if (yield* readableByOthers(dir)) Section.add(s, "warn", `${dir} is readable by other users`, `chmod 700 ${dir}`)
  const names = yield* Effect.orElseSucceed(fsx.readDir(dir), (): ReadonlyArray<string> => [])
  let exposed = 0
  for (const name of names) if (yield* readableByOthers(paths.join(dir, name))) exposed++
  if (exposed > 0) {
    Section.add(s, "warn", `${exposed} account files are readable by other users`, `chmod 600 ${dir}/*`)
  }
  return s
})

/** Whether group or others may do anything with `path`. */
const readableByOthers = (path: string): Effect.Effect<boolean> =>
  Effect.map(fsx.metadata(path), (m) => m !== undefined && (m.mode & 0o077) !== 0)

/**
 * An environment variable, or undefined when unset. Rust's `var_os` counts
 * an empty value as set; so does this under
 * `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`, which the
 * front ends provide at the edge (as `log.init` asks too). Effect's default
 * provider reads an empty value as unset.
 */
const envVar = (name: string): Effect.Effect<string | undefined> =>
  EffectConfig.option(EffectConfig.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

/** @internal Whether some `$PATH` directory holds a file named `program`; exported for tests. */
export const onPath = Effect.fn("doctor.onPath")(function* (program: string) {
  const path = yield* envVar("PATH")
  if (path === undefined) return false
  // `env::split_paths`: an empty entry is the current directory.
  for (const dir of path.split(":")) {
    const file = yield* fsx.metadata(dir === "" ? program : paths.join(dir, program))
    if (file?.isFile === true) return true
  }
  return false
})
