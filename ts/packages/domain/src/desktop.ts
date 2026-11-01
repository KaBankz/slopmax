// The desktop app's bridge between its window and its main process. The
// window talks to the proxy through slopmax's API like the dashboard does;
// this small API covers what only the main process can do (start the proxy,
// read the offline report, the tray and the panel, preferences). Main decodes
// every argument with these schemas, since the window is not trusted with more.
import { Schema } from "effect"
import { Section } from "./doctor.ts"
import { withDefault } from "./ids.ts"
import { Report } from "./report.ts"

/** Where the proxy stands, as the window's header and the tray show it. */
export const ProxyState = Schema.TaggedUnion({
  Checking: {},
  Starting: {},
  Running: { version: Schema.String },
  Stopped: {},
  /** A proxy of another version runs, under a login service that main does not restart on its own. */
  OtherVersion: { running: Schema.String, bundled: Schema.String, service: Schema.Boolean },
})
export type ProxyState = typeof ProxyState.Type

export const Appearance = Schema.Literals(["system", "light", "dark"])
export type Appearance = typeof Appearance.Type

export class Bounds extends Schema.Class<Bounds>("Bounds")({
  width: Schema.Int,
  height: Schema.Int,
  x: Schema.optionalKey(Schema.Int),
  y: Schema.optionalKey(Schema.Int),
}) {}

/** The window's preferences, in Electron's user data. Any field missing or unreadable takes its default. */
export class DesktopPrefs extends Schema.Class<DesktopPrefs>("DesktopPrefs")({
  sidebarWidth: Schema.Finite.pipe(withDefault(220)),
  sidebarHidden: Schema.Boolean.pipe(withDefault(false)),
  appearance: Appearance.pipe(withDefault("system")),
  /** Whether notices are posted as notifications. */
  notifications: Schema.Boolean.pipe(withDefault(true)),
  bounds: Schema.optionalKey(Bounds),
}) {
  /** Every preference at the default it takes when the file leaves it out. */
  static readonly defaults: DesktopPrefs = Schema.decodeUnknownSync(DesktopPrefs)({})
}

/** What running the bundled CLI for an action came to. */
export class ShellResult extends Schema.Class<ShellResult>("ShellResult")({
  ok: Schema.Boolean,
  message: Schema.String,
}) {}

/** The report and the doctor's findings, read by the CLI while the proxy is stopped. */
export class OfflineView extends Schema.Class<OfflineView>("OfflineView")({
  report: Report,
  doctor: Schema.Array(Section),
}) {}

export const ProxyAction = Schema.Literals(["start", "stop", "restart"])
export type ProxyAction = typeof ProxyAction.Type
export const ServiceAction = Schema.Literals(["install", "uninstall", "status"])
export type ServiceAction = typeof ServiceAction.Type

/** What the app's menus and keys ask the window to do. */
export const MenuAction = Schema.Literals(["refresh", "open-settings", "toggle-sidebar", "open-window"])
export type MenuAction = typeof MenuAction.Type

/** The preload API the window sees as `window.slopmaxDesktop`. Values cross as their encoded forms. */
export interface DesktopBridge {
  readonly proxyState: () => Promise<typeof ProxyState.Encoded>
  readonly onProxyState: (listener: (state: typeof ProxyState.Encoded) => void) => () => void
  readonly offline: () => Promise<typeof OfflineView.Encoded>
  readonly proxy: (action: ProxyAction) => Promise<typeof ShellResult.Encoded>
  readonly service: (action: ServiceAction) => Promise<typeof ShellResult.Encoded>
  /** Sign-in addresses and the web dashboard open in the system's browser. */
  readonly openExternal: (url: string) => void
  readonly prefs: {
    readonly get: () => Promise<typeof DesktopPrefs.Encoded>
    readonly set: (prefs: typeof DesktopPrefs.Encoded) => Promise<void>
  }
  /** The panel fits its content's height. */
  readonly panelHeight: (px: number) => void
  readonly onMenu: (listener: (action: MenuAction) => void) => () => void
  readonly openWindow: (page: string) => void
  readonly quit: () => void
}

/** What `slopmax start --json` prints: the running proxy, as main needs it to use it. */
export class StartedProxy extends Schema.Class<StartedProxy>("StartedProxy")({
  url: Schema.String,
  /** The dashboard's address, carrying the owner key. */
  dashboard: Schema.String,
  /** The running proxy's version, which may differ from the CLI's. */
  version: Schema.String,
  log: Schema.String,
}) {}

/** What `slopmax service status --json` prints. */
export class ServiceView extends Schema.Class<ServiceView>("ServiceView")({
  installed: Schema.Boolean,
  running: Schema.Boolean,
  file: Schema.String,
  /** Whether it keeps running after logout (systemd's lingering); null where that does not apply. */
  lingering: Schema.NullOr(Schema.Boolean),
}) {}
