import type { MenuItemConstructorOptions } from "electron"

import { AppAction, ThemeSource } from "@wireio/ql-tool-app/common"
import { ApplicationMenu } from "@wireio/ql-tool-app/main/menu"

import { Menu } from "../../__mocks__/electron.js"

/**
 * Flatten a template.
 *
 * @param items - Template items.
 * @returns Every item at every depth.
 */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap(item => [item, ...flatten((item.submenu as MenuItemConstructorOptions[]) ?? [])])
}

describe("ApplicationMenu", () => {
  it("macOS gets the app menu and no File → Quit", () => {
    const items = ApplicationMenu.template({ platform: "darwin", themeSource: ThemeSource.system, dispatch: jest.fn() })
    expect(items[0].role).toBe("appMenu")
    expect(flatten(items).some(item => item.role === "quit")).toBe(false)
  })

  it("other platforms keep Quit in File and have no app menu", () => {
    const items = ApplicationMenu.template({ platform: "linux", themeSource: ThemeSource.system, dispatch: jest.fn() })
    expect(items[0].label).toBe("File")
    expect(flatten(items).some(item => item.role === "quit")).toBe(true)
  })

  it("checks the active appearance and dispatches clicks", () => {
    const dispatch = jest.fn(),
      items = flatten(ApplicationMenu.template({ platform: "linux", themeSource: ThemeSource.dark, dispatch })),
      radios = items.filter(item => item.type === "radio")
    expect(radios.map(item => [item.label, item.checked])).toEqual([
      ["System", false],
      ["Light", false],
      ["Dark", true]
    ])
    const run = items.find(item => item.label === "Run")
    expect(run.accelerator).toBe("CmdOrCtrl+Enter")
    run.click(null, null, null)
    expect(dispatch).toHaveBeenCalledWith(AppAction.run)
  })

  it("install sets the built menu as the application menu", () => {
    const menu = ApplicationMenu.install({ platform: "linux", themeSource: ThemeSource.light, dispatch: jest.fn() })
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(menu)
  })
})
