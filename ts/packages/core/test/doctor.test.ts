import { describe, expect } from "bun:test"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Client, Origins } from "@slopmax/net"

import { Account, type Link, Tokens } from "../src/account.ts"
import { Config } from "../src/config.ts"
import {
  accountsSection,
  claudeCode,
  cliproxyapi,
  codex,
  files,
  type Finding,
  Level,
  network,
  onPath,
  proxy,
  type Section,
  Section as Sections,
  unserved,
} from "../src/doctor.ts"
import { ProviderId } from "../src/provider/mod.ts"
import type { Status } from "../src/service.ts"
import { json, Mock, noEnv, reply, Seen } from "../src/testkit.ts"
import { VERSION } from "../src/version.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const texts = (section: Section): Array<readonly [Level, string]> => section.findings.map((f) => [f.level, f.text])

/** The finding that mentions `needle`. */
const finding = (section: Section, needle: string): Finding => {
  const found = section.findings.find((f) => f.text.includes(needle))
  if (found === undefined) throw new Error(`no finding with ${JSON.stringify(needle)} in ${JSON.stringify(section)}`)
  return found
}

/** A port nothing listens on (as the OS just gave and took back). */
const freePort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

const configOn = (port: number): Config => ({
  ...Config.default(),
  listen: { ip: "127.0.0.1", port },
  apiKey: "sm-key",
})

const portOf = (mock: Mock): number => Number(mock.url.split(":").at(-1))

const healthz = (version: string) =>
  Mock.start((seen) => (Seen.route(seen) === "/healthz" ? json(200, { service: "slopmax", version }) : reply(404, "")))

const account = (provider: ProviderId, email: string, now = Date.now()): Account =>
  Account.assignId({ ...Account.make(provider, Tokens.empty(), now), email })

const serviceStatus = (installed: boolean, running: boolean, lingering: boolean | undefined): Status => ({
  installed,
  running,
  lingering,
})

const claudeWith = (settings: unknown) =>
  Effect.gen(function* () {
    const dir = tempDir("doctor-claude")
    if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings))
    return yield* claudeCode(configOn(8318), dir)
  })

/**
 * The finding about settings.json, apart from whether `claude` is on
 * PATH or an API key is set in the shell running the tests.
 */
const wiring = (s: Section): readonly [Level, string] => {
  const f = s.findings.find((x) => !x.text.includes("PATH") && !x.text.includes("ANTHROPIC_API_KEY"))
  if (f === undefined) throw new Error("no wiring finding")
  return [f.level, f.text]
}

const codexWith = (toml: string | undefined) =>
  Effect.gen(function* () {
    const dir = tempDir("doctor-codex")
    if (toml !== undefined) writeFileSync(join(dir, "config.toml"), toml)
    const s = yield* codex(configOn(8318), dir)
    const f = s.findings.find((x) => !x.text.includes("PATH"))
    if (f === undefined) throw new Error("no wiring finding")
    return [f.level, f.text] as const
  })

/** An environment of `vars` only. */
const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromUnknown(vars))

/** The level of the wiring finding for a Codex config.toml holding `toml`. */
const codexLevel = (toml: string) =>
  Effect.gen(function* () {
    const dir = tempDir("doctor-codex-shapes")
    writeFileSync(join(dir, "config.toml"), toml)
    const s = yield* codex(configOn(8318), dir).pipe(Effect.provide(noEnv))
    return s.findings.find((f) => !f.text.includes("PATH"))?.level
  })

