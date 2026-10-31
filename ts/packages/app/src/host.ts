// The engine behind the desktop shell: `slopmax app-host` runs `runHost`,
// which starts the `App`, reads `Request`s from stdin and writes `Event`s to
// stdout, one JSON message per line (see `protocol.ts`). Each snapshot
// change becomes a `View` the renderer draws without logic of its own, each
// alert a `Notify`, each request's end a `Done`. When stdin closes, the app
// stops; the proxy it started keeps running, as it does when the Rust app
// quits.
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Queue,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stdio,
  Stream,
} from "effect"

import { config as configs, error, history, log, serde, text as texts, VERSION, type time } from "@slopmax/core"

import { type AppShape, type Options, defaults, Setting, type Snapshot, start, type Task } from "./lib.ts"
import * as protocol from "./protocol.ts"
import * as view from "./view.ts"

type Timestamp = time.Timestamp

// ---- the view model -------------------------------------------------------------

const proxyView = (snapshot: Snapshot, status: view.Status | undefined): protocol.View["proxy"] => {
  const proxy = snapshot.proxy
  const running = proxy._tag === "Running"
  const toggle = {
    label: running ? "Stop" : "Start",
    primary: !running,
    action: running ? { _tag: "StopProxy" as const } : { _tag: "StartProxy" as const },
  }
  const base = { address: snapshot.address, running, line: view.proxyLine(snapshot), toggle }
  switch (proxy._tag) {
    case "Running":
      return {
        ...base,
        state: "running",
        version: proxy.version,
        foot: { text: `Running ${proxy.version}`, tone: "good" },
        setting: { text: `Running ${proxy.version}`, tone: "good" },
        panel: status === undefined ? { text: "Running", tone: "good" } : { text: status.headline, tone: status.tone },
      }
    case "Starting":
      return {
        ...base,
        state: "starting",
        foot: { text: "Starting…", tone: "warn" },
        setting: { text: "Starting…", tone: "muted" },
        panel: { text: "Starting the proxy…", tone: "muted" },
      }
    case "Checking":
      return {
        ...base,
        state: "checking",
        foot: { text: "Looking for the proxy…", tone: "muted" },
        setting: { text: "Looking for it…", tone: "muted" },
        panel: { text: "Starting the proxy…", tone: "muted" },
      }
    case "Stopped":
      return {
        ...base,
        state: "stopped",
        foot: { text: "Stopped", tone: "bad" },
        setting: { text: "Stopped", tone: "bad" },
        panel: { text: "The proxy is stopped", tone: "bad" },
      }
  }
}

const BUTTON = { SignIn: "Sign in…", Redeem: "Redeem…", Look: "Show" } as const

const menu = (row: view.Row): Array<protocol.MenuItem> => {
  const items: Array<protocol.MenuItem> = [
    row.pinned
      ? { _tag: "Choice", key: "unpin", label: "Stop pinning", enabled: true, action: { _tag: "UnpinAll" } }
      : {
          _tag: "Choice",
          key: "pin",
          label: "Use for new sessions",
          enabled: !row.disabled,
          action: { _tag: "Pin", account: row.id },
        },
    {
      _tag: "Choice",
      key: "toggle",
      label: row.disabled ? "Enable" : "Disable",
      enabled: true,
      action: { _tag: "SetDisabled", account: row.id, disabled: !row.disabled },
    },
    { _tag: "Separator" },
    { _tag: "Caption", text: `Priority ${row.priority}` },
    {
      _tag: "Choice",
      key: "raise",
      label: "Raise priority",
      enabled: true,
      action: { _tag: "SetPriority", account: row.id, priority: row.priority + 1 },
    },
    {
      _tag: "Choice",
      key: "lower",
      label: "Lower priority",
      enabled: true,
      action: { _tag: "SetPriority", account: row.id, priority: row.priority - 1 },
    },
  ]
  // An imported login it follows another tool's copy of.
  if (row.follows !== undefined) {
    items.push(
      { _tag: "Separator" },
      {
        _tag: "Choice",
        key: "own",
        label: `Refresh here instead of ${row.follows}`,
        enabled: true,
        action: { _tag: "Own", account: row.id },
      },
    )
  }
  if (row.credits !== undefined) {
    items.push(
      { _tag: "Separator" },
      { _tag: "Choice", key: "redeem", label: "Redeem a limit reset…", enabled: row.credits.held === undefined },
    )
  }
  return items
}

