import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AccountId, Finding, levelOrder, Section, slopmaxVersion, worstLevel } from "@slopmax/domain"
import { it, MemoryFileSystem, TestHome } from "@slopmax/test"
import { ConfigProvider, DateTime, Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { Account, accountText, Credential, Identity, Link, Tokens } from "../../src/accounts.ts"
import { Accounts } from "../../src/accounts.ts"
import { agents } from "../../src/agents/index.ts"
import { Background } from "../../src/background.ts"
import { doctor, type Reach, splitListen, unserved } from "../../src/doctor.ts"
import { Home } from "../../src/home.ts"
import { Lock } from "../../src/lock.ts"
import type { ServiceManager, ServiceStatus } from "../../src/service.ts"
import { SettingsService } from "../../src/settings.ts"
import { Upstream } from "../../src/upstream.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

const root = "/home/me/.slopmax"

const health = (version: string) => Response.json({ status: "ok", service: "slopmax", version })

const refused = () => Promise.reject(new TypeError("Unable to connect"))

const reach: ReadonlyArray<Reach> = [
  { name: "Anthropic", url: "https://api.anthropic.test/api/hello" },
  { name: "ChatGPT", url: "https://chatgpt.test/backend-api/wham/usage" },
]

const noService: ServiceManager = {
  kind: Option.none(),
  status: Effect.succeed({ installed: false, running: false, file: "", lingering: Option.none() }),
  install: Effect.die("unused"),
  uninstall: Effect.die("unused"),
  start: Effect.die("unused"),
}

const serviceWith = (status: Partial<ServiceStatus>): ServiceManager => ({
  ...noService,
  kind: Option.some("systemd"),
  status: Effect.succeed({ installed: false, running: false, file: "/unit", lingering: Option.none(), ...status }),
})

interface Machine {
  readonly files?: MemoryFileSystem.Options["files"]
  readonly env?: Record<string, string>
  readonly listen?: string
  readonly keys?: number
  readonly proxy?: (request: Request) => Response | Promise<Response>
  readonly network?: (request: Request) => Response | Promise<Response>
  readonly service?: ServiceManager
}

/** Requests from Background answered by `fetch` instead of the network. */
const pretendFetch = (fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  Layer.succeed(FetchHttpClient.Fetch)(Object.assign(fetch, { preconnect: () => undefined }))

/** A machine in memory, with a pretend proxy and pretend providers, and the doctor's sections for it. */
const sectionsOn = (machine: Machine, options: { readonly cliProxyApiPort?: number } = {}) => {
  const settings = SettingsService.layerValue({
    apiKey: "sm-test",
    listen: machine.listen ?? "127.0.0.1:7567",
    keys: Array.from({ length: machine.keys ?? 0 }, (_, at) => ({ name: `k${at}`, key: `sm-k${at}`, models: [] })),
  })
  const base = Layer.mergeAll(
    Home.layerAt(root),
    Lock.layerMemory,
    settings,
    Upstream.layerHandler(
      machine.network ?? (() => new Response("", { status: 404, headers: { date: new Date().toUTCString() } })),
    ),
    recordingSpawner().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ PATH: "/usr/local/bin", ...machine.env })),
  ).pipe(Layer.provideMerge(MemoryFileSystem.layerWith({ files: machine.files ?? {} })))
  const answer = machine.proxy ?? refused
  const fetch = async (input: string | URL | Request, init?: RequestInit) =>
    answer(input instanceof Request ? input : new Request(String(input), init))
  const background = Background.layerWith({ exe: ["/opt/slopmax"], manager: machine.service ?? noService }).pipe(
    Layer.provide(pretendFetch(fetch)),
  )
  const layer = Layer.mergeAll(Accounts.layer, background).pipe(Layer.provideMerge(base))
  return doctor({ reach, cliProxyApiPort: options.cliProxyApiPort ?? 1, platform: "linux" }).pipe(Effect.provide(layer))
}

const section = (sections: ReadonlyArray<Section>, title: string) =>
  sections.find((found) => found.title === title)?.findings.map((finding) => ({ ...finding })) ?? []

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

