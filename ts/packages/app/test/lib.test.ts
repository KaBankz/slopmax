import { describe, expect } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Cause, ConfigProvider, Effect, Fiber, Layer } from "effect"

import { auth, Config, config as configs, error, Store, Tokens, Account } from "@slopmax/core"

import {
  adopt,
  App,
  countAccounts,
  Doctor,
  onPath,
  progress,
  Proxy,
  Setting,
  type Snapshot,
  Step,
  stopped as stoppedText,
} from "../src/lib.ts"
import { KEY, sandbox, scratch, until } from "./support/sandbox.ts"

/** A config.toml of its own in the system's temporary directory, with a comment to keep. */
const configFile = (text: string) =>
  Effect.map(scratch("config"), (dir) => {
    const path = join(dir, "config.toml")
    writeFileSync(path, text)
    return path
  })

const CONFIG = '# Mine.\napi_key = "sm-test"\nstrategy = "fill-first" # chosen by hand\n'

const snapshot = (): Snapshot => ({
  proxy: Proxy.Checking,
  address: "",
  report: undefined,
  agents: [],
  service: undefined,
  signIn: undefined,
  notice: undefined,
  history: undefined,
  today: undefined,
  redeeming: undefined,
  config: Config.default(),
  notifications: true,
  newKey: undefined,
  doctor: Doctor.NotRun,
})

describe("lib", () => {
  it.live("settings_are_written_into_config_toml", () =>
    Effect.gen(function* () {
      const path = yield* configFile(CONFIG)
      let config = yield* Setting.write(Setting.Strategy("round-robin"), path)
      expect(config.strategy).toBe("round-robin")
      const text = readFileSync(path, "utf8")
      // The comments stay, the one beside the value too.
      expect(text.startsWith("# Mine.\n")).toBe(true)
      expect(text).toContain('strategy = "round-robin" # chosen by hand')

      config = yield* Setting.write(Setting.SessionAffinity(false), path)
      expect(config.sessionAffinity).toBe(false)
      // What was set before stays set.
      expect(config.strategy).toBe("round-robin")
      config = yield* Setting.write(Setting.RedeemExpiringCredits(false), path)
      expect(config.redeemExpiringCredits).toBe(false)
      config = yield* Setting.write(Setting.RedeemWhenExhausted(true), path)
      expect(config.redeemWhenExhausted).toBe(true)

      const reread = yield* Config.loadFrom(path)
      expect(reread).toEqual(config)
      expect(!reread.sessionAffinity && !reread.redeemExpiringCredits).toBe(true)
    }),
  )

  it.live("a_config_that_will_not_load_is_left_alone", () =>
    Effect.gen(function* () {
      const broken = 'api_key = "sm-test"\nstrategy = 3\n'
      const path = yield* configFile(broken)
      const written = yield* Effect.result(Setting.write(Setting.SessionAffinity(false), path))
      expect(written._tag).toBe("Failure")
      expect(readFileSync(path, "utf8")).toBe(broken)
    }),
  )

  it.live("advanced_settings_are_checked_as_the_cli_checks_them", () =>
    Effect.gen(function* () {
      const path = yield* configFile(CONFIG)
      let config = yield* Setting.write(Setting.SessionTtlMins(120), path)
      expect(config.sessionTtlMins).toBe(120)
      config = yield* Setting.write(Setting.PollMins(0), path)
      expect(config.pollMins).toBe(0)
      config = yield* Setting.write(Setting.WarmWindows(true), path)
      expect(config.warmWindows).toBe(true)
      config = yield* Setting.write(Setting.PaidOverflow(true), path)
      expect(config.paidOverflow).toBe(true)
      // A session must keep its account for some time.
      const refused = yield* Effect.flip(Setting.write(Setting.SessionTtlMins(0), path))
      expect(error.chain(refused)).toContain("minutes")
      expect((yield* Config.loadFrom(path)).sessionTtlMins).toBe(120)
    }),
  )

  it("each_setting_has_its_key", () => {
    const keys = [
      Setting.Strategy("reset-first"),
      Setting.SessionAffinity(true),
      Setting.RedeemExpiringCredits(true),
      Setting.RedeemWhenExhausted(true),
    ].map(Setting.key)
    expect(keys).toEqual(["strategy", "session_affinity", "redeem_expiring_credits", "redeem_when_exhausted"])
  })

  it("a_reread_config_keeps_the_address_and_key_the_app_runs_with", () => {
    const listen = configs.SocketAddr.parse("127.0.0.1:9401")
    if (listen === undefined) throw new Error("no address")
    const running: Config = { ...Config.default(), listen, apiKey: "sm-running" }
    const read: Config = { ...Config.default(), apiKey: "sm-on-disk", strategy: "least-used" }
    const adopted = adopt(running, read)
    expect(adopted.listen).toEqual(running.listen)
    expect(adopted.apiKey).toBe("sm-running")
    expect(adopted.strategy).toBe("least-used")
  })

  it("sign_in_progress_moves_the_step_along", () => {
    let s = snapshot()
    // Nothing to move along.
    s = progress(s, auth.LoginEvent.Notice("ignored"))
    expect(s.signIn).toBeUndefined()

    s = { ...s, signIn: { provider: "codex", step: Step.Starting, notes: [] } }
    s = progress(s, auth.LoginEvent.DeviceCode("https://example.invalid/device", "ABCD"))
    s = progress(s, auth.LoginEvent.Notice("Still waiting."))
    expect(s.signIn?.step).toEqual(Step.DeviceCode("https://example.invalid/device", "ABCD"))
    expect(s.signIn?.notes).toEqual(["Still waiting."])

    s = progress(s, auth.LoginEvent.Authorize("ChatGPT", "https://example.invalid/authorize", false, 1455))
    expect(s.signIn?.step).toEqual(Step.Authorize("https://example.invalid/authorize", false))
  })

  it("counts_of_accounts_agree", () => {
    expect(countAccounts(0)).toBe("0 accounts")
    expect(countAccounts(1)).toBe("1 account")
    expect(countAccounts(3)).toBe("3 accounts")
  })

  it("an action that dies says it stopped, and why", () => {
    expect(stoppedText(Cause.die(new Error("boom")))).toBe("the action stopped: boom")
    expect(stoppedText(Cause.die("odd"))).toBe("the action stopped: odd")
    expect(stoppedText(Cause.interrupt())).toBe("the action stopped")
  })

  it.live("commands_are_looked_up_on_path", () =>
    Effect.gen(function* () {
      expect(yield* onPath("slopmax-surely-not-a-command")).toBeUndefined()
      if (process.platform !== "win32") {
        const sh = yield* onPath("sh")
        expect(sh).toBeDefined()
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))),
  )
})

