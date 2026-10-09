import type { BrowserWindow as ElectronBrowserWindow } from "electron"

import { DialogOutcome } from "@wireio/ql-tool-app/common"
import { NativeDialogs } from "@wireio/ql-tool-app/main/dialogs"

import { BrowserWindow, dialog } from "../../__mocks__/electron.js"

const window = new BrowserWindow() as unknown as ElectronBrowserWindow

describe("NativeDialogs", () => {
  it("open → the first chosen file, with the extension filter", async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/a.sql", "/b.sql"] })
    await expect(NativeDialogs.showOpen(window, { title: "Open", extensions: ["sql"] })).resolves.toEqual({
      outcome: DialogOutcome.selected,
      filePath: "/a.sql"
    })
    expect(dialog.showOpenDialog.mock.calls.at(-1)[1].filters).toEqual([
      { name: NativeDialogs.FilterName, extensions: ["sql"] }
    ])
  })

  it("save → the chosen path with the suggested default", async () => {
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "/out.csv" })
    await expect(
      NativeDialogs.showSave(window, { title: "Export", defaultName: "results.csv", extensions: ["csv"] })
    ).resolves.toEqual({ outcome: DialogOutcome.selected, filePath: "/out.csv" })
    expect(dialog.showSaveDialog.mock.calls.at(-1)[1].defaultPath).toBe("results.csv")
  })

  it("a cancelled dialog carries no filePath key", async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "" })
    const opened = await NativeDialogs.showOpen(window, { title: "Open", extensions: ["sql"] }),
      saved = await NativeDialogs.showSave(window, { title: "Save", defaultName: "q.sql", extensions: ["sql"] })
    expect(opened).toEqual({ outcome: DialogOutcome.cancelled })
    expect(saved).toEqual({ outcome: DialogOutcome.cancelled })
    expect("filePath" in saved).toBe(false)
  })
})
