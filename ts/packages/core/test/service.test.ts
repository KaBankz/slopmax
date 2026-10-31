import { describe, expect, test } from "bun:test"
import process from "node:process"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect } from "effect"

import { chain } from "../src/error.ts"
import {
  detect,
  file,
  launchdDomain,
  launchdPlist,
  launchdTarget,
  lingering,
  run,
  succeeds,
  systemdUnit,
} from "../src/service.ts"

const env = (vars: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars)))

describe("service", () => {
  it("systemd_unit_runs_serve_and_appends_to_the_log", () => {
    const unit = systemdUnit("/opt/slopmax/bin/slopmax", "/home/u/.slopmax/slopmax.log", undefined)
    expect(unit).toContain('ExecStart="/opt/slopmax/bin/slopmax" serve\n')
    expect(unit).toContain("Restart=on-failure\n")
    expect(unit).toContain("StandardOutput=append:/home/u/.slopmax/slopmax.log\n")
    expect(unit).toContain("WantedBy=default.target\n")
    expect(unit).not.toContain("Environment=")
    const custom = systemdUnit("/x", "/y", "/srv/slopmax")
    expect(custom).toContain('Environment="SLOPMAX_HOME=/srv/slopmax"\n')
  })

  it("launchd_plist_escapes_paths", () => {
    const plist = launchdPlist("/Users/a&b/slopmax", "/Users/a&b/.slopmax/slopmax.log", undefined)
    expect(plist).toContain("<string>/Users/a&amp;b/slopmax</string>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).not.toContain("EnvironmentVariables")
  })

  it("launchd_plist_sets_slopmax_home_when_moved", () => {
    const plist = launchdPlist("/bin/slopmax", "/l.log", "/srv/<home>")
    expect(plist).toContain(
      "<key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>/srv/&lt;home&gt;</string>",
    )
    expect(plist).toContain("<string>dev.slopmax</string>")
    expect(plist.endsWith("</dict>\n</plist>\n")).toBe(true)
  })

  it.live("commands_report_their_stderr_when_they_fail", () =>
    Effect.gen(function* () {
      yield* run("sh", ["-c", "exit 0"])
      const error = yield* Effect.flip(run("sh", ["-c", "echo nope >&2; exit 3"]))
      expect(error.message).toBe("sh -c echo nope >&2; exit 3 failed: nope")
      const missing = yield* Effect.flip(run("slopmax-no-such-program", []))
      expect(missing.message).toBe("running slopmax-no-such-program")
      expect(chain(missing)).toBe("running slopmax-no-such-program: No such file or directory (os error 2)")
      expect(yield* succeeds("sh", ["-c", "exit 0"])).toBe(true)
      expect(yield* succeeds("sh", ["-c", "exit 1"])).toBe(false)
      expect(yield* succeeds("slopmax-no-such-program", [])).toBe(false)
    }),
  )

  it.live("launchd_targets_the_users_gui_domain", () =>
    Effect.gen(function* () {
      const domain = yield* launchdDomain
      const uid = domain.replace(/^gui\//, "")
      expect(domain.startsWith("gui/")).toBe(true)
      expect(/^\d+$/.test(uid)).toBe(true)
      expect(yield* launchdTarget).toBe(`${domain}/dev.slopmax`)
    }),
  )

  it.effect("service_files_live_where_each_manager_looks", () =>
    Effect.gen(function* () {
      const unit = yield* file("systemd")
      expect(unit.endsWith("systemd/user/slopmax.service")).toBe(true)
      const plist = yield* file("launchd")
      expect(plist.endsWith("Library/LaunchAgents/dev.slopmax.plist")).toBe(true)
    }),
  )

  // Without loginctl there is nothing to ask (`#[cfg(not(target_os = "linux"))]` in the Rust).
  test.skipIf(process.platform === "linux")("lingering_is_a_linux_question", async () => {
    expect(await Effect.runPromise(lingering)).toBeUndefined()
  })
})

describe("service, beyond the Rust tests", () => {
  it("units_are_written_exactly", () => {
    expect(systemdUnit("/b/slopmax", "/h/slopmax.log", "/h")).toBe(
      "[Unit]\nDescription=slopmax account pool for Claude Code and Codex\nAfter=network-online.target\n" +
        'Wants=network-online.target\n\n[Service]\nExecStart="/b/slopmax" serve\nEnvironment="SLOPMAX_HOME=/h"\n' +
        "Restart=on-failure\nRestartSec=5\nStandardOutput=append:/h/slopmax.log\nStandardError=append:/h/slopmax.log\n" +
        "\n[Install]\nWantedBy=default.target\n",
    )
    expect(launchdPlist("/b/slopmax", "/l.log", undefined)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dev.slopmax</string>\n' +
        "  <key>ProgramArguments</key>\n  <array>\n    <string>/b/slopmax</string>\n    <string>serve</string>\n" +
        "  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n" +
        "    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>StandardOutPath</key>\n" +
        "  <string>/l.log</string>\n  <key>StandardErrorPath</key>\n  <string>/l.log</string>\n</dict>\n</plist>\n",
    )
  })

  it.effect("the_unit_lives_under_an_absolute_xdg_config_home_only", () =>
    Effect.gen(function* () {
      expect(yield* file("systemd").pipe(env({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" }))).toBe(
        "/cfg/systemd/user/slopmax.service",
      )
      expect(yield* file("systemd").pipe(env({ HOME: "/home/u", XDG_CONFIG_HOME: "cfg" }))).toBe(
        "/home/u/.config/systemd/user/slopmax.service",
      )
      expect(yield* file("launchd").pipe(env({ HOME: "/home/u" }))).toBe(
        "/home/u/Library/LaunchAgents/dev.slopmax.plist",
      )
    }),
  )

  it.live("slopmax_no_service_hides_the_manager", () =>
    Effect.gen(function* () {
      expect(yield* detect.pipe(env({ SLOPMAX_NO_SERVICE: "1" }))).toBeUndefined()
      // Without a user there is nobody to ask about lingering.
      expect(yield* lingering.pipe(env({}))).toBeUndefined()
    }),
  )
})
