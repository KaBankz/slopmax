// `tests/cli.rs`: the `slopmax` binary end to end, in a sandbox (see
// `support/sandbox.ts`). Runs `dist/slopmax` when it is built (or
// `SLOPMAX_BIN`), else the sources under Bun.
import { describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

import { Effect } from "effect"

import { Account, ledger, VERSION } from "@slopmax/core"

import {
  BINARY,
  claude,
  codex,
  eventually,
  fails,
  FROM_SOURCE,
  key,
  ok,
  Sandbox,
  STALE,
  write,
} from "./support/sandbox.ts"

const SLOW = 60_000

// The sources run under Bun, which cannot start a background proxy (the
// program is Bun then, not slopmax): those tests need the binary.
const needsBinary = it.skipIf(FROM_SOURCE)

const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let current = value
  for (const step of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return current
}

const accountsOf = (report: unknown): ReadonlyArray<Record<string, unknown>> =>
  field(report, "accounts") as ReadonlyArray<Record<string, unknown>>

const entry = (at: number, account: string, model: string, status: number): ledger.Entry => ({
  at,
  account,
  provider: "claude",
  model,
  status,
  input: 1_000,
  output: 200,
  cacheRead: 5_000,
  cacheWrite: 300,
  ms: 1_200,
  firstByteMs: 300,
  attempts: 1,
  agent: "claude",
})

/** A compatible endpoint that lists two models for one key. */
const endpointServer = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      const authorized = request.headers.get("authorization") === "Bearer sk-good"
      if (path === "/v1/models" && authorized) {
        return new Response('{"data":[{"id":"qwen3"},{"id":"llama4"}]}')
      }
      if (path === "/v1/models") return new Response("{}", { status: 401 })
      return new Response("", { status: 404 })
    },
  })

const cliproxyLogin = (s: Sandbox) =>
  write(
    join(s.home, ".cli-proxy-api/codex-a.json"),
    JSON.stringify({
      type: "codex",
      access_token: "tok-a",
      refresh_token: "ref-a",
      email: "a@x.dev",
      account_id: "ws-a",
    }),
  )

// The file's text, or nothing when there is none.
const readOr = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "")