const rowView = (row: view.Row, snapshot: Snapshot, policy: string | undefined): protocol.Row => {
  // Out of quota on one window, it waits on that one alone, so the others fade.
  const held = row.limits.some((g) => g !== undefined && g.fraction >= 1)
  const running = snapshot.proxy._tag === "Running"
  const credits = row.credits
  const reason = credits?.held ?? (running ? undefined : "Start the proxy to redeem one")
  return {
    ...row,
    limits: row.limits.map((g) => g ?? null),
    faded: row.limits.map((g) => row.disabled || (held && g !== undefined && g.fraction < 1)),
    credits:
      credits === undefined
        ? undefined
        : {
            ...credits,
            redeeming: snapshot.redeeming === row.id,
            reason,
            canRedeem: reason === undefined,
            redeem: { _tag: "Redeem", account: row.id },
            policy,
          },
    menu: menu(row),
  }
}

const groupView = (group: view.Group, snapshot: Snapshot, attention: ReadonlyArray<view.Attention>): protocol.Group => {
  const total = group.accounts.length
  const noun = total === 1 ? "account" : "accounts"
  const enabled = group.accounts.filter((r) => !r.disabled)
  const ready = enabled.filter((r) => r.status.tone === "good").length
  const policy = view.autoRedeem(snapshot.config, group.title)
  return {
    ...group,
    accounts: group.accounts.map((r) => rowView(r, snapshot, policy)),
    basis: view.poolBasis(group),
    segmentsTip: view.segmentsTip(group),
    across:
      group.working === total
        ? `Across ${total} ${noun}, ${view.poolBasis(group)}`
        : `Across ${group.working} of ${total} ${noun}, ${view.poolBasis(group)}; the rest are out of service`,
    ready: `${ready} of ${enabled.length} ready`,
    pinned: group.accounts.some((r) => r.pinned),
    // Only accounts out of service show by name, and only those Needs
    // attention does not already.
    troubled: enabled
      .filter((r) => r.status.tone === "warn" || r.status.tone === "bad")
      .filter((r) => !attention.some((a) => a.account === r.id))
      .map((r) => ({ id: r.id, name: r.name, status: r.status })),
  }
}

const stepper = (
  steps: ReadonlyArray<number>,
  value: number,
  text: string,
  detail: string,
): protocol.View["settings"]["sessionTtl"] => ({
  value,
  text,
  down: view.step(steps, value, false),
  up: view.step(steps, value, true),
  detail,
})

// `ui::sentence`: without leading bullets, the first letter upper-cased.
const sentence = (text: string): string => {
  const unbulleted = text.replace(/^●+/, "")
  // `str::trim_start`: the trimmed text starts where the leading space ends.
  const trimmed = texts.trim(unbulleted)
  return trimmed === "" ? "" : view.upperFirst(unbulleted.slice(unbulleted.indexOf(trimmed)))
}

// A history's JSON, once per history: it is the largest part of a view and
// changes only when loaded again.
const encodedHistory = new WeakMap<history.History, Schema.Json>()
const encodeHistory = Schema.encodeResult(history.HistorySchema)

// serde's number forms (`40.0`) as the plain numbers they are.
const plain = (value: unknown): Schema.Json => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  if (serde.isRaw(value)) return Number(value.rawJSON)
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value !== "object") return null
  const out: Record<string, Schema.Json> = {}
  for (const [key, field] of Object.entries(value)) if (field !== undefined) out[key] = plain(field)
  return out
}

const historyView = (loaded: history.History | undefined): protocol.View["history"] => {
  if (loaded === undefined) return undefined
  let data = encodedHistory.get(loaded)
  if (data === undefined) {
    const encoded = encodeHistory(loaded)
    // The core's own value always encodes; were it not to, there is no chart.
    if (Result.isFailure(encoded)) return undefined
    data = plain(encoded.success)
    encodedHistory.set(loaded, data)
  }
  return { range: loaded.range, data, left: view.leftLine(loaded.left.windows, loaded.left.unused) }
}

