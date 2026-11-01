// The slopmax binary end to end, in a sandbox.
//
// Every run gets a cleared environment: its homes (`HOME`, `SLOPMAX_HOME`,
// `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`) in a fresh temp
// directory, the proxy on a free port, stdin closed unless a test types
// into it, and every way out to providers sent to a dead local proxy, so
// nothing reaches the internet. The programs that would touch the machine
// (`launchctl`, `systemctl`, `loginctl`, `security`, `open`, `xdg-open`)
// are stubs on `PATH` that record their arguments and fail, and
// `SLOPMAX_NO_SERVICE` keeps slopmax from looking for a login service at
// all. The doctor looks for CLIProxyAPI on a dead port, never its own. A
// sandbox runs `slopmax stop` when it closes, so no test leaves a proxy behind.
//
// What runs as slopmax: `SLOPMAX_BIN` when set (CI points it at the
// ahead-of-time binary), else a binary compiled from the sources once per
// suite (with bytecode, so each run starts fast), removed after the suite.
import { afterAll, beforeAll, describe, test } from "bun:test"
import { Account, accountText, Credential, Identity, Platform, Tokens, withAssignedId } from "@slopmax/core"
import { AccountId, type ProviderId } from "@slopmax/domain"
import {
  Cause,
  Config,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { freePort } from "../build.ts"

/** What `status --watch` writes before each redraw. */
const clearScreen = "\x1b[2J"

/** A dead proxy: connections to it are refused at once. */
export const nowhere = "http://127.0.0.1:9"

const stubbed = ["launchctl", "systemctl", "loginctl", "security", "open", "xdg-open"]

const cliRoot = `${import.meta.dir}/..`

/** How slopmax is started: the program and the arguments before the command's own. */
export class Program extends Context.Service<Program, { readonly command: ReadonlyArray<string> }>()(
  "slopmax/test/Program",
) {
  /** `SLOPMAX_BIN`, else a binary built from the sources into a directory removed with the layer. */
  static readonly layer = Layer.effect(
    Program,
    Effect.gen(function* () {
      const given = yield* Config.option(Config.String("SLOPMAX_BIN"))
      if (Option.isSome(given) && given.value !== "") return { command: [given.value] }
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-cli-test-" })
      const outfile = `${dir}/slopmax`
      const code = yield* Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            ChildProcess.make(
              process.execPath,
              ["build", "--compile", "--minify", "--bytecode", "--format=esm", `--outfile=${outfile}`, "src/main.ts"],
              { cwd: cliRoot, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
            ),
          ),
          (handle) => handle.exitCode,
        ),
      )
      if (Number(code) !== 0) return yield* Effect.die(new Error("the test binary did not build"))
      return { command: [outfile] }
    }),
  )
}

/** What one run printed and how it ended. */
export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  /** Typed into stdin, which then ends; stdin is closed from the start without it. */
  readonly input?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** One sandbox: a throwaway machine for the CLI. */