const oauth = (access: string, more: { expiresAt?: DateTime.Utc; follows?: Link } = {}) =>
  Credential.cases.OAuth.make({
    tokens: new Tokens({ access: Redacted.make(access), ...(more.expiresAt ? { expiresAt: more.expiresAt } : {}) }),
    ...(more.follows ? { follows: more.follows } : {}),
  })

const account = (
  id: string,
  provider: Account["provider"],
  extra: Partial<ConstructorParameters<typeof Account>[0]> = {},
) =>
  new Account({
    id: AccountId.make(id),
    provider,
    credential:
      provider === "claude" || provider === "codex"
        ? oauth(`tok-${id}`)
        : Credential.cases.Key.make({ key: Redacted.make(`sk-${id}`) }),
    identity: new Identity({ email: `${id}@example.com` }),
    addedAt: at(1_000),
    ...extra,
  })

const accountFiles = (...accounts: ReadonlyArray<Account>) =>
  Object.fromEntries(
    accounts.map((one) => [`${root}/accounts/${one.id}.json`, { data: accountText(one), mode: 0o600 }]),
  )

/** A port nothing listens on: bound, read, and released. */
const freePort = Effect.sync(() => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } })
  const port = server.port
  server.stop(true)
  return port
})

const listener = Effect.acquireRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } })),
  (server) => Effect.sync(() => server.stop(true)),
)

describe("the proxy", () => {
  it.live("a running proxy of this version is fine", () =>
    Effect.gen(function* () {
      const sections = yield* sectionsOn({ proxy: () => health(slopmaxVersion) })
      expect(section(sections, "Proxy")).toEqual([{ level: "ok", text: "running on http://127.0.0.1:7567" }])
    }),
  )

  it.live("an older proxy should be restarted", () =>
    Effect.gen(function* () {
      const sections = yield* sectionsOn({ proxy: () => health("0.0.1") })
      expect(section(sections, "Proxy")).toEqual([
        {
          level: "warn",
          text: `running version 0.0.1, but this binary is ${slopmaxVersion}`,
          fix: "slopmax stop && slopmax start",
        },
      ])
    }),
  )

  it.live("a stopped proxy says how to start it", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const sections = yield* sectionsOn({ listen: `127.0.0.1:${port}` })
      expect(section(sections, "Proxy")).toEqual([
        { level: "warn", text: "not running", fix: "slopmax start (or `slopmax service install` to start at login)" },
      ])
    }),
  )

  it.live("another program on the port is called out, with how to move", () =>
    Effect.gen(function* () {
      const server = yield* listener
      const sections = yield* sectionsOn({ listen: `127.0.0.1:${server.port}` })
      // The in-memory machine has no /proc, so the holder has no name here.
      expect(section(sections, "Proxy")).toEqual([
        {
          level: "fail",
          text: `port ${server.port} is taken by another program`,
          fix: "set `listen` in config.json to a free port",
        },
      ])
    }),
  )

  it.live.skipIf(process.platform !== "linux")("another program on the port is named from the system", () =>
    Effect.gen(function* () {
      const server = yield* listener
      const home = yield* TestHome.make("doctor-port")
      const layer = Layer.mergeAll(
        Accounts.layer,
        Background.layerWith({ exe: ["/opt/slopmax"], manager: noService }).pipe(
          Layer.provide(pretendFetch(async () => refused())),
        ),
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Home.layerAt(home.slopmax),
            Lock.layerMemory,
            SettingsService.layerValue({ apiKey: "sm-test", listen: `127.0.0.1:${server.port}` }),
            Upstream.layerHandler(() => new Response("")),
          ),
        ),
        Layer.provideMerge(BunServices.layer),
      )
      const sections = yield* doctor({ reach: [], cliProxyApiPort: 1 }).pipe(Effect.provide(layer))
      expect(section(sections, "Proxy")[0]?.text).toContain(`(pid ${process.pid})`)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("listening beyond this machine is pointed out, counting the client keys", () =>
    Effect.gen(function* () {
      const port = yield* freePort
      const one = section(
        yield* sectionsOn({ listen: `0.0.0.0:${port}`, keys: 1, proxy: () => health(slopmaxVersion) }),
        "Proxy",
      )
      expect(one.at(-1)).toEqual({
        level: "info",
        text: `listens beyond this machine on 0.0.0.0:${port}: anyone who can reach it with the key (1 client key besides apiKey) can use your accounts`,
        fix: "give other machines their own keys with `slopmax key add <name>`",
      })
      const none = section(
        yield* sectionsOn({ listen: `0.0.0.0:${port}`, proxy: () => health(slopmaxVersion) }),
        "Proxy",
      )
      expect(none.at(-1)?.text).toContain("(0 client keys besides apiKey)")
      const local = section(
        yield* sectionsOn({ listen: `[::1]:${port}`, proxy: () => health(slopmaxVersion) }),
        "Proxy",
      )
      expect(local).toHaveLength(1)
    }),
  )

  it.live("the login service is reported when the system has one", () =>
    Effect.gen(function* () {
      const running = { proxy: () => health(slopmaxVersion) }
      const lines = (service: ServiceManager) =>
        Effect.map(sectionsOn({ ...running, service }), (sections) => section(sections, "Proxy").slice(1))
      expect(yield* lines(noService)).toEqual([])
      expect(yield* lines(serviceWith({}))).toEqual([
        { level: "info", text: "not installed as a service", fix: "slopmax service install" },
      ])
      expect(yield* lines(serviceWith({ installed: true, running: true, lingering: Option.some(true) }))).toEqual([
        { level: "ok", text: "runs as a login service" },
      ])
      expect(yield* lines(serviceWith({ installed: true, lingering: Option.some(false) }))).toEqual([
        { level: "warn", text: "the service is installed but not running", fix: "slopmax start" },
        { level: "info", text: "the service stops when you log out", fix: "loginctl enable-linger $USER" },
      ])
    }),
  )

  it("reads a listen address's host and port, IPv6 included", () => {
    expect(splitListen("127.0.0.1:7567")).toEqual({ host: "127.0.0.1", port: 7567 })
    expect(splitListen("[::1]:80")).toEqual({ host: "::1", port: 80 })
  })
})

