// The `slopmax` binary end to end, in a sandbox: what `tests/cli.rs` stands on.
//
// Every command runs with its homes (`SLOPMAX_HOME`, `HOME`,
// `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`) in a fresh temp
// dir, the proxy on a free port, and stdin closed. Outbound HTTPS goes to a
// dead local proxy, so nothing reaches the internet, and the programs that
// would touch the machine (`launchctl`, `systemctl`, `loginctl`,
// `security`, `open`, `xdg-open`) are stubs that record their arguments
// and fail. `SLOPMAX_NO_SERVICE` keeps slopmax from looking for a login
// service at all: launchd's and systemd's domains are the user's, whatever
// the environment moves, so no test may reach them.
import { afterEach } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

import { Effect } from "effect"

import { Account, Store, type Tokens, time } from "@slopmax/core"

/** A dead proxy: connections to it are refused at once. */
const NOWHERE = "http://127.0.0.1:9"

const STUBS = ["launchctl", "systemctl", "loginctl", "security", "open", "xdg-open"]

const here = dirname(new URL(import.meta.url).pathname)
const built = join(here, "../../dist/slopmax")

// The newest change to anything the binary is built from: this package's
// sources and those of the workspace packages it bundles.
const newestSource = (): number => {
  let newest = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  const root = join(here, "../../../..")
  walk(join(here, "../../src"))
  for (const name of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", name, "src")
    if (existsSync(src)) walk(src)
  }
  return newest
}

/**
 * Why a built `dist/slopmax` is not used: it is missing, or older than the
 * sources, when a green run would only say the last build worked.
 */
export const STALE: string | undefined = !existsSync(built)
  ? "no dist/slopmax"
  : statSync(built).mtimeMs < newestSource()
    ? "dist/slopmax is older than the sources"
    : undefined

/**
 * What runs as `slopmax`: `SLOPMAX_BIN`, else the compiled `dist/slopmax`
 * when it is up to date, else the sources under Bun (which cannot start a
 * background proxy, since the program is then Bun, not slopmax).
 */
export const BINARY: ReadonlyArray<string> =
  process.env["SLOPMAX_BIN"] !== undefined && process.env["SLOPMAX_BIN"] !== ""
    ? [process.env["SLOPMAX_BIN"]]
    : STALE === undefined
      ? [built]
      : [process.execPath, join(here, "../../src/main.ts")]

export const FROM_SOURCE = BINARY.length > 1

export interface Out {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const show = (out: Out): string => JSON.stringify(out, null, 2)

/** Asserts success; returns the output. */
export const ok = (out: Out): Out => {
  if (out.code !== 0) throw new Error(`expected success: ${show(out)}`)
  return out
}

/** Asserts the exit code and that stderr says `says`. */
export const fails = (out: Out, code: number, says: string): Out => {
  if (out.code !== code) throw new Error(`expected exit ${code}: ${show(out)}`)
  if (!out.stderr.includes(says)) throw new Error(`stderr should say ${JSON.stringify(says)}: ${show(out)}`)
  return out
}

/** A free port on 127.0.0.1. */
export const freePort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

const open: Array<Sandbox> = []

// A proxy left by a failed test would outlive it.
afterEach(async () => {
  for (const s of open.splice(0)) await s.close()
})

export class Sandbox {
  readonly root: string
  readonly home: string
  readonly slopmax: string
  readonly claude: string
  readonly codex: string
  readonly stubs: string
  readonly port: number

  constructor(name: string) {
    this.root = join(tmpdir(), `slopmax-cli-${name}-${process.pid}-${process.hrtime.bigint()}`)
    this.home = join(this.root, "home")
    this.slopmax = join(this.root, "slopmax")
    this.claude = join(this.root, "claude")
    this.codex = join(this.root, "codex")
    this.stubs = join(this.root, "bin")
    this.port = freePort()
    for (const dir of [this.home, this.claude, this.codex, this.stubs, join(this.root, "xdg")]) {
      mkdirSync(dir, { recursive: true })
    }
    for (const stub of STUBS) {
      const path = join(this.stubs, stub)
      writeFileSync(path, '#!/bin/sh\necho "$(basename "$0") $*" >> "$STUB_LOG"\nexit 1\n')
      chmodSync(path, 0o755)
    }
    open.push(this)
  }

