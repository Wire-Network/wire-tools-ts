import type { BrowserWindow as ElectronBrowserWindow, MenuItemConstructorOptions } from "electron"

import { AppAction } from "@wireio/ql-tool-app/common"
import { ContextMenu } from "@wireio/ql-tool-app/main/menu"

import { BrowserWindow, Menu, type FakeMenu } from "../../__mocks__/electron.js"

/** The context-menu request used throughout. */
const request = {
  items: [
    { action: AppAction.copyRow, label: "Copy Row", enabled: true },
    { action: AppAction.inspectValue, label: "Inspect Value", enabled: false }
  ]
}

/** The menu the last popup built. */
function lastMenu(): FakeMenu {
  return Menu.buildFromTemplate.mock.results.at(-1).value
}

describe("ContextMenu.popup", () => {
  const window = new BrowserWindow() as unknown as ElectronBrowserWindow

  it("builds one item per request item (label + enabled) and resolves the clicked action", async () => {
    const pending = ContextMenu.popup(window, request),
      menu = lastMenu(),
      items = menu.template as MenuItemConstructorOptions[]
    expect(items.map(({ label, enabled }) => ({ label, enabled }))).toEqual([
      { label: "Copy Row", enabled: true },
      { label: "Inspect Value", enabled: false }
    ])
    items[0].click(null, null, null)
    menu.popup.mock.calls[0][0].callback()
    await expect(pending).resolves.toBe(AppAction.copyRow)
  })

  it("dismissed → AppAction.none", async () => {
    const pending = ContextMenu.popup(window, request)
    lastMenu().popup.mock.calls[0][0].callback()
    await expect(pending).resolves.toBe(AppAction.none)
  })
})
