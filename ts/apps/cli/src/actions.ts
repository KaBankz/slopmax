// The real actions behind the command tree: each command's effect over the
// engine's live layers, built only once a command has parsed, so printing
// help or the version never creates slopmax's home. `serve` runs the
// daemon, which brings its own layers over the platform and the dashboard's
// files.
import { CoreLive, Log, Platform } from "@slopmax/core"
import { Effect, Layer, Option } from "effect"
import type { Actions } from "./cli.ts"
import { importLogins, login, own, priority, redeem, remove, setDisabled, use, label } from "./commands/accounts.ts"
import { dashboard, serve, service, start, stop } from "./commands/background.ts"
import { config } from "./commands/config.ts"
import { addKey, listKeys, removeKey } from "./commands/keys.ts"
import { logs } from "./commands/logs.ts"
import { doctor, notify } from "./commands/misc.ts"
import { env, run } from "./commands/run.ts"
import { noAccountsYet, setup } from "./commands/setup.ts"
import { status } from "./commands/status.ts"
import { usage } from "./commands/usage.ts"
import { embedded } from "./embedded.ts"
import { Print } from "./print.ts"
import { Prompter } from "./terminal.ts"

/** What every command but `serve` runs on: the engine, the terminal, and warnings-only logs. */
export const commandLayer = Layer.mergeAll(Print.layer, Prompter.layer, Log.layer({ fallback: "Warn" })).pipe(
  Layer.provideMerge(CoreLive),
)

type CommandServices = Layer.Success<typeof commandLayer>

const inCore = <A, E>(effect: Effect.Effect<A, E, CommandServices>) => Effect.provide(effect, commandLayer)

/** The setup with every answer left to the person (or the defaults). */
const guided = setup({
  agent: Option.none(),
  undo: false,
  yes: false,
  import: Option.none(),
  login: Option.none(),
  keysFromEnv: false,
  strategy: Option.none(),
  affinity: Option.none(),
  agents: Option.none(),
  noService: false,
})

/** A bare `slopmax`: the guided setup at a terminal before any account exists, else the status. */
const bare = Effect.gen(function* () {
  const prompter = yield* Prompter
  if (prompter.interactive && (yield* noAccountsYet)) return yield* guided
  return yield* status({ refresh: false, watch: false, json: false })
})

/** Bun's platform, which the binary's entry point provides to everything. */
export type PlatformServices = Layer.Success<typeof Platform.layer>

export const liveActions: Actions<unknown, PlatformServices> = {
  bare: inCore(bare),
  setup: (input) => inCore(setup(input)),
  status: (input) => inCore(status(input)),
  login: (input) => inCore(login(input)),
  import: (input) => inCore(importLogins(input)),
  own: (account) => inCore(own(account)),
  use: (account) => inCore(use(account)),
  label: (account, name) => inCore(label(account, name)),
  priority: (account, value) => inCore(priority(account, value)),
  enable: (account) => inCore(setDisabled(account, false)),
  disable: (account) => inCore(setDisabled(account, true)),
  remove: (account) => inCore(remove(account)),
  redeem: (input) => inCore(redeem(input)),
  serve: (log) => serve(log).pipe(Effect.provide(embedded)),
  start: (json) => inCore(start(json)),
  stop: inCore(stop()),
  service: (action, json) => inCore(service(action, json)),
  run: (agent, args) => inCore(run(agent, args)),
  env: (agent) => inCore(env(agent)),
  config: (input) => inCore(config(input)),
  usage: (input) => inCore(usage(input)),
  keyList: inCore(listKeys()),
  keyAdd: (name, models) => inCore(addKey(name, models)),
  keyRemove: (name) => inCore(removeKey(name)),
  logs: (input) => inCore(logs(input)),
  notify: inCore(notify()),
  dashboard: (print) => inCore(dashboard(print)),
  doctor: (json) => inCore(doctor(json)),
}
