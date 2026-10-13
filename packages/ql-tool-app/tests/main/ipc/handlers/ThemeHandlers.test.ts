import { ThemeSource } from "@wireio/ql-tool-app/common"
import { createThemeHandlers } from "@wireio/ql-tool-app/main/ipc"
import type { NativeThemeController } from "@wireio/ql-tool-app/main/theme"

import { FakeWebContents } from "../../../__mocks__/electron.js"

describe("createThemeHandlers", () => {
  it("applies the source, then notifies", async () => {
    const order: string[] = [],
      theme = { set: jest.fn(() => order.push("set")) } as unknown as NativeThemeController,
      handlers = createThemeHandlers(theme, () => order.push("changed"))
    await handlers.setThemeSource({ source: ThemeSource.dark }, new FakeWebContents() as unknown as Electron.WebContents)
    expect(theme.set).toHaveBeenCalledWith(ThemeSource.dark)
    expect(order).toEqual(["set", "changed"])
  })

  it("a failing set does not notify", async () => {
    const onChanged = jest.fn(),
      theme = {
        set: jest.fn(() => {
          throw new Error("unwritable")
        })
      } as unknown as NativeThemeController
    await expect(
      createThemeHandlers(theme, onChanged).setThemeSource(
        { source: ThemeSource.light },
        new FakeWebContents() as unknown as Electron.WebContents
      )
    ).rejects.toThrow("unwritable")
    expect(onChanged).not.toHaveBeenCalled()
  })
})