/** Everything the shell draws for `snapshot` at `now`. */
export const model = (snapshot: Snapshot, now: Timestamp): protocol.View => {
  const report = snapshot.report
  const status = report === undefined ? undefined : view.status(report, now)
  const attention = report === undefined ? [] : view.attention(report, now)
  const groups = report === undefined ? [] : view.groups(report, now)
  const config = snapshot.config
  const running = snapshot.proxy._tag === "Running"
  const doctor = snapshot.doctor
  const login = view.login(snapshot.service)
  return {
    proxy: proxyView(snapshot, status),
    menuBar: report === undefined ? "slopmax" : view.menuBar(report, now),
    loaded: report !== undefined,
    status,
    attention: attention.map((a) => ({ ...a, button: BUTTON[a.remedy] })),
    routing: view.routing(config),
    providers: groups.map((g) => {
      const tones = attention.filter((a) => a.provider === g.provider).map((a) => a.tone)
      const dot = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : undefined
      return { provider: g.provider, title: g.title, count: g.accounts.length, dot }
    }),
    groups: groups.map((g) => groupView(g, snapshot, attention)),
    canRefresh: running,
    canOpenDashboard: running,
    notice: snapshot.notice === undefined ? undefined : { text: snapshot.notice.text, error: snapshot.notice.error },
    signIn: snapshot.signIn === undefined ? undefined : view.signIn(snapshot.signIn),
    agents: snapshot.agents.map((a) => {
      const [line, through] = view.agentLine(a)
      return {
        id: a.id,
        title: a.title,
        line,
        state: through ? { text: "Connected", tone: "good" } : { text: "Not connected", tone: "muted" },
        button: through
          ? { label: "Disconnect", action: { _tag: "DisconnectAgent", agent: a.id } }
          : { label: "Connect", action: { _tag: "ConnectAgent", agent: a.id } },
      }
    }),
    login: {
      ...login,
      action: login.on ? { _tag: "UninstallService" } : { _tag: "InstallService" },
    },
    settings: {
      strategies: configs.Strategy.ALL.map((strategy) => ({
        title: view.strategyTitle(strategy),
        detail: view.strategyDetail(strategy),
        chosen: config.strategy === strategy,
        action: { _tag: "Set", setting: Setting.Strategy(strategy) },
      })),
      affinity: config.sessionAffinity,
      affinityDetail: view.AFFINITY,
      affinityHeader: view.AFFINITY_HEADER,
      redeemExpiring: config.redeemExpiringCredits,
      redeemExpiringDetail: view.redeemExpiringDetail(),
      redeemExhausted: config.redeemWhenExhausted,
      redeemExhaustedDetail: view.REDEEM_EXHAUSTED,
      sessionTtl: stepper(
        view.SESSION_TTL_STEPS,
        config.sessionTtlMins,
        view.minutes(config.sessionTtlMins),
        view.liveDetail("session_ttl_mins"),
      ),
      poll: stepper(
        view.POLL_STEPS,
        config.pollMins,
        config.pollMins === 0 ? "Off" : view.minutes(config.pollMins),
        view.liveDetail("poll_mins"),
      ),
      warmWindows: config.warmWindows,
      warmWindowsDetail: view.liveDetail("warm_windows"),
      paidOverflow: config.paidOverflow,
      paidOverflowDetail: view.liveDetail("paid_overflow"),
      notifications: snapshot.notifications,
    },
    keys: config.keys.map((k) => ({ name: k.name, models: k.models.length === 0 ? "Any model" : k.models.join(", ") })),
    newKey: snapshot.newKey,
    doctor: {
      state:
        doctor._tag === "NotRun"
          ? "not-run"
          : doctor._tag === "Running"
            ? "running"
            : doctor._tag === "Done"
              ? "done"
              : "failed",
      message: doctor._tag === "Failed" ? doctor.message : undefined,
      findings:
        doctor._tag === "Done"
          ? doctor.sections.flatMap((section) =>
              section.findings.map((finding, i) => ({
                section: i === 0 ? section.title : undefined,
                text: sentence(finding.text.replaceAll("`", "")),
                tone: view.levelTone(finding.level),
                fix: finding.fix,
              })),
            )
          : [],
      canCheck: doctor._tag !== "Running",
    },
    ranges: history.Range.ALL.map((range) => ({ range, title: view.rangeTitle(range) })),
    history: historyView(snapshot.history),
    today: historyView(snapshot.today),
  }
}

