/**
 * @jest-environment jsdom
 */
import { screen, waitFor } from "@testing-library/react"

import { QLBridge } from "@wireio/ql-tool-app/common"

import { FakeWorkbench } from "../common/FakeWorkbench.js"

describe("renderer entry", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[QLBridge.Key]
    document.body.innerHTML = ""
  })

  it("without the preload bridge it fails with a clear startup error", () => {
    jest.isolateModules(() => {
      expect(() => require("@wireio/ql-tool-app/renderer/index")).toThrow(`window.${QLBridge.Key} is missing`)
    })
  })

  it("mounts the workbench into #root over the bridge", async () => {
    const { bridge } = FakeWorkbench.create()
    Object.assign(window, { [QLBridge.Key]: bridge })
    document.body.innerHTML = '<div id="root"></div>'
    jest.isolateModules(() => {
      require("@wireio/ql-tool-app/renderer/index")
    })
    await waitFor(() => expect(screen.getByTestId("status-bar")).toBeInTheDocument())
  })
})
