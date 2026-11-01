import { describe, expect, test } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import { appMenu, commandPage, type MenuCommand, type MenuEntry, menuTemplate } from "../src/main/menus.ts"

/** Each menu's items as `label [keys]` or the role's name, `—` for a separator. */
const outline = (entries: ReadonlyArray<MenuEntry>): Record<string, ReadonlyArray<string>> =>
  Object.fromEntries(
    entries.flatMap((entry) =>
      entry._tag === "Menu"
        ? [
            [
              entry.label,
              entry.items.map((item) => {
                switch (item._tag) {
                  case "Command":
                    return item.keys === undefined ? item.label : `${item.label} [${item.keys}]`
                  case "Role":
                    return item.label ?? item.role
                  case "Separator":
                    return "—"
                  case "Menu":
                    return item.label
                }
              }),
            ],
          ]
        : [],
    ),
  )

describe("the application menu", () => {
  test("on macOS: slopmax, File, Edit, View and Window, with Cmd keys", () => {
    expect(outline(appMenu({ platform: "darwin", sidebarHidden: false }))).toEqual({
      slopmax: [
        "About slopmax",
        "—",
        "Settings… [Cmd+,]",
        "—",
        "services",
        "—",
        "Hide slopmax",
        "Hide Others",
        "Show All",
        "—",
        "Quit slopmax",
      ],
      File: [
        "Open slopmax [Cmd+O]",
        "—",
        "Sign In with Claude…",
        "Sign In with ChatGPT…",
        "Import Logins",
        "Add an API Key…",
        "—",
        "Close Window",
      ],
      Edit: ["undo", "redo", "—", "cut", "copy", "paste", "selectAll"],
      View: ["Hide Sidebar [Ctrl+Cmd+S]", "—", "Refresh Usage [Cmd+R]"],
      Window: ["minimize", "zoom"],
    })
  })

  test("elsewhere: the same commands in File, with Ctrl keys", () => {
    const menus = outline(appMenu({ platform: "linux", sidebarHidden: false }))
    expect(Object.keys(menus)).toEqual(["File", "Edit", "View", "Window"])
    expect(menus["File"]).toContain("Open slopmax [Ctrl+O]")
    expect(menus["File"]).toContain("Settings… [Ctrl+,]")
    expect(menus["File"]).toContain("Quit slopmax")
    expect(menus["View"]).toEqual(["Hide Sidebar [Ctrl+Shift+S]", "—", "Refresh Usage [Ctrl+R]"])
  })

  test("says Show Sidebar while the sidebar is hidden", () => {
    expect(outline(appMenu({ platform: "darwin", sidebarHidden: true }))["View"]?.[0]).toBe("Show Sidebar [Ctrl+Cmd+S]")
  })

  test("its commands run as clicked, and roles are left to the system", () => {
    const ran: Array<MenuCommand> = []
    const template = menuTemplate(appMenu({ platform: "darwin", sidebarHidden: false }), (command) => ran.push(command))
    const clickAll = (items: ReadonlyArray<MenuItemConstructorOptions>): void => {
      for (const item of items) {
        if (item.click !== undefined) Reflect.apply(item.click, undefined, [])
        if (Array.isArray(item.submenu)) clickAll(item.submenu)
      }
    }
    clickAll(template)
    expect(ran).toEqual([
      "settings",
      "open-window",
      "sign-in-claude",
      "sign-in-chatgpt",
      "import",
      "add-key",
      "toggle-sidebar",
      "refresh",
    ])
    expect(template[0]?.submenu).toContainEqual({ role: "quit", label: "Quit slopmax" })
  })

  test("signing in, importing and adding a key open the window at Access", () => {
    expect(commandPage("sign-in-claude")).toBe("access")
    expect(commandPage("import")).toBe("access")
    expect(commandPage("add-key")).toBe("access")
    expect(commandPage("settings")).toBe("settings")
    expect(commandPage("open-window")).toBe("overview")
    expect(commandPage("refresh")).toBeUndefined()
    expect(commandPage("toggle-sidebar")).toBeUndefined()
  })
})
