// The window's one way to the main process: `window.slopmaxDesktop`. It runs
// sandboxed before the page, so it holds no logic and no secrets; it passes
// calls to main, which decodes every argument, and passes main's messages
// back only when they have the shape the window expects. Built as CommonJS,
// the only form a sandboxed preload may take.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { DesktopBridge } from "@slopmax/domain/desktop"
import { channels, isMenuAction, isProxyState } from "./channels.ts"

/** Listens on a channel for values that pass `accept`, until the returned function is called. */
const listen =
  <A>(channel: string, accept: (value: unknown) => value is A) =>
  (listener: (value: A) => void): (() => void) => {
    const heard = (_event: IpcRendererEvent, value: unknown) => {
      if (accept(value)) listener(value)
    }
    ipcRenderer.on(channel, heard)
    return () => {
      ipcRenderer.removeListener(channel, heard)
    }
  }

const bridge: DesktopBridge = {
  proxyState: () => ipcRenderer.invoke(channels.proxyState),
  onProxyState: listen(channels.proxyStateChanged, isProxyState),
  offline: () => ipcRenderer.invoke(channels.offline),
  proxy: (action) => ipcRenderer.invoke(channels.proxy, action),
  service: (action) => ipcRenderer.invoke(channels.service, action),
  openExternal: (url) => ipcRenderer.send(channels.openExternal, url),
  prefs: {
    get: () => ipcRenderer.invoke(channels.prefsGet),
    set: (prefs) => ipcRenderer.invoke(channels.prefsSet, prefs),
  },
  panelHeight: (px) => ipcRenderer.send(channels.panelHeight, px),
  onMenu: listen(channels.menu, isMenuAction),
  openWindow: (page) => ipcRenderer.send(channels.openWindow, page),
  quit: () => ipcRenderer.send(channels.quit),
}

contextBridge.exposeInMainWorld("slopmaxDesktop", bridge)