export const makeSandbox = Effect.fn("CliSandbox.make")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const { command } = yield* Program
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: `slopmax-cli-${name}-` }))
  const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments)
  const home = at("home")
  const slopmax = at("slopmax")
  const claude = at("claude")
  const codex = at("codex")
  const stubs = at("bin")
  const port = yield* freePort
  for (const dir of [home, claude, codex, stubs, at("xdg")]) yield* fs.makeDirectory(dir, { recursive: true })
  for (const stub of stubbed) {
    yield* fs.writeFileString(path.join(stubs, stub), '#!/bin/sh\necho "$(basename "$0") $*" >> "$STUB_LOG"\nexit 1\n')
    yield* fs.chmod(path.join(stubs, stub), 0o755)
  }
  const tmp = yield* Config.option(Config.String("TMPDIR"))
  const env = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
    PATH: `${stubs}:/usr/bin:/bin`,
    HOME: home,
    SLOPMAX_HOME: slopmax,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    XDG_CONFIG_HOME: at("xdg"),
    SLOPMAX_LISTEN: `127.0.0.1:${port}`,
    SLOPMAX_NO_SERVICE: "1",
    SLOPMAX_CLIPROXYAPI_PORT: "9",
    HTTPS_PROXY: nowhere,
    HTTP_PROXY: nowhere,
    ALL_PROXY: nowhere,
    STUB_LOG: at("stubs.log"),
    ...(Option.isSome(tmp) ? { TMPDIR: tmp.value } : {}),
    ...extra,
  })
  const [binary = "slopmax", ...leading] = command
  const make = (args: ReadonlyArray<string>, options: RunOptions = {}) =>
    ChildProcess.make(binary, [...leading, ...args], {
      env: env(options.env),
      extendEnv: false,
      stdin: options.input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(options.input)),
      stdout: "pipe",
      stderr: "pipe",
    })

  /** Runs `slopmax args…` to its end. */
  const run = (args: ReadonlyArray<string>, options: RunOptions = {}): Effect.Effect<Ran> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(make(args, options))
        const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
          concurrency: "unbounded",
        })
        return { code: Number(code), stdout, stderr }
      }),
    ).pipe(Effect.orDie)

  /** Starts `slopmax args…` and leaves it running until the scope closes. */
  const spawn = (args: ReadonlyArray<string>) =>
    spawner.spawn(
      ChildProcess.make(binary, [...leading, ...args], {
        env: env(),
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )

  /**
   * Starts `slopmax args…` and keeps what it prints on stdout, for a command
   * that runs until stopped (`status --watch`, `logs -f`); it is stopped
   * with the scope.
   */
  const watching = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let printed = ""
      const handle = yield* spawner.spawn(make(args))
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            printed += chunk
          }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      )
      return {
        handle,
        /** Everything printed so far. */
        printed: Effect.sync(() => printed),
        /** What was printed since the screen was last cleared. */
        screen: Effect.sync(() => {
          const cleared = printed.lastIndexOf(clearScreen)
          return cleared < 0 ? printed : printed.slice(cleared + clearScreen.length)
        }),
      }
    }).pipe(Effect.orDie)

  // A proxy a failed test started must not outlive it.
  yield* Effect.addFinalizer(() => Effect.ignore(run(["stop"])))

  const write = (file: string, contents: string) =>
    Effect.andThen(fs.makeDirectory(path.dirname(file), { recursive: true }), fs.writeFileString(file, contents)).pipe(
      Effect.orDie,
    )
  const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  /** A program on the sandbox's `PATH`, such as a stand-in for an agent. */
  const program = (file: string, script: string) =>
    Effect.andThen(write(path.join(stubs, file), script), fs.chmod(path.join(stubs, file), 0o755)).pipe(Effect.orDie)

  /**
   * Runs `slopmax args…` at a terminal (a pty): for each step, waits until
   * the screen shows `waitFor`, then types `typed`. Gives what the terminal
   * showed, with `\r\n` as `\n`.
   */
  const atTerminal = (args: ReadonlyArray<string>, steps: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      let shown = ""
      const decoder = new TextDecoder()
      // Killed and its terminal closed with the test's scope, however the test ends.
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([binary, ...leading, ...args], {
            env: { TERM: "xterm-256color", ...env() },
            terminal: {
              cols: 160,
              rows: 50,
              data: (_terminal, data) => {
                shown += decoder.decode(data, { stream: true })
              },
            },
          }),
        ),
        (started) =>
          Effect.sync(() => {
            started.kill()
            started.terminal?.close()
          }),
      )
      const showing = (wanted: string) =>
        Effect.suspend(() => (shown.includes(wanted) ? Effect.void : Effect.fail("not yet"))).pipe(
          Effect.retry(Schedule.spaced("20 millis")),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.die(new Error(`the terminal never showed ${JSON.stringify(wanted)}: ${shown}`)),
          }),
        )
      for (const [waitFor, typed] of steps) {
        yield* showing(waitFor)
        // Each key on its own, as a person types them.
        for (const key of typed) {
          child.terminal?.write(key === "↓" ? "\x1b[B" : key)
          yield* Effect.sleep("60 millis")
        }
      }
      const code = yield* Effect.promise(() => child.exited).pipe(
        Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.succeed(-1) }),
      )
      // The last of what it drew may still be on its way.
      yield* Effect.sleep("50 millis")
      return { code, shown: shown.replaceAll("\r\n", "\n") }
    })

  return {
    root,
    atTerminal,
    home,
    slopmax,
    claude,
    codex,
    stubs,
    port,
    at,
    env,
    run,
    spawn,
    watching,
    write,
    read,
    program,
    exists: (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
    config: path.join(slopmax, "config.json"),
    log: path.join(slopmax, "slopmax.log"),
    /** What the stubbed system programs were asked to do. */
    stubCalls: read(at("stubs.log")),
    /** Puts an account in the store, as a sign-in would have. */
    add: (account: Account) => write(path.join(slopmax, "accounts", `${account.id}.json`), accountText(account)),
    /** Every account file's text, by name. */
    accountFiles: Effect.gen(function* () {
      const dir = path.join(slopmax, "accounts")
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
      const files: Array<string> = []
      for (const file of names.toSorted()) if (file.endsWith(".json")) files.push(yield* read(path.join(dir, file)))
      return files
    }),
    /** Waits until `check` holds, for up to 15 seconds. */
    eventually: <E, R>(what: string, check: Effect.Effect<boolean, E, R>) =>
      check.pipe(
        Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(`not yet: ${what}`))),
        Effect.retry(Schedule.spaced("100 millis")),
        Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.die(new Error(`timed out: ${what}`)) }),
      ),
  }
})

