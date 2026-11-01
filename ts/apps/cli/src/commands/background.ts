// The proxy as a program: in the foreground (`serve`), in the background
// (`start`, `stop`), as a login service (`service`), and its dashboard.
import { ApiDoctorOptions, Background, Browser, Daemon, dashboardUrl, Home, SettingsService } from "@slopmax/core"
import { slopmaxVersion } from "@slopmax/domain"
import { ServiceView, StartedProxy } from "@slopmax/domain/desktop"
import { Effect, Option, Redacted, Schema } from "effect"
import { CliFailure } from "../failure.ts"
import { Print } from "../print.ts"
import { cliProxyApiPort } from "./misc.ts"

/**
 * Runs the proxy here until `slopmax stop` (or Ctrl-C, or SIGTERM), logging
 * to `log` when given: that is how it runs in the background.
 */
export const serve = Effect.fn("cli.serve")(function* (log: Option.Option<string>) {
  const port = yield* cliProxyApiPort
  yield* Daemon.serve({ log: Option.getOrUndefined(log) }).pipe(
    Effect.provideService(ApiDoctorOptions, port === undefined ? {} : { cliProxyApiPort: port }),
  )
})

/** Everything about a running proxy that another program needs to use it. */
const runningJson = Effect.gen(function* () {
  const background = yield* Background
  const settings = yield* (yield* SettingsService).get
  const home = yield* Home
  const version = Option.match(yield* background.running, {
    onNone: () => slopmaxVersion,
    onSome: (found) => found.version,
  })
  const started = new StartedProxy({
    url: background.baseUrl,
    dashboard: dashboardUrl(background.baseUrl, Redacted.value(settings.apiKey)),
    version,
    log: home.paths.log,
  })
  return JSON.stringify(Schema.encodeSync(StartedProxy)(started), null, 2)
})

export const start = Effect.fn("cli.start")(function* (json: boolean) {
  const print = yield* Print
  const background = yield* Background
  const home = yield* Home
  const { started } = yield* background.ensure
  if (json) {
    yield* print.out(yield* runningJson)
    return
  }
  yield* print.out(
    started
      ? `slopmax running on ${background.baseUrl} ${print.paint.dim(`(log: ${home.paths.log})`)}`
      : `slopmax is already running on ${background.baseUrl}`,
  )
})

export const stop = Effect.fn("cli.stop")(function* () {
  const print = yield* Print
  const stopped = yield* (yield* Background).stop
  yield* print.out(stopped ? "slopmax stopped" : "slopmax is not running")
})

// ---------------------------------------------------------------------------
// service

export type ServiceAction = "install" | "uninstall" | "status"

const noManager = new CliFailure({
  message:
    "no supported service manager here (systemd user services or launchd); run `slopmax start` from a login script instead",
})

const lingerHint = "To keep it running after you log out (on a server), run `loginctl enable-linger $USER`."

export const service = Effect.fn("cli.service")(function* (action: ServiceAction, json: boolean) {
  const print = yield* Print
  const { dim, green, yellow } = print.paint
  const { service: manager } = yield* Background
  if (Option.isNone(yield* manager.kind)) return yield* noManager
  switch (action) {
    case "install": {
      const file = yield* manager.install
      yield* print.out(`slopmax now starts at login ${dim(`(${file})`)}`)
      const status = yield* manager.status
      if (Option.contains(status.lingering, false)) yield* print.out(dim(lingerHint))
      return
    }
    case "uninstall": {
      const file = yield* manager.uninstall
      yield* print.out(`Removed the service ${dim(`(${file})`)}`)
      return
    }
    case "status": {
      const status = yield* manager.status
      if (json) {
        const view = new ServiceView({
          installed: status.installed,
          running: status.running,
          file: status.file,
          lingering: Option.getOrNull(status.lingering),
        })
        yield* print.out(JSON.stringify(Schema.encodeSync(ServiceView)(view), null, 2))
        return
      }
      yield* print.out(
        `service: ${
          !status.installed
            ? "not installed"
            : status.running
              ? green("installed and running")
              : yellow("installed, not running")
        }`,
      )
      if (status.installed && Option.contains(status.lingering, false)) {
        yield* print.out(dim("It stops when you log out; `loginctl enable-linger $USER` keeps it."))
      }
      return
    }
  }
})

// ---------------------------------------------------------------------------
// dashboard

export const dashboard = Effect.fn("cli.dashboard")(function* (printOnly: boolean) {
  const print = yield* Print
  const background = yield* Background
  yield* background.ensure
  const key = Redacted.value((yield* (yield* SettingsService).get).apiKey)
  const url = dashboardUrl(background.baseUrl, key)
  if (!printOnly && (yield* Browser.open(url))) {
    yield* print.out("Opened the dashboard in your browser.")
    return
  }
  const port = new URL(background.baseUrl).port
  yield* print.out("Open the dashboard at:")
  yield* print.out()
  yield* print.out(`  ${url}`)
  yield* print.out()
  yield* print.out(
    print.paint.dim(`On another machine, forward the port first: ssh -L ${port}:127.0.0.1:${port} <this host>`),
  )
})