describe("doctor", () => {
  it.live("a_running_proxy_of_this_version_is_fine", () =>
    Effect.gen(function* () {
      const mock = yield* healthz(VERSION)
      const config = configOn(portOf(mock))
      const s = yield* proxy(config, undefined).pipe(Effect.provide(noEnv))
      expect(texts(s)).toEqual([["ok", `running on ${Config.baseUrl(config)}`]])
    }),
  )

  it.live("an_older_proxy_should_be_restarted", () =>
    Effect.gen(function* () {
      const mock = yield* healthz("0.0.1")
      const s = yield* proxy(configOn(portOf(mock)), undefined).pipe(Effect.provide(noEnv))
      const f = finding(s, "running version 0.0.1")
      expect(f.level).toBe("warn")
      expect(f.fix).toBe("slopmax stop && slopmax start")
    }),
  )

  it.live("another_program_on_the_port_is_named", () =>
    Effect.gen(function* () {
      // Answers, but not as slopmax, and holds the port.
      const mock = yield* Mock.start(() => reply(404, ""))
      const port = portOf(mock)
      const s = yield* proxy(configOn(port), undefined).pipe(Effect.provide(noEnv))
      const f = finding(s, `port ${port} is taken by`)
      expect(f.level).toBe("fail")
      expect(f.fix).toContain("listen")
    }),
  )

  it.live("a_stopped_proxy_says_how_to_start_it", () =>
    Effect.gen(function* () {
      const s = yield* proxy(configOn(freePort()), undefined).pipe(Effect.provide(noEnv))
      const f = finding(s, "not running")
      expect(f.level).toBe("warn")
      expect(f.fix?.startsWith("slopmax start")).toBe(true)
    }),
  )

  it.live("listening_beyond_this_machine_is_pointed_out", () =>
    Effect.gen(function* () {
      let config: Config = { ...configOn(freePort()) }
      config = { ...config, listen: { ...config.listen, ip: "0.0.0.0" } }
      let s = yield* proxy(config, undefined).pipe(Effect.provide(noEnv))
      expect(finding(s, "(0 client keys besides api_key)").level).toBe("note")
      config = { ...config, keys: [{ name: "laptop", key: "k", models: [] }] }
      s = yield* proxy(config, undefined).pipe(Effect.provide(noEnv))
      const f = finding(s, "listens beyond this machine")
      expect(f.text).toContain("(1 client key besides api_key)")
      expect(f.fix).toContain("slopmax key add")
    }),
  )

  it.live("the_login_service_is_reported", () =>
    Effect.gen(function* () {
      const config = configOn(freePort())
      let s = yield* proxy(config, serviceStatus(false, false, undefined)).pipe(Effect.provide(noEnv))
      const f = finding(s, "not installed as a service")
      expect([f.level, f.fix]).toEqual(["note", "slopmax service install"])
      s = yield* proxy(config, serviceStatus(true, true, true)).pipe(Effect.provide(noEnv))
      expect(finding(s, "runs as a login service").level).toBe("ok")
      expect(s.findings.some((x) => x.text.includes("log out"))).toBe(false)
      s = yield* proxy(config, serviceStatus(true, false, false)).pipe(Effect.provide(noEnv))
      expect(finding(s, "installed but not running").level).toBe("warn")
      expect(finding(s, "stops when you log out").fix).toBe("loginctl enable-linger $USER")
    }),
  )

  it.live("no_accounts_is_a_failure", () =>
    Effect.gen(function* () {
      const s = yield* accountsSection([])
      expect(texts(s)).toEqual([["fail", "no accounts connected"]])
    }),
  )

  it.live("accounts_are_counted_and_each_problem_has_a_fix", () =>
    Effect.gen(function* () {
      const now = yield* Timestamp.now
      const dir = tempDir("doctor-accounts")
      const kept = join(dir, "kept.json")
      writeFileSync(kept, "{}")

      const fine = account("claude", "fine@x.com")
      const revoked: Account = { ...account("claude", "revoked@x.com"), authError: "refresh token revoked" }
      const orphan: Account = {
        ...account("codex", "orphan@x.com"),
        link: { tool: "cliproxyapi", path: join(dir, "gone.json") },
      }
      const link: Link = { tool: "cliproxyapi", path: kept }
      const stale0 = account("codex", "stale@x.com")
      const stale: Account = {
        ...stale0,
        link,
        tokens: { ...stale0.tokens, expiresAt: Timestamp.sub(now, SignedDuration.fromMins(5)) },
      }
      const current0 = account("codex", "current@x.com")
      const current: Account = {
        ...current0,
        link,
        tokens: { ...current0.tokens, expiresAt: Timestamp.add(now, SignedDuration.fromHours(1)) },
      }
      const off: Account = { ...account("codex", "off@x.com"), disabled: true }

      const s = yield* accountsSection([fine, revoked, orphan, stale, current, off])
      const counts = s.findings[0]
      expect(counts?.level).toBe("ok")
      const claudeTitle = ProviderId.spec("claude").title
      const codexTitle = ProviderId.spec("codex").title
      expect(counts?.text).toBe(`2 ${claudeTitle} accounts, 4 ${codexTitle} accounts`)

      let f = finding(s, "needs a new login (refresh token revoked)")
      expect(f.level).toBe("fail")
      expect(f.fix).toBe("slopmax login claude")
      f = finding(s, "follows cliproxyapi, but")
      expect(f.level).toBe("warn")
      expect(f.text).toContain("gone.json is gone")
      expect(f.fix).toBe(`slopmax own ${orphan.id}`)
      f = finding(s, "token expired and cliproxyapi has not refreshed it")
      expect(f.fix).toBe(`start cliproxyapi again, or slopmax own ${stale.id}`)
      expect(finding(s, "is disabled").level).toBe("note")
      // One count line, four problems: the fresh linked account is fine.
      expect(s.findings.length).toBe(5)

      const single = yield* accountsSection([account("codex", "one@x.com")])
      expect(single.findings[0]?.text).toBe(`1 ${codexTitle} account`)
    }),
  )

  it.live("claude_code_wiring_is_checked_against_this_proxy", () =>
    Effect.gen(function* () {
      const base = Config.baseUrl(configOn(8318))
      let s = yield* claudeWith({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "sm-key" } })
      expect(wiring(s)[0]).toBe("ok")

      s = yield* claudeWith({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "old-key" } })
      expect(wiring(s)).toEqual(["warn", "settings.json points at slopmax with a different key"])

      s = yield* claudeWith({ env: { ANTHROPIC_BASE_URL: "https://elsewhere.example" } })
      expect(wiring(s)).toEqual(["warn", "settings.json sends Claude Code to https://elsewhere.example"])

      for (const missing of [undefined, { theme: "dark" }]) {
        const [level, text] = wiring(yield* claudeWith(missing))
        expect(level).toBe("note")
        expect(text.startsWith("not wired in settings.json")).toBe(true)
      }
      // A broken file reads as not wired, not as an error.
      const dir = tempDir("doctor-claude-broken")
      writeFileSync(join(dir, "settings.json"), "{ nope")
      s = yield* claudeCode(configOn(8318), dir)
      expect(wiring(s)[0]).toBe("note")
      expect(s.findings.every((f) => f.fix === undefined || f.fix.includes("claude") || f.fix.includes("unset"))).toBe(
        true,
      )
    }),
  )

  it.live("codex_wiring_is_checked_against_this_proxy", () =>
    Effect.gen(function* () {
      const wired =
        'model_provider = "slopmax"\n' +
        "[model_providers.slopmax]\n" +
        'base_url = "http://127.0.0.1:8318/codex"\n' +
        'experimental_bearer_token = "sm-key"\n'
      expect((yield* codexWith(wired))[0]).toBe("ok")

      const oldKey = wired.replace("sm-key", "old-key")
      expect(yield* codexWith(oldKey)).toEqual(["warn", "config.toml's slopmax provider has an old address or key"])
      const oldPort = wired.replace("8318", "9999")
      expect((yield* codexWith(oldPort))[0]).toBe("warn")

      const [level, text] = yield* codexWith('model_provider = "slopmax"\n')
      expect(level).toBe("warn")
      expect(text).toContain("its provider table is gone")

      expect(yield* codexWith('model_provider = "openai"\n')).toEqual([
        "warn",
        "config.toml sends Codex to the `openai` provider",
      ])
      for (const unwired of [undefined, 'model = "gpt-5"\n', "not = [valid"]) {
        const [unwiredLevel, unwiredText] = yield* codexWith(unwired)
        expect(unwiredLevel).toBe("note")
        expect(unwiredText.startsWith("not wired in config.toml")).toBe(true)
      }
    }),
  )

  it.live("cliproxyapi_matters_only_with_linked_accounts", () =>
    Effect.gen(function* () {
      const plain = account("codex", "a@x.com")
      expect((yield* cliproxyapi([plain], freePort())).findings).toEqual([])

      const linked: Account = { ...plain, link: { tool: "cliproxyapi", path: "/tmp/x.json" } }
      const accounts = [plain, linked]
      let s = yield* cliproxyapi(accounts, freePort())
      const f = finding(s, "not running, so nothing refreshes the 1 accounts")
      expect([f.level, f.fix]).toEqual(["warn", "slopmax own all"])

      const running = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
      try {
        s = yield* cliproxyapi(accounts, running.port)
        expect(finding(s, "still running and refreshing 1 account slopmax").level).toBe("note")
      } finally {
        running.stop(true)
      }
    }),
  )

  it.live("reachable_services_with_a_sound_clock_are_fine", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start(() => reply(401, ""))
      const http = yield* mock.client(["https://api.anthropic.com", "https://chatgpt.com"])
      const s = yield* network(http)
      expect(texts(s)).toEqual([
        ["ok", "Anthropic is reachable"],
        ["ok", "ChatGPT is reachable"],
      ])
      expect(mock.seen().map((seen) => seen.path)).toEqual(["/api/hello", "/backend-api/wham/usage"])
    }),
  )

  it.live("a_skewed_clock_is_reported_once", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start(() => ({
        ...reply(200, ""),
        headers: { date: "Sun, 06 Nov 1994 08:49:37 GMT" },
      }))
      const http = yield* mock.client(["https://api.anthropic.com", "https://chatgpt.com"])
      const s = yield* network(http)
      const skewed = s.findings.filter((f) => f.text.startsWith("the system clock is off by"))
      expect(skewed.length).toBe(1)
      expect(skewed[0]?.level).toBe("warn")
    }),
  )

  it.live("unreachable_services_fail_with_a_fix", () =>
    Effect.gen(function* () {
      const closed = `http://127.0.0.1:${freePort()}`
      const origins = new Origins([
        ["https://api.anthropic.com", closed],
        ["https://chatgpt.com", closed],
      ])
      const http = yield* Client.builder().plainHttp().origins(origins).build().pipe(Effect.provide(noEnv))
      const s = yield* network(http)
      expect(s.findings.length).toBe(2)
      for (const [i, name] of ["Anthropic", "ChatGPT"].entries()) {
        const f = s.findings[i]
        expect(f?.level).toBe("fail")
        expect(f?.text.startsWith(`cannot reach ${name}: `)).toBe(true)
        expect(f?.fix).toBe("check the network, or set HTTPS_PROXY")
      }
    }),
  )

  it.live("account_files_others_can_read_are_flagged", () =>
    Effect.gen(function* () {
      const dir = tempDir("doctor-files")
      const file = join(dir, "claude-1.json")
      writeFileSync(file, "{}")
      chmodSync(dir, 0o700)
      chmodSync(file, 0o600)
      expect((yield* files(dir)).findings).toEqual([])

      chmodSync(dir, 0o755)
      chmodSync(file, 0o644)
      const s = yield* files(dir)
      expect(s.findings.length).toBe(2)
      expect(finding(s, "is readable by other users").fix?.startsWith("chmod 700")).toBe(true)
      const f = finding(s, "1 account files are readable by other users")
      expect(f.fix?.startsWith("chmod 600")).toBe(true)

      // No accounts directory yet: nothing to flag.
      expect((yield* files(join(dir, "missing"))).findings).toEqual([])
    }),
  )

  it.live("programs_are_looked_up_on_path", () =>
    Effect.gen(function* () {
      expect(yield* onPath("sh")).toBe(true)
      expect(yield* onPath("slopmax-no-such-program")).toBe(false)
    }),
  )

  it("levels_order_by_severity", () => {
    expect(
      Level.compare("ok", "note") < 0 && Level.compare("note", "warn") < 0 && Level.compare("warn", "fail") < 0,
    ).toBe(true)
  })
})