export type CliSandbox = Effect.Success<ReturnType<typeof makeSandbox>>

// ---------------------------------------------------------------------------
// Accounts as the tests need them

const later = (hours: number) => DateTime.add(DateTime.nowUnsafe(), { hours })

const withId = (account: Account): Effect.Effect<Account> =>
  withAssignedId(account).pipe(Effect.provide(Digest.layerWebCrypto))

/** A subscription signed in here, with tokens good for hours. */
export const subscription = (provider: "claude" | "codex", email: string, plan: string): Effect.Effect<Account> =>
  withId(
    new Account({
      id: AccountId.make("pending"),
      provider,
      credential: Credential.cases.OAuth.make({
        tokens: new Tokens({
          access: Redacted.make(`tok-${email}`),
          refresh: Redacted.make(`ref-${email}`),
          expiresAt: later(8),
        }),
      }),
      identity: new Identity({ email, accountId: `id-${email}`, plan }),
      addedAt: DateTime.nowUnsafe(),
    }),
  )

/** An API key account. */
export const keyAccount = (provider: ProviderId, key: string): Effect.Effect<Account> =>
  withId(
    new Account({
      id: AccountId.make("pending"),
      provider,
      credential: Credential.cases.Key.make({ key: Redacted.make(key) }),
      addedAt: DateTime.nowUnsafe(),
    }),
  )

// ---------------------------------------------------------------------------
// The suite

type Body = (
  sandbox: (name: string) => Effect.Effect<CliSandbox, never, Scope.Scope>,
) => Effect.Effect<unknown, unknown, Scope.Scope>

/**
 * A describe block whose tests run the binary in sandboxes. The binary is
 * built once before them (that can take a while) and removed after.
 */
export const cliSuite = (
  title: string,
  body: (test: (name: string, run: Body, timeout?: number) => void) => void,
): void =>
  describe(title, () => {
    const scope = Scope.makeUnsafe()
    const services = Program.layer.pipe(Layer.provideMerge(Platform.layer))
    let built: Promise<Context.Context<Layer.Success<typeof services>>> | undefined
    beforeAll(
      () => {
        built = Effect.runPromise(Layer.buildWithScope(services, scope))
        return built
      },
      { timeout: 600_000 },
    )
    afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    body((name, run, timeout = 60_000) =>
      test(
        name,
        async () => {
          if (built === undefined) throw new Error("the test binary was not built")
          const context = await built
          const sandbox = (label: string) => makeSandbox(label).pipe(Effect.provideContext(context), Effect.orDie)
          const exit = await Effect.runPromiseExit(Effect.scoped(run(sandbox)).pipe(Effect.provideContext(context)))
          if (Exit.isFailure(exit)) {
            const [reason] = exit.cause.reasons
            if (reason?._tag === "Die" && reason.defect instanceof Error) throw reason.defect
            throw new Error(Cause.pretty(exit.cause))
          }
        },
        timeout,
      ),
    )
  })
