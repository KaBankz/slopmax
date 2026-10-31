// The desktop app apart from any UI toolkit: its state and actions (`App`,
// `Snapshot`), what a window draws (`view`), the notifications it posts
// (`alerts`), and the engine the desktop shell runs as `slopmax app-host`
// (`runHost`, speaking `protocol`, which the shell imports on its own as
// `@slopmax/app/protocol`).
export {
  type AgentStatus,
  App,
  type AppShape,
  adopt,
  bundledCli,
  defaults,
  Doctor,
  type NewEndpoint,
  type NewKey,
  type Notice,
  type Options,
  Proxy,
  Setting,
  type SignIn,
  type Snapshot,
  start,
  Step,
  type Task,
} from "./lib.ts"
export * as alerts from "./alerts.ts"
export * as view from "./view.ts"
export * as protocol from "./protocol.ts"
export { dispatch, model, runHost, type AppAction } from "./host.ts"
export { history } from "@slopmax/core"