describe("doctor, beyond the Rust tests", () => {
  it("findings serialize as the Rust's: lowercase levels, a null fix when there is none", () => {
    const s = Sections.make("Proxy")
    Sections.add(s, "ok", "running")
    Sections.add(s, "warn", "not running", "slopmax start")
    expect(JSON.stringify(Sections.json([s]))).toBe(
      '[{"title":"Proxy","findings":[{"level":"ok","text":"running","fix":null},' +
        '{"level":"warn","text":"not running","fix":"slopmax start"}]}]',
    )
  })

  it.live("an_api_key_in_the_shell_is_reported", () =>
    Effect.gen(function* () {
      const dir = tempDir("doctor-claude-key")
      const set = yield* claudeCode(configOn(8318), dir).pipe(Effect.provide(env({ ANTHROPIC_API_KEY: "sk-ant-test" })))
      const f = finding(set, "ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key")
      expect([f.level, f.fix]).toEqual(["warn", "unset ANTHROPIC_API_KEY"])
      const unset = yield* claudeCode(configOn(8318), dir).pipe(Effect.provide(noEnv))
      expect(unset.findings.some((x) => x.text.includes("ANTHROPIC_API_KEY"))).toBe(false)
      // With no PATH, neither agent is found.
      expect(finding(unset, "`claude` is not on PATH")).toEqual({
        level: "note",
        text: "`claude` is not on PATH",
        fix: undefined,
      })
    }),
  )

  it.live("empty variables count as set, as var_os reads them, under the edge's provider", () =>
    Effect.gen(function* () {
      const dir = tempDir("doctor-empty-env")
      const empty = { ANTHROPIC_API_KEY: "", PATH: "" }
      const kept = ConfigProvider.layer(ConfigProvider.fromUnknown(empty, { preserveEmptyStrings: true }))
      const s = yield* claudeCode(configOn(8318), dir).pipe(Effect.provide(kept))
      expect(finding(s, "ANTHROPIC_API_KEY is set in this shell").level).toBe("warn")
      // An empty PATH is one empty entry: the current directory.
      expect(yield* onPath("package.json").pipe(Effect.provide(kept))).toBe(true)
      // Effect's default reads an empty value as unset.
      const dropped = yield* claudeCode(configOn(8318), dir).pipe(Effect.provide(env(empty)))
      expect(dropped.findings.some((x) => x.text.includes("ANTHROPIC_API_KEY"))).toBe(false)
      expect(yield* onPath("package.json").pipe(Effect.provide(env(empty)))).toBe(false)
    }),
  )

  it.live("codex tables are told apart as toml_edit tells them", () =>
    Effect.gen(function* () {
      const fields = 'base_url = "http://127.0.0.1:8318/codex", experimental_bearer_token = "sm-key"'
      // Dotted keys make a table, as a header does.
      expect(
        yield* codexLevel(
          'model_provider = "slopmax"\nmodel_providers.slopmax.base_url = "http://127.0.0.1:8318/codex"\n' +
            'model_providers.slopmax.experimental_bearer_token = "sm-key"\n',
        ),
      ).toBe("ok")
      // An inline table is not one `as_table` finds.
      const inline = yield* codexLevel(`model_provider = "slopmax"\nmodel_providers = { slopmax = { ${fields} } }\n`)
      expect(inline).toBe("warn")
      expect(yield* codexLevel(`model_provider = "slopmax"\n[model_providers]\nslopmax = { ${fields} }\n`)).toBe("warn")
    }),
  )

  it.live("an_unserved_agent_is_told_to_log_in_first", () =>
    Effect.gen(function* () {
      const home = tempDir("doctor-unserved")
      const claudeDir = join(home, ".claude")
      const codexDir = join(home, ".codex")
      mkdirSync(claudeDir)
      mkdirSync(codexDir)
      const config = configOn(8318)
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: Config.baseUrl(config), ANTHROPIC_AUTH_TOKEN: "old" } }),
      )
      const vars = env({ HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir })
      const sections = [
        yield* claudeCode(config, claudeDir).pipe(Effect.provide(vars)),
        yield* codex(config, codexDir).pipe(Effect.provide(vars)),
      ]
      // Only a ChatGPT account: Claude Code has nothing to serve it.
      yield* unserved(sections, config, [account("codex", "c@x.com")]).pipe(Effect.provide(vars))
      const [claude, codexSection] = sections
      if (claude === undefined || codexSection === undefined) throw new Error("sections")
      expect(finding(claude, "with a different key").fix).toBe("slopmax login claude, then slopmax setup claude")
      const title = ProviderId.spec("claude").title
      const f = finding(claude, `points at slopmax, but no ${title} account is connected to serve it`)
      expect([f.level, f.fix]).toEqual(["fail", "slopmax login claude, or `slopmax setup claude --undo`"])
      // Codex is served, so its fix stays as it was.
      expect(finding(codexSection, "not wired in config.toml").fix).toBe("slopmax setup codex")

      // Not wired: the fix says to log in first, and nothing fails.
      const fresh = [yield* codex(config, join(home, "none")).pipe(Effect.provide(vars))]
      yield* unserved(fresh, config, [account("claude", "a@x.com")]).pipe(Effect.provide(vars))
      expect(finding(fresh[0] ?? Sections.make(""), "not wired in config.toml").fix).toBe(
        "slopmax login codex, then slopmax setup codex",
      )
      expect(fresh[0]?.findings.some((x) => x.level === "fail")).toBe(false)
    }),
  )
})
