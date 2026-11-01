// The application menu and its keys: on macOS the menu bar's `slopmax`,
// File, Edit, View and Window menus; elsewhere the same commands in the
// window's menu, with Ctrl where macOS has Cmd. The View menu says Hide or
// Show Sidebar by how the sidebar stands, so it is rebuilt when that changes.
import type { MenuItemConstructorOptions } from "electron"
import { Data } from "effect"

/** What a menu item asks of the app. */
export type MenuCommand =
  | "open-window"
  | "settings"
  | "sign-in-claude"
  | "sign-in-chatgpt"
  | "import"
  | "add-key"
  | "toggle-sidebar"
  | "refresh"

type Role = NonNullable<MenuItemConstructorOptions["role"]>

export type MenuEntry = Data.TaggedEnum<{
  Command: { readonly label: string; readonly command: MenuCommand; readonly keys?: string }
  Role: { readonly role: Role; readonly label?: string }
  Separator: {}
  Menu: { readonly label: string; readonly role?: Role; readonly items: ReadonlyArray<MenuEntry> }
}>
export const MenuEntry = Data.taggedEnum<MenuEntry>()

const command = (label: string, run: MenuCommand, keys?: string): MenuEntry =>
  MenuEntry.Command({ label, command: run, ...(keys === undefined ? {} : { keys }) })
const role = (name: Role, label?: string): MenuEntry =>
  MenuEntry.Role({ role: name, ...(label === undefined ? {} : { label }) })
const separator: MenuEntry = MenuEntry.Separator()

/** The menus for a platform, with the sidebar shown or hidden. */
export const appMenu = (input: {
  readonly platform: string
  readonly sidebarHidden: boolean
}): ReadonlyArray<MenuEntry> => {
  const mac = input.platform === "darwin"
  // Cmd on macOS, Ctrl elsewhere; the sidebar's key adds Ctrl on macOS and Shift elsewhere, as Ctrl is taken.
  const mod = mac ? "Cmd" : "Ctrl"
  const sidebarKeys = mac ? "Ctrl+Cmd+S" : "Ctrl+Shift+S"
  const signIns = [
    command("Sign In with Claude…", "sign-in-claude"),
    command("Sign In with ChatGPT…", "sign-in-chatgpt"),
    command("Import Logins", "import"),
    command("Add an API Key…", "add-key"),
  ]
  const edit = MenuEntry.Menu({
    label: "Edit",
    items: [role("undo"), role("redo"), separator, role("cut"), role("copy"), role("paste"), role("selectAll")],
  })
  const view = MenuEntry.Menu({
    label: "View",
    items: [
      command(input.sidebarHidden ? "Show Sidebar" : "Hide Sidebar", "toggle-sidebar", sidebarKeys),
      separator,
      command("Refresh Usage", "refresh", `${mod}+R`),
    ],
  })
  if (mac) {
    return [
      MenuEntry.Menu({
        // The first menu is the application's own on macOS; About shows the app's name, icon and version.
        label: "slopmax",
        items: [
          role("about", "About slopmax"),
          separator,
          command("Settings…", "settings", "Cmd+,"),
          separator,
          role("services"),
          separator,
          role("hide", "Hide slopmax"),
          role("hideOthers", "Hide Others"),
          role("unhide", "Show All"),
          separator,
          role("quit", "Quit slopmax"),
        ],
      }),
      MenuEntry.Menu({
        label: "File",
        items: [
          command("Open slopmax", "open-window", "Cmd+O"),
          separator,
          ...signIns,
          separator,
          role("close", "Close Window"),
        ],
      }),
      edit,
      view,
      MenuEntry.Menu({ label: "Window", role: "windowMenu", items: [role("minimize"), role("zoom")] }),
    ]
  }
  return [
    MenuEntry.Menu({
      label: "File",
      items: [
        command("Open slopmax", "open-window", "Ctrl+O"),
        command("Settings…", "settings", "Ctrl+,"),
        separator,
        ...signIns,
        separator,
        role("close", "Close Window"),
        role("quit", "Quit slopmax"),
      ],
    }),
    edit,
    view,
    MenuEntry.Menu({ label: "Window", items: [role("minimize")] }),
  ]
}

/** The menus as Electron builds them, each command running `run`. */
export const menuTemplate = (
  entries: ReadonlyArray<MenuEntry>,
  run: (command: MenuCommand) => void,
): Array<MenuItemConstructorOptions> =>
  entries.map(
    MenuEntry.$match({
      Command: (entry): MenuItemConstructorOptions => ({
        label: entry.label,
        ...(entry.keys === undefined ? {} : { accelerator: entry.keys }),
        click: () => run(entry.command),
      }),
      Role: (entry): MenuItemConstructorOptions => ({
        role: entry.role,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      }),
      Separator: (): MenuItemConstructorOptions => ({ type: "separator" }),
      Menu: (entry): MenuItemConstructorOptions => ({
        label: entry.label,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        submenu: menuTemplate(entry.items, run),
      }),
    }),
  )

/** Where a command takes the window, when it opens a page. */
export const commandPage = (run: MenuCommand): string | undefined => {
  switch (run) {
    case "open-window":
      return "overview"
    case "settings":
      return "settings"
    case "sign-in-claude":
    case "sign-in-chatgpt":
    case "import":
    case "add-key":
      return "access"
    case "toggle-sidebar":
    case "refresh":
      return undefined
  }
}
