// Electron's main-process API as a service. Only `main.ts` loads the
// `electron` module and provides it here; every other part of main asks for
// it, so their pure parts (placement, menus, routing, decoding) load and test
// under Bun without Electron.
import type { WebPreferences } from "electron"
import { Context } from "effect"

export type ElectronMain = typeof import("electron")

export class Electron extends Context.Service<Electron, ElectronMain>()("slopmax-desktop/Electron") {}

/** Where the app's own files are, and what it runs on. */
export interface Places {
  /** The directory holding main.js, preload.cjs, the UI's files (`ui/`) and the icons (`icons/`). */
  readonly here: string
  readonly platform: string
}

export class AppPlaces extends Context.Service<AppPlaces, Places>()("slopmax-desktop/AppPlaces") {}

/**
 * Loads an address in a window. A load can be cut short (the window closes,
 * or a newer page replaces it), which is no failure of the app's; the window
 * shows whatever it reached.
 */
export const load = (win: { readonly loadURL: (url: string) => Promise<void> }, url: string): void => {
  win.loadURL(url).catch(() => undefined)
}

/** Both windows' renderers: isolated, sandboxed, and given only the preload's bridge. */
export const webPreferences = (places: Places): WebPreferences => ({
  preload: `${places.here}/preload.cjs`,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
})