describe("accounts", () => {
  it.live("no accounts is a failure", () =>
    Effect.gen(function* () {
      expect(section(yield* sectionsOn({}), "Accounts")).toEqual([
        {
          level: "fail",
          text: "no accounts connected",
          fix: "slopmax login claude, slopmax login codex, or slopmax import",
        },
      ])
    }),
  )

  it.live("accounts are counted by provider and each problem has a fix", () =>
    Effect.gen(function* () {
      const past = at(1_000)
      const files = {
        ...accountFiles(
          account("claude-00000001", "claude"),
          account("claude-00000002", "claude", { disabled: true }),
          account("codex-00000001", "codex", { authError: "refresh token revoked", disabled: true }),
          account("codex-00000002", "codex", {
            credential: oauth("t", {
              follows: new Link({ tool: "cliproxyapi", path: "/home/me/.cli-proxy-api/gone.json" }),
            }),
          }),
          account("codex-00000003", "codex", {
            credential: oauth("t", {
              expiresAt: past,
              follows: new Link({ tool: "cliproxyapi", path: "/home/me/.cli-proxy-api/codex.json" }),
            }),
          }),
          account("openai-00000001", "openai"),
        ),
        "/home/me/.cli-proxy-api/codex.json": "{}",
      }
      expect(section(yield* sectionsOn({ files }), "Accounts")).toEqual([
        { level: "ok", text: "2 Claude accounts, 3 ChatGPT accounts, 1 OpenAI API account" },
        { level: "info", text: "claude-00000002@example.com is disabled" },
        {
          level: "fail",
          text: "codex-00000001@example.com needs a new login (refresh token revoked)",
          fix: "slopmax login codex",
        },
        { level: "info", text: "codex-00000001@example.com is disabled" },
        {
          level: "warn",
          text: "codex-00000002@example.com follows CLIProxyAPI, but /home/me/.cli-proxy-api/gone.json is gone",
          fix: "slopmax own codex-00000002",
        },
        {
          level: "warn",
          text: "codex-00000003@example.com's token expired and CLIProxyAPI has not refreshed it",
          fix: "start CLIProxyAPI again, or slopmax own codex-00000003",
        },
      ])
    }),
  )
})