  env(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const env: Record<string, string> = {
      PATH: `${this.stubs}:/usr/bin:/bin`,
      HOME: this.home,
      SLOPMAX_HOME: this.slopmax,
      CLAUDE_CONFIG_DIR: this.claude,
      CODEX_HOME: this.codex,
      XDG_CONFIG_HOME: join(this.root, "xdg"),
      SLOPMAX_LISTEN: `127.0.0.1:${this.port}`,
      HTTPS_PROXY: NOWHERE,
      HTTP_PROXY: NOWHERE,
      ALL_PROXY: NOWHERE,
      STUB_LOG: join(this.root, "stubs.log"),
      SLOPMAX_NO_SERVICE: "1",
    }
    const tmp = process.env["TMPDIR"]
    if (tmp !== undefined) env["TMPDIR"] = tmp
    return { ...env, ...extra }
  }

  /** Starts `slopmax args…` with stdin closed (or fed `input`). */
  spawn(args: ReadonlyArray<string>, options: { readonly input?: string; readonly env?: Record<string, string> } = {}) {
    return Bun.spawn([...BINARY, ...args], {
      env: this.env(options.env),
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  async run(
    args: ReadonlyArray<string>,
    options: { readonly input?: string; readonly env?: Record<string, string> } = {},
  ): Promise<Out> {
    const child = this.spawn(args, options)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  }

  /** Runs with `input` on stdin. */
  runWith(args: ReadonlyArray<string>, input: string): Promise<Out> {
    return this.run(args, { input })
  }

  /**
   * Runs `slopmax args…` at a terminal (a pty): for each step, waits until
   * the output shows `waitFor`, then types `typed`. Returns everything the
   * terminal showed, `\r\n` as `\n`.
   */
  async runAtTerminal(
    args: ReadonlyArray<string>,
    steps: ReadonlyArray<readonly [waitFor: string, typed: string]>,
    env: Readonly<Record<string, string>> = {},
  ): Promise<Out> {
    let shown = ""
    const decoder = new TextDecoder()
    const child = Bun.spawn([...BINARY, ...args], {
      env: { TERM: "xterm-256color", ...this.env(env) },
      terminal: {
        cols: 200,
        rows: 50,
        data: (_, data) => {
          shown += decoder.decode(data, { stream: true })
        },
      },
    })
    const terminal = child.terminal
    if (terminal === undefined) throw new Error("no terminal")
    try {
      for (const [waitFor, typed] of steps) {
        const start = Date.now()
        while (!shown.includes(waitFor)) {
          if (Date.now() - start > 10_000) throw new Error(`never showed ${JSON.stringify(waitFor)}: ${shown}`)
          await Bun.sleep(20)
        }
        terminal.write(typed)
      }
      const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => -1)])
      if (code === -1) child.kill()
      // What is still on its way from the pty.
      await Bun.sleep(50)
      return { code, stdout: shown.replaceAll("\r\n", "\n"), stderr: "" }
    } finally {
      terminal.close()
    }
  }

  store(): Store {
    return Store.at(join(this.slopmax, "accounts"))
  }

  add(account: Account): Promise<void> {
    return Effect.runPromise(this.store().save(account))
  }

  account(query: string): Promise<Account> {
    return Effect.runPromise(this.store().find(query))
  }

  list(): Promise<Array<Account>> {
    return Effect.runPromise(this.store().list())
  }

  stubCalls(): string {
    try {
      return readFileSync(join(this.root, "stubs.log"), "utf8")
    } catch {
      return ""
    }
  }

  config(): string {
    return join(this.slopmax, "config.toml")
  }

  async close(): Promise<void> {
    await this.run(["stop"]).catch(() => undefined)
    rmSync(this.root, { recursive: true, force: true })
  }
}

export const inHours = (hours: number): time.Timestamp => Date.now() + hours * 3_600_000

const subscription = (provider: "claude" | "codex", email: string, id: string, plan: string): Account => {
  const tokens: Tokens = {
    accessToken: `tok-${email}`,
    refreshToken: `ref-${email}`,
    expiresAt: inHours(8),
  }
  return Account.assignId({ ...Account.make(provider, tokens, Date.now()), email, accountId: id, plan })
}

export const claude = (email: string): Account => subscription("claude", email, `uuid-${email}`, "max 20x")

export const codex = (email: string): Account => subscription("codex", email, `ws-${email}`, "pro")

export const key = (provider: Account["provider"], secret: string): Account =>
  Account.make(provider, { accessToken: secret }, Date.now())

/** Waits for `check` to hold, for up to 10 seconds. */
export const eventually = async (what: string, check: () => boolean | Promise<boolean>): Promise<void> => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start >= 10_000) throw new Error(`timed out: ${what}`)
    await Bun.sleep(50)
  }
}

export const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
