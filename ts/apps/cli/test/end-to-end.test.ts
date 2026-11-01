// The slopmax binary end to end, each test in its own sandbox (sandbox.ts).
import { expect } from "bun:test"
import { slopmaxVersion } from "@slopmax/domain"
import { DateTime, Effect } from "effect"
import { cliSuite, keyAccount, type Ran, subscription } from "./sandbox.ts"

const ok = (ran: Ran): Ran => {
  if (ran.code !== 0) throw new Error(`expected success: ${JSON.stringify(ran, null, 2)}`)
  return ran
}

const fails = (ran: Ran, code: number, says: string): Ran => {
  if (ran.code !== code || !ran.stderr.includes(says)) {
    throw new Error(`expected exit ${code} saying ${JSON.stringify(says)}: ${JSON.stringify(ran, null, 2)}`)
  }
  return ran
}

const json = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`not an object: ${text}`)
  return Object.fromEntries(Object.entries(parsed))
}

const list = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.map((item: unknown) => json(JSON.stringify(item))) : []

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A token whose claims Codex's importer reads. */
const jwt = (claims: Record<string, unknown>) => `${base64url({ alg: "none" })}.${base64url(claims)}.sig`

const codexLogin = (email: string, account: string) =>
  JSON.stringify({
    tokens: {
      id_token: jwt({
        email,
        "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" },
      }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "ref-codex",
    },
    last_refresh: new Date().toISOString(),
  })

const cliProxyApiLogin = (email: string, account: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "codex",
    access_token: `tok-${email}`,
    refresh_token: `ref-${email}`,
    email,
    account_id: account,
    ...extra,
  })

