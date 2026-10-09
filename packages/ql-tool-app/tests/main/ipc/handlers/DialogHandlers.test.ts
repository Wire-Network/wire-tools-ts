import { DialogOutcome } from "@wireio/ql-tool-app/common"
import { assertOwnerWindow, createDialogHandlers } from "@wireio/ql-tool-app/main/ipc"

import { BrowserWindow, dialog, FakeWebContents } from "../../../__mocks__/electron.js"

describe("createDialogHandlers", () => {
  it("shows the open dialog owned by the calling window", async () => {
    const window = new BrowserWindow()
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/q.sql"] })
    await expect(
      createDialogHandlers().showOpenDialog(
        { title: "Open", extensions: ["sql"] },
        window.webContents as unknown as Electron.WebContents
      )
    ).resolves.toEqual({ outcome: DialogOutcome.selected, filePath: "/q.sql" })
    expect(dialog.showOpenDialog.mock.calls[0][0]).toBe(window)
  })

  it("a sender without a window is rejected", () => {
    const orphan = new FakeWebContents() as unknown as Electron.WebContents
    expect(() => assertOwnerWindow(orphan)).toThrow("the calling webContents has no window")
  })
})
