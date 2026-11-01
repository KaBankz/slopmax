// The names the window and the main process talk over, shared by the preload
// script and main so neither can drift from the other. The window never sees
// these: it sees `window.slopmaxDesktop`, which the preload builds on them.
import type { MenuAction, ProxyState } from "@slopmax/domain/desktop"

export const channels = {
  /** Asked: where the proxy stands now. */
  proxyState: "slopmax:proxy-state",
  /** Told by main: the proxy's state changed. */
  proxyStateChanged: "slopmax:proxy-state-changed",
  /** Asked: the report and the doctor, read by the CLI while the proxy is stopped. */
  offline: "slopmax:offline",
  /** Asked: start, stop or restart the proxy. */
  proxy: "slopmax:proxy",
  /** Asked: install, remove or read the login service. */
  service: "slopmax:service",
  /** Told: open an address in the system's browser. */
  openExternal: "slopmax:open-external",
  prefsGet: "slopmax:prefs-get",
  prefsSet: "slopmax:prefs-set",
  /** Told by the panel: how tall its content is. */
  panelHeight: "slopmax:panel-height",
  /** Told by main: a menu item or key the window acts on. */
  menu: "slopmax:menu",
  /** Told by the panel: open the main window at a page. */
  openWindow: "slopmax:open-window",
  quit: "slopmax:quit",
} as const

/** Every menu action, so the preload passes on only what the window understands. */
export const menuActions = [
  "refresh",
  "open-settings",
  "toggle-sidebar",
  "open-window",
] as const satisfies ReadonlyArray<MenuAction>

export const isMenuAction = (value: unknown): value is MenuAction =>
  typeof value === "string" && menuActions.some((action) => action === value)

const proxyTags = ["Checking", "Starting", "Running", "Stopped", "OtherVersion"] as const satisfies ReadonlyArray<
  ProxyState["_tag"]
>

/** A cheap first look at a state from main; the window decodes it fully with its Schema. */
export const isProxyState = (value: unknown): value is typeof ProxyState.Encoded =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  proxyTags.some((tag) => tag === value._tag) &&
  (value._tag !== "Running" || ("version" in value && typeof value.version === "string")) &&
  (value._tag !== "OtherVersion" ||
    ("running" in value &&
      typeof value.running === "string" &&
      "bundled" in value &&
      typeof value.bundled === "string" &&
      "service" in value &&
      typeof value.service === "boolean"))