// The app itself, in a home of its own with no proxy to be found and no CLI
// to start one.
const withApp = <A, E>(
  body: (app: App["Service"], home: string) => Effect.Effect<A, E>,
  options: { readonly serve: boolean; readonly config?: string } = { serve: false },
) =>
  Effect.gen(function* () {
    const box = yield* sandbox(options)
    return yield* Effect.gen(function* () {
      return yield* body(yield* App, box.home)
    }).pipe(
      Effect.provide(Layer.provideMerge(App.layerWith({ notify: true, cli: Effect.succeed(undefined) }), box.env)),
    )
  })

describe("lib, beyond the Rust tests", () => {
  it.live("with no proxy and no CLI, it says it cannot start one", () =>
    withApp((app) =>
      Effect.gen(function* () {
        const first = yield* app.snapshot
        expect(first.address.startsWith("http://127.0.0.1:")).toBe(true)
        expect(first.notifications).toBe(true)
        expect(first.config.apiKey).toBe(KEY)
        const stopped = yield* until(app, (s) => s.proxy._tag === "Stopped" && s.notice !== undefined)
        expect(stopped.notice?.error).toBe(true)
        expect(stopped.notice?.text).toBe(
          "Could not start the proxy: cannot find the slopmax command line, which the app runs the proxy with; reinstall the app",
        )
        // The offline report from disk, and the agents as their files have them.
        const looked = yield* until(app, (s) => s.report !== undefined && s.agents.length === 2)
        expect(looked.report?.live).toBe(false)
        expect(looked.agents.map((a) => a.id)).toEqual(["claude", "codex"])
        expect(looked.service).toBeUndefined()
        yield* Fiber.await(yield* app.dismissNotice)
        expect((yield* app.snapshot).notice).toBeUndefined()
      }),
    ),
  )

  it.live("settings, client keys, and account changes report back through the notice", () =>
    withApp((app, home) =>
      Effect.gen(function* () {
        yield* Fiber.await(yield* app.set(Setting.Strategy("least-used")))
        let s = yield* app.snapshot
        expect(s.notice).toMatchObject({ text: "slopmax now routes least used.", error: false })
        expect(s.config.strategy).toBe("least-used")
        expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('strategy = "least-used"')

        yield* Fiber.await(yield* app.set(Setting.SessionTtlMins(0)))
        s = yield* app.snapshot
        expect(s.notice).toMatchObject({ text: "session_ttl_mins is a number of minutes", error: true })

        yield* Fiber.await(yield* app.addClientKey("  laptop ", ["claude-*"]))
        s = yield* app.snapshot
        expect(s.notice?.text).toBe("Made the key laptop.")
        expect(s.newKey?.name).toBe("laptop")
        expect(s.newKey?.key.startsWith("sm-")).toBe(true)
        expect(s.config.keys.map((k) => k.name)).toEqual(["laptop"])
        // The address and key the app runs with stay.
        expect(s.config.apiKey).toBe(KEY)

        yield* Fiber.await(yield* app.revokeKey("laptop"))
        s = yield* app.snapshot
        expect(s.notice?.text).toBe("Revoked the key laptop.")
        expect(s.newKey).toBeUndefined()
        yield* Fiber.await(yield* app.revokeKey("laptop"))
        expect((yield* app.snapshot).notice).toMatchObject({ text: "there is no key named laptop", error: true })

        yield* Fiber.await(yield* app.pin("nobody"))
        expect((yield* app.snapshot).notice).toMatchObject({ text: "account nobody is gone", error: true })

        const store = Store.at(join(home, "accounts"))
        const [account] = yield* store.upsert(
          Account.assignId({ ...Account.make("anthropic", { ...Tokens.empty(), accessToken: "sk-ant-x" }, 0) }),
        )
        yield* Fiber.await(yield* app.setPriority(account.id, 3))
        expect((yield* app.snapshot).notice?.text).toBe(`${Account.name(account)} now has priority 3.`)
        yield* Fiber.await(yield* app.rename(account.id, "work"))
        expect((yield* app.snapshot).notice?.text).toBe("Renamed it work.")
        yield* Fiber.await(yield* app.setDisabled(account.id, true))
        expect((yield* app.snapshot).notice?.text).toBe("Disabled work.")
        yield* Fiber.await(yield* app.pin(account.id))
        expect((yield* app.snapshot).notice?.text).toBe("New anthropic sessions will use work while it has quota.")
        yield* Fiber.await(yield* app.unpinAll)
        expect((yield* app.snapshot).notice?.text).toBe("slopmax will choose accounts automatically.")
        yield* Fiber.await(yield* app.remove(account.id))
        expect((yield* app.snapshot).notice?.text).toBe("Removed work.")
        expect(yield* store.list()).toEqual([])
      }),
    ),
  )

  it.live("a redemption without a proxy says so", () =>
    withApp((app) =>
      Effect.gen(function* () {
        const task = yield* app.redeem("codex0")
        expect((yield* app.snapshot).redeeming).toBe("codex0")
        yield* Fiber.await(task)
        const s = yield* app.snapshot
        expect(s.redeeming).toBeUndefined()
        expect(s.notice?.error).toBe(true)
        expect(s.notice?.text.startsWith("Could not redeem a limit reset: the proxy is not running")).toBe(true)
      }),
    ),
  )

  it.live("the alerts are handed out once, and notifications switch off for later runs", () =>
    withApp((app, home) =>
      Effect.gen(function* () {
        expect(yield* app.alerts).toBeDefined()
        expect(yield* app.alerts).toBeUndefined()
        yield* Fiber.await(yield* app.setNotifications(false))
        expect((yield* app.snapshot).notifications).toBe(false)
        expect(readFileSync(join(home, "desktop-notified"), "utf8")).toBe("enabled = false\n")
      }),
    ),
  )

  it.live("a sign-in in progress is cancelled, and a paste without one goes nowhere", () =>
    withApp((app) =>
      Effect.gen(function* () {
        yield* Fiber.await(yield* app.paste("http://localhost:1455/auth/callback?code=x"))
        // An API key that is empty fails at once, as the CLI's does.
        yield* Fiber.await(yield* app.addKey("anthropic", ""))
        const failed = yield* app.snapshot
        expect(failed.signIn).toBeUndefined()
        expect(failed.notice?.error).toBe(true)
        expect(failed.notice?.text.startsWith("Sign-in failed: ")).toBe(true)
        const doctor = yield* app.checkSetup
        expect((yield* app.snapshot).doctor._tag).toBe("Running")
        yield* Fiber.await(doctor)
        expect((yield* app.snapshot).doctor._tag).toBe("Done")
        yield* Fiber.await(yield* app.cancelSignIn)
        expect((yield* app.snapshot).signIn).toBeUndefined()
      }),
    ),
  )

  it.live("with the proxy running, it says so and actions sync it", () =>
    withApp(
      (app) =>
        Effect.gen(function* () {
          const running = yield* until(app, (s) => s.proxy._tag === "Running" && s.report?.live === true)
          expect(running.proxy).toEqual(Proxy.Running(running.report?.version ?? ""))
          expect(running.notice).toBeUndefined()
          yield* Fiber.await(yield* app.refresh)
          yield* Fiber.await(yield* app.loadToday)
          expect((yield* app.snapshot).today?.range).toBe("today")
          yield* Fiber.await(yield* app.loadHistory("month"))
          expect((yield* app.snapshot).history?.range).toBe("month")
        }),
      { serve: true },
    ),
  )
})