const claudeSettings = (env: Record<string, string>) => ({ "/home/me/.claude/settings.json": JSON.stringify({ env }) })

describe("agents", () => {
  const served = accountFiles(account("claude-00000001", "claude"), account("codex-00000001", "codex"))

  it.live("Claude Code's wiring is checked against this proxy, and a conflicting API key is flagged", () =>
    Effect.gen(function* () {
      const files = {
        ...served,
        ...claudeSettings({ ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude", ANTHROPIC_AUTH_TOKEN: "sm-test" }),
        "/usr/local/bin/claude": "",
      }
      expect(section(yield* sectionsOn({ files }), "Claude Code")).toEqual([
        { level: "ok", text: "wired through settings.json, for the CLI and the apps that run it" },
      ])
      const { "/usr/local/bin/claude": _program, ...noProgram } = files
      const withKey = section(
        yield* sectionsOn({ files: noProgram, env: { ANTHROPIC_API_KEY: "sk-ant" } }),
        "Claude Code",
      )
      expect(withKey).toEqual([
        { level: "info", text: "`claude` is not on PATH" },
        { level: "ok", text: "wired through settings.json, for the CLI and the apps that run it" },
        {
          level: "warn",
          text: "ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key",
          fix: "unset ANTHROPIC_API_KEY",
        },
      ])
    }),
  )

  it.live("Codex's wiring is checked against this proxy", () =>
    Effect.gen(function* () {
      const files = {
        ...served,
        "/usr/local/bin/codex": "",
        "/home/me/.codex/config.toml":
          'model_provider = "slopmax"\n[model_providers.slopmax]\nbase_url = "http://127.0.0.1:7567/codex"\nexperimental_bearer_token = "sm-test"\n',
      }
      expect(section(yield* sectionsOn({ files }), "Codex")).toEqual([
        { level: "ok", text: "wired through config.toml, for the CLI and the desktop app" },
      ])
    }),
  )

  it.live("an agent nothing can serve is told to sign in first, and fails when it points at slopmax", () =>
    Effect.gen(function* () {
      const files = {
        ...accountFiles(account("openai-00000001", "openai")),
        ...claudeSettings({ ANTHROPIC_BASE_URL: "http://127.0.0.1:7567/claude", ANTHROPIC_AUTH_TOKEN: "sm-old" }),
        "/usr/local/bin/claude": "",
        "/usr/local/bin/codex": "",
      }
      const sections = yield* sectionsOn({ files })
      expect(section(sections, "Claude Code")).toEqual([
        {
          level: "warn",
          text: "settings.json points at slopmax with a different key",
          fix: "slopmax login claude, then slopmax setup claude",
        },
        {
          level: "fail",
          text: "points at slopmax, but no Claude account is connected to serve it",
          fix: "slopmax login claude, or `slopmax setup claude --undo`",
        },
      ])
      // An OpenAI key backs Codex, so Codex keeps its plain fix.
      expect(section(sections, "Codex")[0]?.fix).toBe("slopmax setup codex")
    }),
  )

  it("an agent some account serves keeps its section as it is", () => {
    const wiring = new Section({
      title: "Claude Code",
      findings: [new Finding({ level: "info", text: "not wired", fix: "slopmax setup claude" })],
    })
    const report = { agent: agents["claude-code"], wired: true, section: wiring }
    expect(unserved(report, [{ provider: "anthropic" }])).toBe(wiring)
    expect(unserved(report, [{ provider: "codex" }]).findings.map((found) => found.fix)).toEqual([
      "slopmax login claude, then slopmax setup claude",
      "slopmax login claude, or `slopmax setup claude --undo`",
    ])
  })
})

describe("CLIProxyAPI", () => {
  const linked = accountFiles(
    account("codex-00000001", "codex", {
      credential: oauth("t", { follows: new Link({ tool: "cliproxyapi", path: "/home/me/.cli-proxy-api/c.json" }) }),
    }),
  )
  const files = { ...linked, "/home/me/.cli-proxy-api/c.json": "{}" }

  it.live("matters only with linked accounts, and is probed on its port without being bound", () =>
    Effect.gen(function* () {
      expect(
        section(yield* sectionsOn({ files: accountFiles(account("codex-00000001", "codex")) }), "CLIProxyAPI"),
      ).toEqual([])
      const server = yield* listener
      expect(section(yield* sectionsOn({ files }, { cliProxyApiPort: server.port }), "CLIProxyAPI")).toEqual([
        {
          level: "info",
          text: "still running and refreshing 1 account slopmax follows",
          fix: "once you stop CLIProxyAPI: slopmax own all",
        },
      ])
      const closed = yield* freePort
      expect(section(yield* sectionsOn({ files }, { cliProxyApiPort: closed }), "CLIProxyAPI")).toEqual([
        {
          level: "warn",
          text: "not running, so nothing refreshes the 1 account slopmax follows",
          fix: "slopmax own all",
        },
      ])
    }),
  )
})

describe("the network", () => {
  it.live("reachable services with a sound clock are fine", () =>
    Effect.gen(function* () {
      expect(section(yield* sectionsOn({}), "Network")).toEqual([
        { level: "ok", text: "Anthropic is reachable" },
        { level: "ok", text: "ChatGPT is reachable" },
      ])
    }),
  )

  it.live("a skewed clock is reported once", () =>
    Effect.gen(function* () {
      const skewed = new Date(Date.now() - Duration.toMillis(Duration.minutes(7))).toUTCString()
      const findings = section(
        yield* sectionsOn({ network: () => new Response("{}", { status: 401, headers: { date: skewed } }) }),
        "Network",
      )
      const warnings = findings.filter((found) => found.level === "warn")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.text).toMatch(/^the system clock is off by (6m5\ds|7m0\ds)$/)
      expect(warnings[0]?.fix).toBe("enable time sync (e.g. `timedatectl set-ntp true`)")
    }),
  )

  it.live("unreachable services fail with a fix", () =>
    Effect.gen(function* () {
      const findings = section(
        yield* sectionsOn({
          network: (request) =>
            request.url.includes("anthropic")
              ? Promise.reject(new TypeError("getaddrinfo ENOTFOUND"))
              : new Response(""),
        }),
        "Network",
      )
      expect(findings[0]).toMatchObject({ level: "fail", fix: "check the network, or set HTTPS_PROXY" })
      expect(findings[0]?.text).toStartWith("cannot reach Anthropic: ")
      expect(findings[1]).toEqual({ level: "ok", text: "ChatGPT is reachable" })
    }),
  )
})

describe("files", () => {
  it.live("account files others can read are flagged, with the chmod that fixes them", () =>
    Effect.gen(function* () {
      const one = account("claude-00000001", "claude")
      const two = account("codex-00000001", "codex")
      const files = {
        [`${root}/accounts/${one.id}.json`]: { data: accountText(one), mode: 0o644 },
        [`${root}/accounts/${two.id}.json`]: { data: accountText(two), mode: 0o600 },
      }
      expect(section(yield* sectionsOn({ files }), "Files")).toEqual([
        { level: "warn", text: `${root}/accounts is readable by other users`, fix: `chmod 700 ${root}/accounts` },
        { level: "warn", text: "1 account file is readable by other users", fix: `chmod 600 ${root}/accounts/*` },
      ])
    }),
  )
})

describe("levels", () => {
  it("order by severity", () => {
    expect(levelOrder("ok", "info")).toBe(-1)
    expect(levelOrder("fail", "warn")).toBe(1)
    expect(worstLevel(["info", "fail", "warn"])).toBe("fail")
    expect(worstLevel([])).toBe("ok")
  })
})
