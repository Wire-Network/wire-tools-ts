import type { MenuItemConstructorOptions } from "electron"

import { AppAction } from "@wireio/ql-tool-app/common"
import { createContextMenuHandlers } from "@wireio/ql-tool-app/main/ipc"

import { BrowserWindow, Menu, type FakeMenu } from "../../../__mocks__/electron.js"

describe("createContextMenuHandlers", () => {
  it("pops the menu over the calling window and resolves the clicked action", async () => {
    const window = new BrowserWindow(),
      pending = createContextMenuHandlers().showContextMenu(
        { items: [{ action: AppAction.copyCell, label: "Copy Cell", enabled: true }] },
        window.webContents as unknown as Electron.WebContents
      ),
      menu: FakeMenu = Menu.buildFromTemplate.mock.results.at(-1).value,
      [item] = menu.template as MenuItemConstructorOptions[]
    item.click(null, null, null)
    await expect(pending).resolves.toBe(AppAction.copyCell)
    expect(menu.popup.mock.calls[0][0].window).toBe(window)
  })
})