// ---- requests ---------------------------------------------------------------------

/** What the app does, as against `Window`, which the host itself keeps. */
export type AppAction = Exclude<protocol.Action, { readonly _tag: "Window" }>

/** Runs `action` on `app`; the task ends when its work does. */
export const dispatch = (app: AppShape, action: AppAction): Effect.Effect<Task> => {
  switch (action._tag) {
    case "SignIn":
      return app.signIn(action.provider)
    case "AddKey":
      return app.addKey(action.provider, action.key)
    case "AddEndpoint":
      return app.addEndpoint({
        url: action.url,
        dialect: action.dialect,
        models: action.models,
        key: action.key,
        label: action.label,
      })
    case "AddClientKey":
      return app.addClientKey(action.name, action.models)
    case "RevokeKey":
      return app.revokeKey(action.name)
    case "DismissNewKey":
      return app.dismissNewKey
    case "CheckSetup":
      return app.checkSetup
    case "Own":
      return app.own(action.account)
    case "Paste":
      return app.paste(action.address)
    case "CancelSignIn":
      return app.cancelSignIn
    case "Import":
      return app.import
    case "Pin":
      return app.pin(action.account)
    case "UnpinAll":
      return app.unpinAll
    case "SetDisabled":
      return app.setDisabled(action.account, action.disabled)
    case "SetPriority":
      return app.setPriority(action.account, action.priority)
    case "Rename":
      return app.rename(action.account, action.label)
    case "Remove":
      return app.remove(action.account)
    case "ConnectAgent":
      return app.connectAgent(action.agent)
    case "DisconnectAgent":
      return app.disconnectAgent(action.agent)
    case "StartProxy":
      return app.startProxy
    case "StopProxy":
      return app.stopProxy
    case "InstallService":
      return app.installService
    case "UninstallService":
      return app.uninstallService
    case "Redeem":
      return app.redeem(action.account)
    case "Set":
      return app.set(action.setting)
    case "SetNotifications":
      return app.setNotifications(action.on)
    case "Refresh":
      return app.refresh
    case "LoadHistory":
      return app.loadHistory(action.range)
    case "LoadToday":
      return app.loadToday
    case "OpenDashboard":
      return app.openDashboard
    case "DismissNotice":
      return app.dismissNotice
  }
}

// ---- the host ---------------------------------------------------------------------

/** How often the view follows the clock while a window shows, for its countdowns. */
const TICK = "1 second"

// `event` as a line. One the protocol would not take is a fault in the
// view: it is said on stderr and left out, and the shell keeps the last.
const lineOf = (event: protocol.Event): string | undefined => {
  const encoded = protocol.encodeEvent(event)
  if (Result.isSuccess(encoded)) return `${encoded.success}\n`
  log.warn(`the host left out a ${event._tag} the protocol does not take: ${encoded.failure}`)
  return undefined
}

/**
 * Serves the desktop shell over stdin and stdout until stdin closes: starts
 * the app (with `options`, by default posting nudges and running the proxy
 * with this program), then answers requests. Fails, after a `Fatal`, if the
 * app cannot start.
 */
export const runHost = Effect.fn("runHost")(function* (options: Options = defaults()) {
  const stdio = yield* Stdio.Stdio
  const out = yield* Queue.unbounded<string, Cause.Done>()
  const send = (event: protocol.Event): void => {
    const line = lineOf(event)
    if (line !== undefined) Queue.offerUnsafe(out, line)
  }
  const writer = yield* Effect.forkChild(Stream.run(Stream.fromQueue(out), stdio.stdout()))

  send({ _tag: "Hello", protocol: protocol.VERSION, version: VERSION })

  // The app's work runs in a scope of its own, closed however the host
  // ends: stdin closing, a failed start, or the host being interrupted.
  const served = yield* Effect.exit(
    Effect.acquireUseRelease(
      Scope.make(),
      (scope) => serve(scope, options, stdio, send, out),
      (scope, exit) => Scope.close(scope, exit),
    ),
  )
  // Everything said is written before this returns.
  yield* Queue.end(out)
  yield* Fiber.await(writer)
  return yield* served
})