describe(`cli (${FROM_SOURCE ? `the sources under Bun, ${STALE ?? ""}` : BINARY[0]})`, () => {
  it("help_version_and_completions_print_and_succeed", async () => {
    const s = new Sandbox("help")
    const help = ok(await s.run(["--help"]))
    expect(help.stdout).toContain("Multi-account switcher")
    expect(help.stdout).toContain("setup")
    const version = ok(await s.run(["--version"]))
    expect(version.stdout).toContain(VERSION)
    expect(version.stdout).toBe(`slopmax ${VERSION}\n`)
    const usageHelp = ok(await s.run(["help", "usage"]))
    expect(usageHelp.stdout).toContain("--by")
    const loginHelp = ok(await s.run(["login", "--help"]))
    expect(loginHelp.stdout).toContain("compat")
    // Printing help never creates state.
    expect(existsSync(s.slopmax)).toBe(false)
    for (const shell of ["bash", "zsh", "fish"]) {
      const script = ok(await s.run(["completions", shell]))
      expect(script.stdout).toContain("slopmax")
      expect(script.stdout).toContain("setup")
    }
  })

  it(
    "mistakes_explain_themselves_and_fail",
    async () => {
      const s = new Sandbox("mistakes")
      // The parser's errors exit 2 with a hint.
      fails(await s.run(["statsu"]), 2, "status")
      fails(await s.run(["label"]), 2, "<ACCOUNT>")
      fails(await s.run(["completions", "tcsh"]), 2, "tcsh")
      fails(await s.run(["status", "--frobnicate"]), 2, "--frobnicate")

      // The commands' own checks exit 1.
      fails(await s.run(["status", "--watch", "--json"]), 1, "--json cannot be combined with --watch")
      fails(await s.run(["usage", "--by", "week"]), 1, "--by takes day, model, or account")
      fails(await s.run(["usage", "fortnight"]), 2, "fortnight")
      fails(await s.run(["logs", "-n", "many"]), 1, "--lines takes a number")
      fails(await s.run(["key", "add"]), 1, "needs the key's name")
      fails(await s.run(["key", "remove", "ghost"]), 1, 'no key named "ghost"')
      fails(await s.run(["login", "compat"]), 1, "--url <base url>")
      fails(await s.run(["login", "claude", "--url", "http://localhost:1/v1"]), 1, "are for `slopmax login compat`")
      fails(await s.run(["login", "compat", "--url", "ftp://host"]), 1, "http:// or https://")
      fails(
        await s.run(["login", "compat", "--url", "http://h/v1", "--dialect", "soap"]),
        1,
        "--dialect takes chat, responses, or messages",
      )
      fails(await s.run(["login", "claude", "--device"]), 1, "--device works for ChatGPT accounts")
      fails(await s.run(["notify"]), 1, "notifications are off")
      fails(await s.run(["label", "1", "work"]), 1, 'no account matches "1"')
      fails(await s.run(["priority", "x", "high"]), 1, "")
      fails(await s.run(["setup", "claude", "--undo"]), 1, "no Claude Code setup to undo")
      fails(await s.run(["import", "nowhere"]), 2, "nowhere")

      // An unreadable config is reported, not overwritten.
      mkdirSync(s.slopmax, { recursive: true })
      writeFileSync(s.config(), "listen = [")
      fails(await s.run(["status"]), 1, "error:")
      expect(readFileSync(s.config(), "utf8")).toBe("listen = [")
    },
    SLOW,
  )

  it("a_bad_listen_override_is_named", async () => {
    const s = new Sandbox("listen")
    const out = await s.run(["status"], { env: { SLOPMAX_LISTEN: "not-an-address" } })
    expect(out.code).toBe(1)
    expect(out.stderr).toContain("SLOPMAX_LISTEN")
  })

  it(
    "status_shows_accounts_from_disk",
    async () => {
      const s = new Sandbox("status")
      const empty = ok(await s.run([]))
      expect(empty.stdout).toContain("No accounts yet")
      // A first run creates the config from its template.
      expect(existsSync(s.config())).toBe(true)

      await s.add(claude("a@x.dev"))
      await s.add(codex("b@x.dev"))
      const kimi = {
        ...key("compat", "sk-local"),
        endpoint: { baseUrl: "http://localhost:11434/v1", dialect: "chat", models: ["qwen3"] },
      } satisfies Account
      await s.add(Account.assignId(kimi))
      await s.add(key("anthropic", "sk-ant-1234"))

      const report = json(ok(await s.run(["status", "--json"])).stdout)
      const accounts = accountsOf(report)
      expect(accounts.length).toBe(4)
      const names = accounts.map((a) => a["name"])
      expect(names).toContain("a@x.dev")
      expect(names).toContain("b@x.dev")
      expect(names).toContain("localhost:11434")

      const table = ok(await s.run(["ls"])).stdout
      expect(table).toContain("CLAUDE")
      expect(table).toContain("CODEX")
      expect(table).toContain("a@x.dev")
      expect(table).toContain("max 20x")
      // Without a terminal, a bare `slopmax` is `status`.
      expect(ok(await s.run([])).stdout).toBe(table)
    },
    SLOW,
  )

  it("refreshing_status_reports_unreachable_providers_without_failing", async () => {
    const s = new Sandbox("refresh")
    await s.add(codex("b@x.dev"))
    const out = ok(await s.run(["status", "--refresh", "--json"]))
    expect(accountsOf(json(out.stdout)).length).toBe(1)
  })

  it(
    "account_commands_change_the_store",
    async () => {
      const s = new Sandbox("accounts")
      const a = claude("a@x.dev")
      const b = claude("b@x.dev")
      await s.add(a)
      await s.add(b)

      let out = ok(await s.run(["label", "a@x.dev", "work"]))
      expect(out.stdout).toContain("work")
      expect((await s.account(a.id)).label).toBe("work")

      out = ok(await s.run(["priority", "work", "-2"]))
      expect(out.stdout).toContain("priority -2")
      expect((await s.account(a.id)).priority).toBe(-2)

      ok(await s.run(["disable", "work"]))
      expect((await s.account(a.id)).disabled).toBe(true)
      out = ok(await s.run(["enable", a.id]))
      expect(out.stdout).toContain("Enabled work")
      expect((await s.account(a.id)).disabled).toBe(false)

      const pins = join(s.slopmax, "pins.json")
      out = ok(await s.run(["use", "b@x.dev"]))
      expect(out.stdout).toContain("New claude sessions will use")
      expect(json(readFileSync(pins, "utf8"))["claude"]).toBe(b.id)
      out = ok(await s.run(["use", "auto"]))
      expect(out.stdout).toContain("automatically")
      expect(json(readFileSync(pins, "utf8"))["claude"]).toBeUndefined()

      // Removing a pinned account drops its pin too.
      ok(await s.run(["use", "b@x.dev"]))
      out = ok(await s.run(["remove", "b@x.dev"]))
      expect(out.stdout).toContain("Removed b@x.dev")
      expect(await Effect.runPromise(s.store().get(b.id))).toBeUndefined()
      expect(json(readFileSync(pins, "utf8"))["claude"]).toBeUndefined()

      // Ambiguous and missing references are refused.
      await s.add(claude("c@x.dev"))
      fails(await s.run(["remove", "claude-"]), 1, "ambiguous")
      fails(await s.run(["disable", "nobody"]), 1, "no account matches")
    },
    SLOW,
  )

  it("own_takes_over_linked_accounts", async () => {
    const s = new Sandbox("own")
    let out = ok(await s.run(["own", "all"]))
    expect(out.stdout).toContain("No accounts follow another tool")

    const linked: Account = {
      ...codex("l@x.dev"),
      link: { tool: "cliproxyapi", path: join(s.home, ".cli-proxy-api/codex-l.json") },
    }
    await s.add(linked)
    await s.add(codex("m@x.dev"))

    out = ok(await s.run(["own", "m@x.dev"]))
    expect(out.stdout).toContain("already refreshes here")
    out = ok(await s.run(["own", "all"]))
    expect(out.stdout).toContain("slopmax now refreshes l@x.dev")
    expect(out.stdout).toContain("was following cliproxyapi")
    expect((await s.account(linked.id)).link).toBeUndefined()
  })

  it(
    "keys_are_added_listed_and_revoked",
    async () => {
      const s = new Sandbox("keys")
      let out = ok(await s.run(["key"]))
      expect(out.stdout).toContain("No client keys")

      const added = ok(await s.run(["key", "add", "laptop", "--models", "gpt-*, claude-* ,"]))
      const secret = added.stdout.trim()
      expect(secret).not.toBe("")
      expect(added.stderr).toContain('Added the key "laptop"')
      ok(await s.run(["key", "add", "phone"]))
      expect(readFileSync(s.config(), "utf8")).toContain(secret)

      let list = ok(await s.run(["key", "list"])).stdout
      expect(list).toContain("laptop")
      expect(list).toContain("gpt-*, claude-*")
      expect(list).toContain("phone")
      expect(list).toContain("any model")
      // Keys are never listed.
      expect(list).not.toContain(secret)

      out = ok(await s.run(["key", "remove", "laptop"]))
      expect(out.stdout).toContain('Revoked the key "laptop"')
      list = ok(await s.run(["key", "list"])).stdout
      expect(list).not.toContain("laptop")
      expect(readFileSync(s.config(), "utf8")).not.toContain(secret)
    },
    SLOW,
  )

  it(
    "usage_totals_the_ledger",
    async () => {
      const s = new Sandbox("usage")
      const out = ok(await s.run(["usage"]))
      expect(out.stdout).toContain("No requests recorded for the last 7 days")

      const a = claude("a@x.dev")
      await s.add(a)
      const now = Date.now()
      await Effect.runPromise(
        ledger.append(join(s.slopmax, "usage"), [
          entry(now, a.id, "claude-sonnet-4-6", 200),
          entry(now, a.id, "claude-sonnet-4-6", 200),
          entry(now, a.id, "mystery-model", 200),
          entry(now, a.id, "claude-sonnet-4-6", 529),
          entry(now - 20 * 24 * 3_600_000, a.id, "claude-opus-4-1", 200),
        ]),
      )

      const week = ok(await s.run(["usage"])).stdout
      expect(week).toContain("DAY")
      expect(week).toContain("total")
      expect(week).toContain("the last 7 days")
      expect(week).toContain("1 request to models without a price")
      expect(week).toContain("1 request failed")

      const models = ok(await s.run(["usage", "today", "--by", "model"])).stdout
      expect(models).toContain("MODEL")
      expect(models).toContain("claude-sonnet-4-6")
      expect(models).toContain("mystery-model")
      expect(models).toContain("Usage for today")

      const accounts = ok(await s.run(["usage", "all", "-b", "account"])).stdout
      expect(accounts).toContain("a@x.dev")
      expect(accounts).toContain("all time")

      const month = json(ok(await s.run(["usage", "30d", "--json"])).stdout)
      expect(field(month, "total", "requests")).toBe(4)
      expect(field(month, "total", "failed")).toBe(1)
      const seven = json(ok(await s.run(["usage", "--json"])).stdout)
      expect(field(seven, "total", "requests")).toBe(3)
    },
    SLOW,
  )

  it(
    "setup_wires_the_agents_and_undo_restores_their_files_exactly",
    async () => {
      const s = new Sandbox("setup")
      const settings = join(s.claude, "settings.json")
      const originalSettings =
        '{\n  "model": "opus",\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://elsewhere.example",\n    "KEEP": "1"\n  }\n}\n'
      writeFileSync(settings, originalSettings)
      const toml = join(s.codex, "config.toml")
      const originalToml =
        '# mine\nmodel = "gpt-5"\nmodel_provider = "other"\n\n[model_providers.other]\nbase_url = "https://other.example/v1"\n'
      writeFileSync(toml, originalToml)

      const base = `http://127.0.0.1:${s.port}`
      let out = ok(await s.run(["setup", "claude"]))
      expect(out.stdout).toContain("Claude Code now uses slopmax")
      const wired = json(readFileSync(settings, "utf8"))
      expect(String(field(wired, "env", "ANTHROPIC_BASE_URL")).startsWith(base)).toBe(true)
      expect(field(wired, "env", "KEEP")).toBe("1")
      expect(wired["model"]).toBe("opus")

      out = ok(await s.run(["setup", "codex"]))
      expect(out.stdout).toContain("Codex now uses slopmax")
      const wiredToml = readFileSync(toml, "utf8")
      expect(wiredToml).toContain(base)
      expect(wiredToml).toContain("# mine")

      // Setting up twice keeps the first backup, so undo still restores the
      // original.
      ok(await s.run(["setup", "claude"]))
      ok(await s.run(["setup", "codex"]))

      const doctor = (await s.run(["doctor"])).stdout
      expect(doctor).toContain("Claude Code")

      out = ok(await s.run(["setup", "claude", "--undo"]))
      expect(out.stdout).toContain("Restored Claude Code")
      expect(json(readFileSync(settings, "utf8"))).toEqual(json(originalSettings))

      out = ok(await s.run(["setup", "codex", "--undo"]))
      expect(out.stdout).toContain("Restored Codex")
      expect(readFileSync(toml, "utf8")).toBe(originalToml)

      fails(await s.run(["setup", "codex", "--undo"]), 1, "no Codex setup to undo")
    },
    SLOW,
  )

  it(
    "setup_on_a_fresh_machine_and_undo_leave_no_wiring",
    async () => {
      const s = new Sandbox("fresh-setup")
      ok(await s.run(["setup", "claude"]))
      ok(await s.run(["setup", "codex"]))
      const settings = join(s.claude, "settings.json")
      const toml = join(s.codex, "config.toml")
      expect(existsSync(settings)).toBe(true)
      expect(existsSync(toml)).toBe(true)

      ok(await s.run(["setup", "claude", "--undo"]))
      ok(await s.run(["setup", "codex", "--undo"]))
      const base = `127.0.0.1:${s.port}`
      expect(readOr(settings)).not.toContain(base)
      expect(readOr(toml)).not.toContain(base)
    },
    SLOW,
  )

  needsBinary("env_prints_shell_setup_for_each_agent", async () => {
    const s = new Sandbox("env")
    const base = `http://127.0.0.1:${s.port}`
    const claudeEnv = ok(await s.run(["env", "claude"])).stdout
    expect(claudeEnv).toContain("ANTHROPIC_BASE_URL")
    expect(claudeEnv).toContain(base)
    const codexEnv = ok(await s.run(["env", "codex"])).stdout
    expect(codexEnv.includes(base) || codexEnv.includes("slopmax")).toBe(true)
  })

  it(
    "doctor_reports_findings_and_fails_on_problems",
    async () => {
      const s = new Sandbox("doctor")
      await s.add({
        ...codex("l@x.dev"),
        link: { tool: "cliproxyapi", path: join(s.home, ".cli-proxy-api/codex-l.json") },
      })
      const signedOut: Account = { ...claude("gone@x.dev"), authError: "refresh token revoked" }
      await s.add(signedOut)
      chmodSync(join(s.slopmax, "accounts", `${signedOut.id}.json`), 0o644)

      // The network is unreachable here, which is a problem.
      const out = await s.run(["doctor"])
      expect(out.code).toBe(1)
      const text = out.stdout
      for (const section of ["Proxy", "Accounts", "Claude Code", "Codex", "CLIProxyAPI", "Network"]) {
        expect(text).toContain(section)
      }
      expect(text).toContain("not running")
      expect(text).toContain("cannot reach Anthropic")
      expect(text).toContain("fix:")
      expect(text).toContain("problem")
      expect(text).toContain("readable by other users")
    },
    SLOW,
  )

  it(
    "doctor_names_what_holds_the_port",
    async () => {
      const s = new Sandbox("doctor-port")
      // Another program holds the port and hangs up on whoever connects.
      const held = Bun.listen({
        hostname: "127.0.0.1",
        port: s.port,
        socket: {
          open(socket) {
            socket.end()
          },
          data() {},
        },
      })
      try {
        const out = await s.run(["doctor"])
        expect(out.code).toBe(1)
        expect(out.stdout).toContain(`port ${s.port} is taken`)
      } finally {
        held.stop(true)
      }
    },
    SLOW,
  )

  it(
    "import_brings_over_codex_and_cliproxyapi_logins",
    async () => {
      const s = new Sandbox("import")
      let out = ok(await s.run(["import"]))
      expect(out.stdout).toContain("No logins found")
      // Without a credentials file, Claude Code's login is looked up in the
      // keychain on macOS (a stub here).
      if (process.platform === "darwin") expect(s.stubCalls()).toContain("security find-generic-password")
      rmSync(join(s.root, "stubs.log"), { force: true })

      // Claude Code's login has expired with nothing to refresh it, so it is
      // skipped without the network or the keychain.
      write(
        join(s.claude, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: 1000 } }),
      )
      write(
        join(s.codex, "auth.json"),
        JSON.stringify({
          tokens: { access_token: "tok-codex", refresh_token: "ref-codex" },
          last_refresh: "2026-10-01T00:00:00Z",
        }),
      )
      const cpa = join(s.home, ".cli-proxy-api")
      write(
        join(cpa, "codex-a.json"),
        JSON.stringify({
          type: "codex",
          access_token: "tok-a",
          refresh_token: "ref-a",
          email: "a@x.dev",
          account_id: "ws-a",
          plan_type: "plus",
          label: "cpa-a",
          priority: "2",
        }),
      )
      write(
        join(cpa, "claude-b.json"),
        JSON.stringify({
          type: "claude",
          access_token: "tok-b",
          refresh_token: "ref-b",
          expired: "2020-01-01T00:00:00Z",
          email: "b@x.dev",
          account_uuid: "uuid-b",
          organization_name: "B Corp",
        }),
      )
      write(join(cpa, "gemini.json"), JSON.stringify({ type: "gemini" }))
      write(join(cpa, "broken.json"), "{")
      write(join(cpa, "empty.json"), JSON.stringify({ type: "codex" }))

      out = ok(await s.run(["import"]))
      const text = out.stdout
      expect(text).toContain("skipped")
      expect(text).toContain("login expired")
      expect(text).toContain("no access token")
      expect(text).toContain("cpa-a")
      expect(text).toContain("b@x.dev")
      expect(text).toContain("linked:")
      expect(text).toContain("note:")
      expect((await s.list()).length).toBe(3)
      const a = await s.account("cpa-a")
      expect(a.priority).toBe(2)
      expect(a.link).toBeDefined()
      expect((await s.account("b@x.dev")).link).toBeDefined()

      // Importing again updates the same accounts; --own stops following.
      out = ok(await s.run(["import", "cliproxyapi", "--own"]))
      expect(out.stdout).toContain("~")
      expect(out.stdout).not.toContain("linked:")
      expect((await s.list()).length).toBe(3)
      expect((await s.account("cpa-a")).link).toBeUndefined()

      out = ok(await s.run(["import", "codex"]))
      expect(out.stdout).toContain("auth.json")
      // The keychain was not consulted.
      expect(s.stubCalls()).not.toContain("security")
    },
    SLOW,
  )

  it(
    "login_with_keys_reads_them_from_stdin",
    async () => {
      const server = endpointServer()
      try {
        const url = `http://127.0.0.1:${server.port}`
        const s = new Sandbox("login")
        const v1 = `${url}/v1/`

        let out = ok(await s.runWith(["login", "compat", "--url", v1], "sk-good\n"))
        expect(out.stdout).toContain("Connected compat account")
        expect(out.stdout).toContain("It serves qwen3, llama4.")
        const account = (await s.list()).at(-1)
        expect(account?.endpoint?.baseUrl).toBe(`${url}/v1`)
        expect(account?.endpoint?.models).toEqual(["qwen3", "llama4"])

        // Connecting it again updates the account.
        out = ok(await s.runWith(["login", "compat", "--url", v1, "--models", "qwen3", "--label", "box"], "sk-good"))
        expect(out.stdout).toContain("Updated compat account box")

        out = await s.runWith(["login", "compat", "--url", v1], "sk-bad")
        expect(out.code).toBe(1)
        expect(out.stderr).toContain("rejected the key")

        out = await s.runWith(["login", "compat", "--url", `${url}/elsewhere`, "--dialect", "messages"], "")
        expect(out.code).toBe(1)
        expect(out.stderr).toContain("name them with --models")

        // A key the provider cannot be asked about (no network here) is kept;
        // with a subscription beside it, it says how it overflows.
        await s.add(claude("a@x.dev"))
        out = ok(await s.runWith(["login", "anthropic"], "sk-ant-api-key\n"))
        expect(out.stdout).toContain("Connected anthropic account")
        expect(out.stdout).toContain("paid_overflow")
        out = ok(await s.runWith(["login", "xai"], "xai-key"))
        expect(out.stdout).toContain("It serves")
        expect(out.stdout).not.toContain("paid_overflow")

        out = await s.runWith(["login", "openai"], "")
        expect(out.code).toBe(1)
        expect(out.stderr).toContain("no OpenAI API key entered")
      } finally {
        server.stop(true)
      }
    },
    SLOW,
  )

  it(
    "sign_ins_that_need_the_network_fail_cleanly",
    async () => {
      const s = new Sandbox("device")
      const out = await s.run(["login", "codex", "--device"])
      expect(out.code).toBe(1)
      expect(out.stderr).toContain("error:")
    },
    SLOW,
  )

  it(
    "redeem_needs_an_account_with_resets",
    async () => {
      const s = new Sandbox("redeem")
      await s.add(key("openai", "sk-openai-1"))
      fails(await s.run(["redeem", "1", "--yes"]), 1, "has no limit resets")
      // Listing a ChatGPT account's resets needs the network.
      await s.add(codex("b@x.dev"))
      fails(await s.run(["redeem", "b@x.dev", "--yes"]), 1, "error:")
    },
    SLOW,
  )

  it("notify_sends_a_test_event_through_the_command", async () => {
    const s = new Sandbox("notify")
    ok(await s.run(["key", "list"]))
    const sent = join(s.root, "sent.txt")
    const config = readFileSync(s.config(), "utf8")
    writeFileSync(s.config(), `${config}\n[notify]\ncommand = "printf '%s' \\"$SLOPMAX_EVENT\\" > '${sent}'"\n`)
    const out = ok(await s.run(["notify"]))
    expect(out.stdout).toContain("Sent a test notification")
    expect(readFileSync(sent, "utf8")).toBe("test")
  })

  it("logs_show_the_tail_of_the_background_log", async () => {
    const s = new Sandbox("logs")
    let out = ok(await s.run(["logs"]))
    expect(out.stdout).toContain("No log yet")
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join("")
    write(join(s.slopmax, "slopmax.log"), lines)
    out = ok(await s.run(["logs", "-n", "3"]))
    expect(out.stdout).toBe("line 48\nline 49\nline 50\n")
    out = ok(await s.run(["logs"]))
    expect(out.stdout.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "").length).toBe(40)
    expect(out.stdout.startsWith("line 11\n")).toBe(true)
  })

  needsBinary(
    "the_background_proxy_starts_reports_and_stops",
    async () => {
      const s = new Sandbox("background")
      await s.add(key("anthropic", "sk-ant-9999"))
      let out = ok(await s.run(["stop"]))
      expect(out.stdout).toContain("slopmax is not running")

      out = ok(await s.run(["start"]))
      expect(out.stdout).toContain("slopmax running on")
      out = ok(await s.run(["start"]))
      expect(out.stdout).toContain("already running")

      // The status now comes from the proxy.
      const report = json(ok(await s.run(["status", "--json"])).stdout)
      expect(accountsOf(report).length).toBe(1)
      const table = ok(await s.run(["status", "--refresh"])).stdout
      expect(table).toContain("ANTHROPIC")

      out = ok(await s.run(["dashboard", "--print"]))
      expect(out.stdout).toContain(`127.0.0.1:${s.port}`)
      expect(out.stdout).toContain("ssh -L")
      // Without --print it asks the system to open it (a stub here).
      out = ok(await s.run(["dashboard"]))
      if (process.platform === "darwin") {
        expect(out.stdout).toContain("Opened the dashboard")
        await eventually("the browser is asked to open it", () => s.stubCalls().includes("open http://127.0.0.1"))
      }

      const doctor = (await s.run(["doctor"])).stdout
      expect(doctor).toContain(`running on http://127.0.0.1:${s.port}`)

      // The agent is not installed here, so `run` cannot start it, but the
      // proxy keeps running.
      fails(await s.run(["run", "codex", "exec", "hi"]), 1, "could not start codex")

      out = ok(await s.run(["stop"]))
      expect(out.stdout).toContain("slopmax stopped")
      await eventually("the proxy exits", async () => (await s.run(["stop"])).stdout.includes("not running"))
      const log = readFileSync(join(s.slopmax, "slopmax.log"), "utf8")
      expect(log).not.toBe("")
    },
    SLOW,
  )

  it(
    "serve_runs_in_the_foreground_until_stopped",
    async () => {
      const s = new Sandbox("serve")
      // Create the config (and its key) first: processes that each find none
      // would each make a key, and the proxy would keep one the file lacks.
      ok(await s.run(["key", "list"]))
      const child = s.spawn(["serve"])
      const connects = () =>
        Bun.connect({ hostname: "127.0.0.1", port: s.port, socket: { data() {} } }).then(
          (socket) => {
            socket.end()
            return true
          },
          () => false,
        )
      await eventually("the proxy answers", async () => (await s.run(["status", "--json"])).code === 0 && connects())
      await eventually("the proxy reports itself", async () => (await s.run(["doctor"])).stdout.includes("running on"))
      ok(await s.run(["stop"]))
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout" as const)])
      if (code === "timeout") {
        child.kill()
        throw new Error("serve kept running")
      }
      expect(code).toBe(0)
    },
    SLOW,
  )

  it("service_commands_find_no_manager_in_the_sandbox", async () => {
    const s = new Sandbox("service")
    for (const action of ["status", "install", "uninstall"]) {
      fails(await s.run(["service", action]), 1, "no supported service manager")
    }
    expect(existsSync(join(s.home, "Library/LaunchAgents"))).toBe(false)
    expect(s.stubCalls()).toBe("")
  })

  it(
    "unattended_setup_with_nothing_to_pool_fails_and_says_what_to_add",
    async () => {
      const s = new Sandbox("init")
      for (const args of [
        ["setup", "--yes", "--import", "none"],
        ["init", "--import", "none"],
      ]) {
        const out = await s.run(args)
        expect(out.code).toBe(1)
        expect(out.stdout).toContain("slopmax setup")
        expect(out.stdout).not.toContain("Routing")
        expect(out.stderr).toContain("no accounts are connected")
        expect(out.stderr).toContain("--import claude-code,codex")
        expect(out.stderr).toContain("--keys-from-env")
      }
      expect(s.stubCalls()).toBe("")
    },
    SLOW,
  )

  it(
    "setup_flags_that_make_no_sense_are_refused",
    async () => {
      const s = new Sandbox("init-flags")
      fails(await s.run(["setup", "--undo"]), 1, "--undo restores one agent: `slopmax setup claude --undo`")
      fails(
        await s.run(["setup", "--strategy", "sideways"]),
        1,
        "--strategy takes reset-first, fill-first, least-used, or round-robin",
      )
      fails(await s.run(["setup", "--affinity", "maybe"]), 1, 'expected on or off, got "maybe"')
      fails(await s.run(["setup", "--login", "xai"]), 1, "--login signs in to subscriptions (claude, codex)")
      fails(await s.run(["setup", "--agents", "grok"]), 1, 'unknown agent "grok"')
      fails(await s.run(["setup", "--import", "dropbox"]), 1, 'unknown source "dropbox"')
      expect(await s.list()).toEqual([])
      expect(s.stubCalls()).toBe("")
    },
    SLOW,
  )

  needsBinary(
    "unattended_setup_imports_routes_wires_and_starts_the_proxy",
    async () => {
      const s = new Sandbox("init-run")
      cliproxyLogin(s)
      // Codex points elsewhere now, and is left alone: only Claude Code is
      // asked for.
      const elsewhere = 'model_provider = "other"\n[model_providers.other]\nbase_url = "https://o.example/v1"\n'
      write(join(s.codex, "config.toml"), elsewhere)

      let out = ok(
        await s.run([
          "setup",
          "--yes",
          "--import",
          "cliproxyapi",
          "--strategy",
          "round-robin",
          "--affinity",
          "off",
          "--agents",
          "claude",
        ]),
      )
      let text = out.stdout
      for (const step of ["Accounts", "Routing", "Agents", "Background"]) expect(text).toContain(step)
      expect(text).toContain("+ a@x.dev")
      expect(text).toContain("routing: round-robin, every request placed afresh")
      expect(text).toContain("wired")
      expect(text).toContain("No login service here")
      expect(text).not.toContain("Start slopmax at login?")
      expect(text).toContain("The proxy is running on")
      expect(text).toContain("Done.")

      expect((await s.list()).length).toBe(1)
      const config = readFileSync(s.config(), "utf8")
      expect(config).toContain('strategy = "round-robin"')
      expect(config).toContain("session_affinity = false")
      expect(readFileSync(join(s.claude, "settings.json"), "utf8")).toContain(`127.0.0.1:${s.port}`)
      expect(readFileSync(join(s.codex, "config.toml"), "utf8")).toBe(elsewhere)

      // Again, with stdin not a terminal (so nothing is asked) and the
      // `init` alias: what is done is noticed, and Codex is wired this time.
      out = ok(await s.run(["init", "--import", "none", "--agents", "claude,codex"]))
      text = out.stdout
      expect(text).toContain("Claude Code already uses slopmax.")
      expect(text).toContain("routing: round-robin, every request placed afresh")
      expect(text).toContain("The proxy is running on")
      expect(readFileSync(join(s.codex, "config.toml"), "utf8")).toContain(`127.0.0.1:${s.port}`)
      expect((await s.list()).length).toBe(1)
      expect(s.stubCalls()).toBe("")

      // Claude Code was wired by name with no Claude account to serve it:
      // the doctor says so.
      const doctor = await s.run(["doctor"])
      expect(doctor.stdout).toContain("points at slopmax, but no Claude account is connected")

      out = ok(await s.run(["stop"]))
      expect(out.stdout).toContain("slopmax stopped")
    },
    SLOW,
  )

  needsBinary(
    "unattended_setup_leaves_alone_an_agent_it_has_no_account_for",
    async () => {
      const s = new Sandbox("init-unserved")
      cliproxyLogin(s)
      const out = ok(await s.run(["setup", "--yes", "--import", "cliproxyapi", "--no-service"]))
      const text = out.stdout
      expect(text).toContain("Claude Code left as it is: no Claude account to serve it.")
      expect(text).toContain("1 account behind")
      // Claude Code keeps working as it did; Codex goes through slopmax.
      expect(existsSync(join(s.claude, "settings.json"))).toBe(false)
      expect(readFileSync(join(s.codex, "config.toml"), "utf8")).toContain(`127.0.0.1:${s.port}`)
      ok(await s.run(["stop"]))
    },
    SLOW,
  )

  needsBinary(
    "unattended_setup_that_misses_part_of_what_was_asked_says_so",
    async () => {
      const s = new Sandbox("init-partial")
      cliproxyLogin(s)
      // CLIProxyAPI has a login; Codex's own home has none.
      const out = await s.run(["setup", "--yes", "--import", "cliproxyapi,codex", "--agents", "none", "--no-service"])
      expect(out.code).toBe(1)
      // The rest went through.
      expect(out.stdout).toContain("Done.")
      expect(out.stderr).toContain("--import codex found no login to take")
      expect((await s.list()).length).toBe(1)
      ok(await s.run(["stop"]))
    },
    SLOW,
  )
})