cliSuite("the slopmax binary", (test) => {
  test("prints help, its version and completion scripts, and creates nothing doing so", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("help")
      const help = ok(yield* s.run(["--help"]))
      expect(help.stdout).toContain("pools every account")
      expect(help.stdout).toContain("setup, init")
      expect(ok(yield* s.run(["--version"])).stdout).toBe(`slopmax ${slopmaxVersion}\n`)
      expect(ok(yield* s.run(["usage", "--help"])).stdout).toContain("--by")
      expect(ok(yield* s.run(["login", "--help"])).stdout).toContain("compat")
      for (const shell of ["bash", "zsh", "fish"]) {
        const script = ok(yield* s.run(["--completions", shell])).stdout
        expect(script).toContain("slopmax")
        expect(script).toContain("setup")
      }
      expect(yield* s.exists(s.slopmax)).toBe(false)
    }))

  test("explains mistakes and fails: 2 for the parser's, 1 for a command's", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("mistakes")
      fails(yield* s.run(["statsu"]), 2, "status")
      fails(yield* s.run(["label"]), 2, "account")
      fails(yield* s.run(["--completions", "tcsh"]), 2, "tcsh")
      fails(yield* s.run(["status", "--frobnicate"]), 2, "--frobnicate")
      fails(yield* s.run(["usage", "fortnight"]), 2, "fortnight")
      fails(yield* s.run(["import", "nowhere"]), 2, "nowhere")
      fails(yield* s.run(["status", "--watch", "--json"]), 1, "--json cannot be combined with --watch")
      fails(yield* s.run(["key", "remove", "ghost"]), 1, 'no key named "ghost"')
      fails(yield* s.run(["login", "compat"]), 1, "--url <base url>")
      fails(yield* s.run(["login", "claude", "--url", "http://localhost:1/v1"]), 1, "are for `slopmax login compat`")
      fails(yield* s.run(["login", "compat", "--url", "ftp://host"]), 1, "http:// or https://")
      fails(yield* s.run(["login", "claude", "--device"]), 1, "--device works for ChatGPT accounts")
      fails(yield* s.run(["notify"]), 1, "notifications are off")
      fails(yield* s.run(["label", "1", "work"]), 1, 'no account matches "1"')
      fails(yield* s.run(["setup", "claude", "--undo"]), 1, "no Claude Code setup to undo")
      fails(yield* s.run(["config", "listen", "x"]), 1, "is not a setting slopmax changes while it runs")
      fails(yield* s.run(["config", "pollMinutes", "often"]), 1, "")
      // A settings file that does not load is reported, never rewritten.
      yield* s.write(s.config, "{ not json")
      fails(yield* s.run(["status"]), 1, "error:")
      expect(yield* s.read(s.config)).toBe("{ not json")
    }))

  test("names a SLOPMAX_LISTEN that is not an address", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("listen")
      const ran = yield* s.run(["status"], { env: { SLOPMAX_LISTEN: "not-an-address" } })
      expect(ran.code).toBe(1)
      expect(ran.stderr).toContain("SLOPMAX_LISTEN")
      expect(ran.stdout).toBe("")
    }))

  test("shows the accounts on disk, as a table and as JSON", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("status")
      const empty = ok(yield* s.run([]))
      expect(empty.stdout).toContain("No accounts yet")
      // The first run makes the settings, with an owner key and their schema beside them.
      expect(yield* s.read(s.config)).toContain('"apiKey": "sm-')
      expect(yield* s.exists(`${s.slopmax}/config.schema.json`)).toBe(true)

      yield* s.add(yield* subscription("claude", "a@x.dev", "max 20x"))
      yield* s.add(yield* subscription("codex", "b@x.dev", "pro"))
      yield* s.add(yield* keyAccount("anthropic", "sk-ant-1234"))
      const report = json(ok(yield* s.run(["status", "--json"])).stdout)
      expect(report.live).toBe(false)
      const names = list(report.accounts).map((account) => account.name)
      expect(names).toEqual(["a@x.dev", "b@x.dev", "Anthropic API key …1234"])
      const table = ok(yield* s.run(["ls"])).stdout
      for (const text of ["CLAUDE", "CODEX", "ANTHROPIC", "a@x.dev", "max 20x", "per token", "proxy not running"]) {
        expect(table).toContain(text)
      }
      // Without a terminal, a bare `slopmax` is `status`.
      expect(ok(yield* s.run([])).stdout).toBe(table)
    }))

  test("refreshes usage offline and reports unreachable providers without failing", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("refresh")
      yield* s.add(yield* subscription("codex", "b@x.dev", "pro"))
      const ran = ok(yield* s.run(["status", "--refresh"]))
      expect(ran.stdout).toContain("b@x.dev")
      expect(ran.stdout).toContain("last error")
      const report = json(ok(yield* s.run(["status", "-r", "--json"])).stdout)
      expect(list(report.accounts).length).toBe(1)
    }))

  test("changes accounts: label, priority, disable, enable, pin and remove", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("accounts")
      const a = yield* subscription("claude", "a@x.dev", "max 20x")
      yield* s.add(a)
      yield* s.add(yield* subscription("claude", "b@x.dev", "max 5x"))
      expect(ok(yield* s.run(["label", "a@x.dev", "work"])).stdout).toContain(`Renamed ${a.id} to work`)
      expect(ok(yield* s.run(["priority", "work", "-1"])).stdout).toBe("work now has priority -1\n")
      expect(ok(yield* s.run(["disable", "work"])).stdout).toBe("Disabled work\n")
      expect(ok(yield* s.run(["enable", a.id.slice(0, 12)])).stdout).toBe("Enabled work\n")
      let files = (yield* s.accountFiles).join("\n")
      expect(files).toContain('"label": "work"')
      expect(files).toContain('"priority": -1')
      expect(files).toContain('"disabled": false')
      // Priority -1 puts it after b@x.dev, so it is now the second account.
      expect(ok(yield* s.run(["use", "2"])).stdout).toBe("New claude sessions will use work while it has quota.\n")
      expect(yield* s.read(`${s.slopmax}/state.json`)).toContain(a.id)
      expect(ok(yield* s.run(["use", "auto"])).stdout).toBe("slopmax will choose accounts automatically.\n")
      expect(ok(yield* s.run(["label", "work"])).stdout).toContain("it shows as a@x.dev")
      fails(yield* s.run(["remove", "x.dev"]), 1, "no account matches")
      fails(yield* s.run(["remove", "claude-"]), 1, "matches 2 accounts")
      expect(ok(yield* s.run(["remove", "a@x.dev"])).stdout).toBe("Removed a@x.dev\n")
      files = (yield* s.accountFiles).join("\n")
      expect(files).not.toContain("a@x.dev")
      expect(files).toContain("b@x.dev")
    }))

  test("takes over refreshing the accounts it follows from CLIProxyAPI", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("own")
      expect(ok(yield* s.run(["own", "all"])).stdout).toBe("No accounts follow another tool.\n")
      yield* s.write(`${s.home}/.cli-proxy-api/codex-a.json`, cliProxyApiLogin("a@x.dev", "ws-a"))
      ok(yield* s.run(["import", "cliproxyapi"]))
      expect((yield* s.accountFiles).join("\n")).toContain('"follows"')
      const owned = ok(yield* s.run(["own", "all"])).stdout
      expect(owned).toContain("slopmax now refreshes a@x.dev (was following CLIProxyAPI)")
      expect(owned).toContain("keep the other tool stopped")
      expect((yield* s.accountFiles).join("\n")).not.toContain('"follows"')
      expect(ok(yield* s.run(["own", "1"])).stdout).toBe("a@x.dev already refreshes here.\n")
    }))

  test("adds, lists and revokes client keys, showing a key's secret only once", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("keys")
      expect(ok(yield* s.run(["key"])).stdout).toContain("No client keys")
      const added = ok(yield* s.run(["key", "add", "laptop", "--models", "gpt-*, claude-*"]))
      const secret = added.stdout.trim()
      expect(secret).toMatch(/^sm-/)
      expect(added.stderr).toContain('Added the key "laptop"')
      expect(yield* s.read(s.config)).toContain(secret)
      ok(yield* s.run(["key", "add", "ci"]))
      const listed = ok(yield* s.run(["key", "list"])).stdout
      expect(listed).toBe("laptop gpt-*, claude-*\nci any model\n")
      expect(listed).not.toContain(secret)
      expect(ok(yield* s.run(["key", "remove", "laptop"])).stdout).toBe('Revoked the key "laptop".\n')
      expect(yield* s.read(s.config)).not.toContain(secret)
      fails(yield* s.run(["key", "add", "ci"]), 1, "ci")
    }))

  test("totals the ledger by day, model or account, with what it would cost", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("usage")
      const a = yield* subscription("claude", "a@x.dev", "max 20x")
      yield* s.add(a)
      const now = DateTime.nowUnsafe()
      const at = DateTime.formatIso(DateTime.subtract(now, { minutes: 5 }))
      const request = (model: string, status: number) =>
        JSON.stringify({
          _tag: "Request",
          at,
          account: a.id,
          provider: "claude",
          model,
          status,
          usage: { requests: 1, input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
          ms: 1200,
          agent: "claude-code",
        })
      const month = DateTime.formatIsoDateUtc(now).slice(0, 7)
      yield* s.write(
        `${s.slopmax}/usage/${month}.ndjson`,
        [request("claude-opus-4-5", 200), request("claude-opus-4-5", 200), request("claude-haiku-4-5", 529)].join(
          "\n",
        ) + "\n",
      )
      const totals = json(ok(yield* s.run(["usage", "--json"])).stdout)
      const total = json(JSON.stringify(totals.total))
      expect(total.requests).toBe(2)
      expect(total.failed).toBe(1)
      expect(totals).toHaveProperty("leftOnTheTable")
      const byModel = ok(yield* s.run(["usage", "today", "--by", "model"])).stdout
      expect(byModel).toContain("claude-opus-4-5")
      expect(byModel).toContain("total")
      expect(byModel).toContain("1 request failed")
      expect(ok(yield* s.run(["usage", "-b", "account"])).stdout).toContain("a@x.dev")
    }))

  test("wires the agents and undoes it, giving back their files byte for byte", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("setup")
      // As Claude Code writes it: two-space JSON.
      const claudeSettings = `${JSON.stringify({ model: "opus", env: { FOO: "1" }, permissions: { allow: [] } }, null, 2)}\n`
      const codexConfig = '# my settings\nmodel = "gpt-5"  # keep\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n'
      yield* s.write(`${s.claude}/settings.json`, claudeSettings)
      yield* s.write(`${s.codex}/config.toml`, codexConfig)
      const wired = ok(yield* s.run(["setup", "claude"]))
      expect(wired.stdout).toContain(`Claude Code now uses slopmax (${s.claude}/settings.json)`)
      expect(wired.stdout).toContain("no Claude account is connected")
      expect(yield* s.read(`${s.claude}/settings.json`)).toContain(`127.0.0.1:${s.port}`)
      ok(yield* s.run(["setup", "codex"]))
      // A second setup keeps the first backup, so the undo still gives back the original.
      ok(yield* s.run(["setup", "codex"]))
      expect(yield* s.read(`${s.codex}/config.toml`)).toContain(`127.0.0.1:${s.port}/codex`)
      expect(ok(yield* s.run(["setup", "claude", "--undo"])).stdout).toContain("Restored Claude Code")
      expect(ok(yield* s.run(["setup", "codex", "--undo"])).stdout).toContain("Restored Codex")
      expect(yield* s.read(`${s.claude}/settings.json`)).toBe(claudeSettings)
      expect(yield* s.read(`${s.codex}/config.toml`)).toBe(codexConfig)
      fails(yield* s.run(["setup", "codex", "--undo"]), 1, "no Codex setup to undo")
    }))

  test("leaves no wiring behind after setting up and undoing on a fresh machine", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("fresh")
      ok(yield* s.run(["setup", "claude"]))
      ok(yield* s.run(["setup", "codex"]))
      ok(yield* s.run(["setup", "claude", "--undo"]))
      ok(yield* s.run(["setup", "codex", "--undo"]))
      expect(yield* s.read(`${s.claude}/settings.json`)).not.toContain("slopmax")
      expect(yield* s.read(`${s.claude}/settings.json`)).not.toContain(String(s.port))
      expect(yield* s.read(`${s.codex}/config.toml`)).not.toContain("slopmax")
    }))

  test("prints the shell setup that points each agent at the proxy", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("env")
      const claude = ok(yield* s.run(["env", "claude"])).stdout
      expect(claude).toContain(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${s.port}/claude\n`)
      expect(claude).toMatch(/export ANTHROPIC_AUTH_TOKEN=sm-/)
      expect(claude).toContain("export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1\n")
      expect(claude.endsWith("unset ANTHROPIC_API_KEY\n")).toBe(true)
      const codex = ok(yield* s.run(["env", "codex"])).stdout
      expect(codex).toMatch(/^codex\(\) \{ .+ run codex "\$@"; \}\n$/)
    }))

  test("checks the setup, says how to fix what fails, and exits 1 when something does", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("doctor")
      const ran = yield* s.run(["doctor"])
      expect(ran.code).toBe(1)
      expect(ran.stdout).toContain("Proxy")
      expect(ran.stdout).toContain("! not running")
      expect(ran.stdout).toContain("✗ no accounts connected")
      expect(ran.stdout).toContain("fix: ")
      expect(ran.stdout).toMatch(/\d+ problems?, \d+ warnings?\./)
      const sections = JSON.parse((yield* s.run(["doctor", "--json"])).stdout)
      expect(Array.isArray(sections)).toBe(true)
    }))

  test("names what holds the proxy's port when it is not slopmax", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("port")
      const squatter = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: s.port, socket: { data() {} } })),
        (listener) => Effect.sync(() => listener.stop(true)),
      )
      expect(squatter.port).toBe(s.port)
      const ran = yield* s.run(["doctor"])
      expect(ran.code).toBe(1)
      expect(ran.stdout).toContain(`port ${s.port} is taken by`)
    }))

  test("imports Codex's and CLIProxyAPI's logins, saying what it skipped", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("import")
      expect(ok(yield* s.run(["import"])).stdout).toBe("No logins found to import.\n")
      yield* s.write(`${s.codex}/auth.json`, codexLogin("c@x.dev", "ws-c"))
      const cpa = `${s.home}/.cli-proxy-api`
      yield* s.write(`${cpa}/codex-a.json`, cliProxyApiLogin("a@x.dev", "ws-a", { priority: "2", label: "cpa-a" }))
      yield* s.write(`${cpa}/gemini.json`, JSON.stringify({ type: "gemini" }))
      yield* s.write(`${cpa}/broken.json`, "{")
      yield* s.write(`${cpa}/empty.json`, JSON.stringify({ type: "codex" }))
      const first = ok(yield* s.run(["import"])).stdout
      expect(first).toContain("+ codex c@x.dev from")
      expect(first).toContain("+ codex cpa-a from")
      expect(first).toContain("skipped")
      expect(first).toContain("no access token")
      expect(first).toContain("linked:")
      expect(first).toContain("note:")
      const files = yield* s.accountFiles
      expect(files.length).toBe(2)
      expect(files.join("\n")).toContain('"priority": 2')
      // Again: the same accounts are updated, and `--own` stops following CLIProxyAPI's copy.
      const again = ok(yield* s.run(["import", "cliproxyapi", "--own"])).stdout
      expect(again).toContain("~ codex cpa-a")
      expect(again).not.toContain("linked:")
      expect((yield* s.accountFiles).length).toBe(2)
      expect((yield* s.accountFiles).join("\n")).not.toContain('"follows"')
      expect(ok(yield* s.run(["import", "codex"])).stdout).toContain("auth.json")
      // The macOS keychain is never asked here.
      expect(yield* s.stubCalls).not.toContain("security")
    }))

  test("reads keys from stdin, checks endpoints, and keeps a key it cannot check", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("login")
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              const path = new URL(request.url).pathname
              if (path !== "/v1/models") return new Response("", { status: 404 })
              return request.headers.get("authorization") === "Bearer sk-good"
                ? Response.json({ data: [{ id: "qwen3" }, { id: "llama4" }] })
                : new Response("{}", { status: 401 })
            },
          }),
        ),
        (served) => Effect.promise(() => served.stop(true)),
      )
      const v1 = `http://127.0.0.1:${server.port}/v1/`
      // The endpoint is local, so it is reached directly, not through the dead proxy.
      const local = { NO_PROXY: "127.0.0.1" }
      let ran = ok(yield* s.run(["login", "compat", "--url", v1], { input: "sk-good\n", env: local }))
      expect(ran.stdout).toContain("Connected compat account")
      expect(ran.stdout).toContain("It serves qwen3, llama4.")
      ran = ok(
        yield* s.run(["login", "compat", "--url", v1, "--models", "qwen3", "--label", "box"], {
          input: "sk-good",
          env: local,
        }),
      )
      expect(ran.stdout).toContain("Updated compat account box")
      fails(yield* s.run(["login", "compat", "--url", v1], { input: "sk-bad", env: local }), 1, "")
      // No network: the key cannot be checked, so it is kept; with a Claude account beside it, it says how it overflows.
      yield* s.add(yield* subscription("claude", "a@x.dev", "max 20x"))
      ran = ok(yield* s.run(["login", "anthropic"], { input: "sk-ant-api-key\n" }))
      expect(ran.stdout).toContain("Connected anthropic account")
      expect(ran.stdout).toContain("paid overflow")
      ran = ok(yield* s.run(["login", "xai", "--label", "grok"], { input: "xai-key" }))
      expect(ran.stdout).toContain("It serves grok-*.")
      fails(yield* s.run(["login", "openai"], { input: "" }), 1, "no OpenAI API key entered")
    }))

  test("fails a sign-in that needs the network cleanly", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("device")
      fails(yield* s.run(["login", "codex", "--device"]), 1, "error:")
    }))

  test("redeems only on accounts that bank limit resets, and fails when it cannot ask", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("redeem")
      yield* s.add(yield* keyAccount("openai", "sk-openai-1"))
      fails(yield* s.run(["redeem", "1", "--yes"]), 1, "has no limit resets")
      yield* s.add(yield* subscription("codex", "b@x.dev", "pro"))
      fails(yield* s.run(["redeem", "b@x.dev", "--yes"]), 1, "error:")
    }))

  test("sends a test notification through the configured command", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("notify")
      ok(yield* s.run(["key", "list"]))
      const sent = s.at("sent.txt")
      const settings = json(yield* s.read(s.config))
      yield* s.write(
        s.config,
        JSON.stringify({ ...settings, notify: { command: `printf '%s' "$SLOPMAX_EVENT" > '${sent}'` } }, null, 2),
      )
      expect(ok(yield* s.run(["notify"])).stdout).toBe("Sent a test notification.\n")
      expect(yield* s.read(sent)).toBe("test")
    }))

  test("shows the tail of the background log", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("logs")
      expect(ok(yield* s.run(["logs"])).stdout).toContain("No log yet")
      yield* s.write(s.log, Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join(""))
      expect(ok(yield* s.run(["logs", "-n", "3"])).stdout).toBe("line 48\nline 49\nline 50\n")
      const all = ok(yield* s.run(["logs"])).stdout
      expect(all.split("\n").length - 1).toBe(40)
      expect(all.startsWith("line 11\n")).toBe(true)
    }))

  test("follows the log as it grows, and from its start again once it is truncated", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("follow")
      const follow = yield* s.watching(["logs", "-f", "-n", "1"])
      yield* s.eventually(
        "it says there is no log yet",
        Effect.map(follow.printed, (text) => text.includes("No log yet")),
      )
      yield* s.write(s.log, "first\nsecond\n")
      yield* s.eventually(
        "it prints the last line once the log appears",
        Effect.map(follow.printed, (text) => text.endsWith("second\n")),
      )
      expect(yield* follow.printed).not.toContain("first")
      yield* s.write(s.log, "first\nsecond\nthird\n")
      yield* s.eventually(
        "it prints what was added",
        Effect.map(follow.printed, (text) => text.endsWith("second\nthird\n")),
      )
      yield* s.write(s.log, "fresh\n")
      yield* s.eventually(
        "it reads a truncated log from its start",
        Effect.map(follow.printed, (text) => text.endsWith("third\nfresh\n")),
      )
      expect(yield* follow.handle.isRunning).toBe(true)
    }))

  test(
    "keeps the status up to date, following a proxy while one runs and the files when none does",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("watch")
        yield* s.add(yield* keyAccount("anthropic", "sk-ant-9999"))
        const watch = yield* s.watching(["status", "--watch"])
        const shows = (what: string, text: string) =>
          s.eventually(
            what,
            Effect.map(watch.screen, (screen) => screen.includes(text)),
          )
        yield* shows("the report from the files", "proxy not running")
        ok(yield* s.run(["start"]))
        yield* shows("the running proxy's report", "proxy running")
        // A change the proxy makes is drawn as it says so.
        ok(yield* s.run(["config", "strategy", "fill-first"]))
        yield* shows("the new strategy", "strategy fill-first · proxy running")
        ok(yield* s.run(["stop"]))
        yield* shows("the proxy's last report, as the last known state", "fill-first · proxy not running")
        expect(yield* watch.handle.isRunning).toBe(true)
      }),
    120_000,
  )

  test(
    "starts the proxy in the background, reports from it, and stops it",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("background")
        yield* s.add(yield* keyAccount("anthropic", "sk-ant-9999"))
        expect(ok(yield* s.run(["stop"])).stdout).toBe("slopmax is not running\n")
        expect(ok(yield* s.run(["start"])).stdout).toContain(`slopmax running on http://127.0.0.1:${s.port}`)
        expect(ok(yield* s.run(["start"])).stdout).toContain("already running")
        const started = json(ok(yield* s.run(["start", "--json"])).stdout)
        expect(started).toMatchObject({ url: `http://127.0.0.1:${s.port}`, version: slopmaxVersion, log: s.log })
        expect(String(started.dashboard)).toContain("/slopmax/#key=sm-")
        const report = json(ok(yield* s.run(["status", "--json"])).stdout)
        expect(report.live).toBe(true)
        expect(list(report.accounts).length).toBe(1)
        expect(ok(yield* s.run(["status", "--refresh"])).stdout).toContain("proxy running")
        // Changes reach the running proxy at once.
        expect(ok(yield* s.run(["config", "strategy", "fill-first"])).stdout).toContain("(applied now)")
        expect(json(ok(yield* s.run(["status", "--json"])).stdout).strategy).toBe("fill-first")
        const dashboard = ok(yield* s.run(["dashboard", "--print"])).stdout
        expect(dashboard).toContain(`http://127.0.0.1:${s.port}/slopmax/#key=`)
        expect(dashboard).toContain(`ssh -L ${s.port}:127.0.0.1:${s.port}`)
        expect((yield* s.run(["doctor"])).stdout).toContain(`running on http://127.0.0.1:${s.port}`)
        // Codex is not installed here, so it cannot start, and the proxy keeps running.
        fails(yield* s.run(["run", "codex", "exec", "hi"]), 1, "could not start codex")
        expect(ok(yield* s.run(["stop"])).stdout).toBe("slopmax stopped\n")
        expect(ok(yield* s.run(["stop"])).stdout).toBe("slopmax is not running\n")
        expect(yield* s.read(s.log)).toContain("listening on")
      }),
    120_000,
  )

  test(
    "serves in the foreground, appending to its log, until it is stopped",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("serve")
        // The settings first: processes that each found none would each make an owner key.
        ok(yield* s.run(["key", "list"]))
        const log = s.at("serve.log")
        yield* s.write(log, "an earlier line\n")
        const serve = yield* s.spawn(["serve", "--log", log])
        yield* s.eventually(
          "the proxy answers",
          Effect.map(s.run(["status", "--json"]), (ran) => ran.stdout.includes('"live": true')),
        )
        ok(yield* s.run(["stop"]))
        expect(Number(yield* serve.exitCode)).toBe(0)
        const written = yield* s.read(log)
        expect(written.startsWith("an earlier line\n")).toBe(true)
        expect(written).toContain("listening on")
        expect(written).toContain("stopped")
      }),
    120_000,
  )

  test("starts the guided setup at a terminal when there is no account yet", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("bare")
      // Nothing to pool: Select All, then Inverse Selection, leaves none chosen.
      const ran = yield* s.atTerminal([], [["Which accounts will slopmax pool?", " ↓ \r"]])
      expect(ran.code).toBe(0)
      expect(ran.shown).toContain("\x1b[1mslopmax setup\x1b[0m")
      expect(ran.shown).toContain("claude")
      expect(ran.shown).toContain("No accounts yet. Run `slopmax setup` again")
    }))

  test("takes a key typed at a terminal without showing it", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("secret")
      const ran = yield* s.atTerminal(["login", "xai"], [["xAI API key", "xai-secret-typed\r"]])
      expect(ran.code).toBe(0)
      expect(ran.shown).not.toContain("xai-secret-typed")
      expect(ran.shown).toContain("Connected xai account")
      expect((yield* s.accountFiles).join("\n")).toContain("xai-secret-typed")
    }))

  test("finds no login service in the sandbox, and touches none", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("service")
      for (const action of ["status", "install", "uninstall"]) {
        fails(yield* s.run(["service", action]), 1, "no supported service manager")
      }
      expect(yield* s.exists(`${s.home}/Library/LaunchAgents`)).toBe(false)
      expect(yield* s.stubCalls).toBe("")
    }))

  test("fails an unattended setup with nothing to pool, saying what to add", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("nothing")
      for (const args of [
        ["setup", "--yes", "--import", "none"],
        ["init", "--import", "none"],
      ]) {
        const ran = yield* s.run(args)
        expect(ran.code).toBe(1)
        expect(ran.stdout).toContain("slopmax setup")
        expect(ran.stdout).not.toContain("Routing")
        expect(ran.stderr).toContain("no accounts are connected")
        expect(ran.stderr).toContain("--import claude-code,codex")
        expect(ran.stderr).toContain("--keys-from-env")
      }
      expect(yield* s.stubCalls).toBe("")
    }))

  test("refuses setup flags that make no sense before touching anything", (sandbox) =>
    Effect.gen(function* () {
      const s = yield* sandbox("flags")
      fails(yield* s.run(["setup", "--undo"]), 1, "--undo restores one agent: `slopmax setup claude --undo`")
      fails(yield* s.run(["setup", "--strategy", "sideways"]), 2, "sideways")
      fails(yield* s.run(["setup", "--affinity", "maybe"]), 2, "maybe")
      fails(yield* s.run(["setup", "--login", "xai"]), 1, "--login signs in to subscriptions (claude, codex)")
      fails(yield* s.run(["setup", "--agents", "grok"]), 1, 'unknown agent "grok"')
      fails(yield* s.run(["setup", "--import", "dropbox"]), 1, 'unknown source "dropbox"')
      expect(yield* s.accountFiles).toEqual([])
      expect(yield* s.exists(`${s.claude}/settings.json`)).toBe(false)
      expect(yield* s.stubCalls).toBe("")
    }))

  test(
    "sets up unattended: imports, routes, wires and starts the proxy",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("unattended")
        yield* s.write(`${s.home}/.cli-proxy-api/codex-a.json`, cliProxyApiLogin("a@x.dev", "ws-a"))
        // Codex points elsewhere and is not asked for, so it is left alone.
        const elsewhere = 'model_provider = "other"\n[model_providers.other]\nbase_url = "https://o.example/v1"\n'
        yield* s.write(`${s.codex}/config.toml`, elsewhere)
        let text = ok(
          yield* s.run([
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
        ).stdout
        for (const step of ["Accounts", "Routing", "Agents", "Background", "Done."]) expect(text).toContain(step)
        expect(text).toContain("+ a@x.dev")
        expect(text).toContain("routing: round-robin, every request placed afresh")
        expect(text).toContain("Claude Code has no Claude account to serve it yet")
        expect(text).toContain("wired")
        expect(text).toContain("No login service here")
        expect(text).toContain("The proxy is running on")
        const settings = json(yield* s.read(s.config))
        expect(settings).toMatchObject({ strategy: "round-robin", sessionAffinity: false })
        expect(yield* s.read(`${s.claude}/settings.json`)).toContain(`127.0.0.1:${s.port}`)
        expect(yield* s.read(`${s.codex}/config.toml`)).toBe(elsewhere)
        // Again, with the `init` alias and nothing asked: what is done already is seen, and Codex is wired this time.
        text = ok(yield* s.run(["init", "--import", "none", "--agents", "claude,codex"])).stdout
        expect(text).toContain("Claude Code already uses slopmax.")
        expect(text).toContain("The proxy is running on")
        expect(yield* s.read(`${s.codex}/config.toml`)).toContain(`127.0.0.1:${s.port}`)
        expect((yield* s.accountFiles).length).toBe(1)
        expect(yield* s.stubCalls).toBe("")
        ok(yield* s.run(["stop"]))
      }),
    120_000,
  )

  test(
    "leaves alone, unattended, an agent no account can serve",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("unserved")
        yield* s.write(`${s.home}/.cli-proxy-api/codex-a.json`, cliProxyApiLogin("a@x.dev", "ws-a"))
        const text = ok(yield* s.run(["setup", "--yes", "--import", "cliproxyapi", "--no-service"])).stdout
        expect(text).toContain("Claude Code left as it is: no Claude account to serve it.")
        expect(text).toContain("1 account behind")
        expect(yield* s.exists(`${s.claude}/settings.json`)).toBe(false)
        expect(yield* s.read(`${s.codex}/config.toml`)).toContain(`127.0.0.1:${s.port}`)
        ok(yield* s.run(["stop"]))
      }),
    120_000,
  )

  test(
    "finishes an unattended setup that missed part of what was asked, then fails naming it",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("partial")
        yield* s.write(`${s.home}/.cli-proxy-api/codex-a.json`, cliProxyApiLogin("a@x.dev", "ws-a"))
        const ran = yield* s.run([
          "setup",
          "--yes",
          "--import",
          "cliproxyapi,codex",
          "--agents",
          "none",
          "--no-service",
        ])
        expect(ran.code).toBe(1)
        expect(ran.stdout).toContain("Done.")
        expect(ran.stderr).toContain("--import codex found no login to take")
        expect((yield* s.accountFiles).length).toBe(1)
        ok(yield* s.run(["stop"]))
      }),
    120_000,
  )

  test(
    "runs an agent through the proxy with its arguments as given, and exits with its status",
    (sandbox) =>
      Effect.gen(function* () {
        const s = yield* sandbox("run")
        yield* s.program("codex", '#!/bin/sh\necho "args: $*"\nread line\necho "read: $line"\nexit 7\n')
        const ran = yield* s.run(["run", "codex", "exec", "--help", "-1"], { input: "typed\n" })
        expect(ran.code).toBe(7)
        expect(ran.stdout).toContain("read: typed")
        expect(ran.stdout).toContain(`model_providers.slopmax.base_url="http://127.0.0.1:${s.port}/codex"`)
        const args = ran.stdout.split("\n")[0] ?? ""
        expect(args.startsWith("args: exec -c ")).toBe(true)
        expect(args.endsWith(" --help -1")).toBe(true)
        ok(yield* s.run(["stop"]))
      }),
    120_000,
  )
})