/** `runHost` once its scope is made: starts the app in it, then answers requests until stdin closes. */
const serve = Effect.fn("runHost.serve")(function* (
  scope: Scope.Scope,
  options: Options,
  stdio: Stdio.Stdio,
  send: (event: protocol.Event) => void,
  out: Queue.Queue<string, Cause.Done>,
) {
  const started = yield* Effect.exit(start(options).pipe(Scope.provide(scope)))
  if (Exit.isFailure(started)) {
    const failure = Cause.findErrorOption(started.cause)
    const message = Option.isSome(failure) ? error.chain(failure.value) : Cause.pretty(started.cause)
    send({ _tag: "Fatal", message })
    return yield* Effect.fail(Option.isSome(failure) ? failure.value : new error.Failure({ message }))
  }
  const app = started.value

  // What was last sent, to send only what changed.
  let lastView = ""
  let lastPrompt = ""
  let shown = false
  const publishing = yield* Semaphore.make(1)
  const publish = publishing.withPermit(
    Effect.gen(function* () {
      const snapshot = yield* app.snapshot
      const drawn = model(snapshot, yield* Clock.currentTimeMillis)
      const viewLine = lineOf({ _tag: "View", view: drawn })
      if (viewLine !== undefined && viewLine !== lastView) {
        lastView = viewLine
        Queue.offerUnsafe(out, viewLine)
      }
      const promptLine = lineOf({ _tag: "Prompt", signIn: drawn.signIn })
      if (promptLine !== undefined && promptLine !== lastPrompt) {
        // None before the first sign-in.
        if (lastPrompt !== "" || drawn.signIn !== undefined) Queue.offerUnsafe(out, promptLine)
        lastPrompt = promptLine
      }
    }),
  )
  const background = yield* FiberSet.make<unknown, never>().pipe(Scope.provide(scope))
  yield* FiberSet.run(
    background,
    Stream.runForEach(app.changes, () => publish),
  )
  yield* FiberSet.run(
    background,
    Effect.repeat(
      Effect.suspend(() => (shown ? publish : Effect.void)),
      Schedule.spaced(TICK),
    ),
  )
  const alerts = yield* app.alerts
  if (alerts !== undefined) {
    yield* FiberSet.run(
      background,
      Stream.runForEach(Stream.fromQueue(alerts), (alert) =>
        Effect.sync(() => send({ _tag: "Notify", key: alert.key, title: alert.title, body: alert.body })),
      ),
    )
  }

  const requests = yield* FiberSet.make<unknown, never>().pipe(Scope.provide(scope))
  const answer = (line: string): Effect.Effect<void> => {
    if (line.trim() === "") return Effect.void
    const decoded = protocol.decodeRequest(line)
    if (decoded._tag === "Failure") return Effect.sync(() => send({ _tag: "Rejected", error: decoded.failure }))
    const { id, action } = decoded.success
    if (action._tag === "Window") {
      // Seen at once, without a task: the view follows the clock from now.
      return Effect.flatMap(
        Effect.sync(() => {
          shown = action.shown
        }),
        () =>
          Effect.andThen(
            publish,
            Effect.sync(() => send({ _tag: "Done", id })),
          ),
      )
    }
    // Each action starts here, in the order asked, as a UI calls the app;
    // only the wait for its work to end runs aside.
    return Effect.flatMap(dispatch(app, action), (task) =>
      Effect.asVoid(
        FiberSet.run(
          requests,
          Effect.flatMap(Fiber.await(task), (exit) =>
            Effect.sync(() =>
              send(Exit.isSuccess(exit) ? { _tag: "Done", id } : { _tag: "Done", id, error: "the action stopped" }),
            ),
          ),
        ),
      ),
    )
  }
  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach(answer),
    // Stdin that breaks is stdin closed.
    Effect.catchCause(() => Effect.void),
  )

  // Stdin closed: the shell is gone. Stop the app's work (the proxy stays);
  // what is left to say is said once the scope has closed.
  yield* FiberSet.clear(requests)
})