describe("cli, beyond the Rust tests", () => {
  it("the_app_host_is_hidden_and_speaks_its_protocol", async () => {
    const s = new Sandbox("app-host")
    const help = ok(await s.run(["--help"])).stdout
    expect(help).not.toContain("app-host")
    expect(ok(await s.run(["completions", "bash"])).stdout).not.toContain("app-host")
    // With stdin closed, the host greets the shell and stops.
    const out = ok(await s.run(["app-host"]))
    const first = JSON.parse(out.stdout.split("\n")[0] ?? "") as Record<string, unknown>
    expect(first).toEqual({ _tag: "Hello", protocol: 1, version: VERSION })
  })

  needsBinary(
    "run_hands_the_agent_the_terminal_and_returns_its_code",
    async () => {
      const s = new Sandbox("run")
      const agent = join(s.stubs, "codex")
      writeFileSync(agent, '#!/bin/sh\necho "args: $*"\nread line\necho "read: $line"\nexit 7\n')
      chmodSync(agent, 0o755)
      const out = await s.runWith(["run", "codex", "exec", "--help", "-1"], "typed\n")
      expect(out.code).toBe(7)
      expect(out.stdout).toContain("read: typed")
      expect(out.stdout).toContain(`model_providers.slopmax.base_url="http://127.0.0.1:${s.port}/codex"`)
      // The rest goes to the agent verbatim, flags and all.
      const args = out.stdout.split("\n")[0] ?? ""
      expect(args.startsWith("args: exec -c ")).toBe(true)
      expect(args.endsWith(" --help -1")).toBe(true)
      ok(await s.run(["stop"]))
    },
    SLOW,
  )

  needsBinary("a_first_argument_of_dashes_is_an_unexpected_argument", async () => {
    const s = new Sandbox("dashes")
    const out = await s.run(["--", "status"])
    expect(out.code).toBe(2)
    expect(out.stderr).toBe(
      "error: unexpected argument '--'\n\nUsage: slopmax [COMMAND]\n\nFor more information, try '--help'.\n",
    )
    expect(out.stdout).toBe("")
  })

  it(
    "secrets_are_typed_without_echo_at_a_terminal",
    async () => {
      const s = new Sandbox("secret")
      // Typed with a slip, corrected with Backspace.
      const out = await s.runAtTerminal(["login", "xai"], [["xAI API key: ", "abx\x7fd\r"]])
      expect(out.code).toBe(0)
      // Nothing typed shows: the prompt's line ends as soon as it is entered.
      expect(out.stdout.startsWith("xAI API key: \n")).toBe(true)
      expect(out.stdout).not.toContain("abx")
      expect(out.stdout).toContain("Connected xai account \x1b[1mxAI API key …abd\x1b[0m")
      expect((await s.list())[0]?.tokens.accessToken).toBe("abd")
    },
    SLOW,
  )

  it(
    "a_bare_slopmax_at_a_terminal_with_no_accounts_starts_the_setup",
    async () => {
      const s = new Sandbox("bare")
      const out = await s.runAtTerminal([], [["Numbers, e.g. 1,3", "0\r"]])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain("\x1b[1mslopmax setup\x1b[0m")
      expect(out.stdout).toContain("\x1b[32m•\x1b[0m \x1b[2m 1\x1b[0m claude")
      expect(out.stdout).toContain("No accounts yet. Run `slopmax setup` again")
    },
    SLOW,
  )

  it("colors_follow_the_terminal_and_no_color", async () => {
    const s = new Sandbox("colors")
    const colored = await s.runAtTerminal(["status", "--watch", "--json"], [])
    expect(colored.code).toBe(1)
    expect(colored.stdout).toBe("\x1b[31merror:\x1b[0m --json cannot be combined with --watch\n")
    // `NO_COLOR` set, even empty, turns them off.
    const plain = await s.runAtTerminal(["status", "--watch", "--json"], [], { NO_COLOR: "" })
    expect(plain.stdout).toBe("error: --json cannot be combined with --watch\n")
  })

  it("errors_name_their_causes_and_exit_1", async () => {
    const s = new Sandbox("errors")
    const out = await s.run(["status"], { env: { SLOPMAX_LISTEN: "not-an-address" } })
    expect(out).toEqual({
      code: 1,
      stdout: "",
      stderr: 'error: SLOPMAX_LISTEN="not-an-address" is not an address: invalid socket address syntax\n',
    })
    // Colors follow stdout, which is not a terminal here, so `NO_COLOR` changes nothing.
    expect(await s.run(["status"], { env: { SLOPMAX_LISTEN: "x", NO_COLOR: "" } })).toEqual({
      code: 1,
      stdout: "",
      stderr: 'error: SLOPMAX_LISTEN="x" is not an address: invalid socket address syntax\n',
    })
  })
})
