/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

import { IPCChannel, IPCEventChannel, QLBridge } from "@wireio/ql-tool-app/common"
import { App } from "@wireio/ql-tool-app/renderer/App"
import { FakeQueryPort } from "../common/FakeQueryPort.js"
import { FakeWorkbench } from "../common/FakeWorkbench.js"

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[QLBridge.Key]
})

describe("App", () => {
  it("mounts the workbench, starts the port, subscribes menus and loads the stores", async () => {
    const workbench = FakeWorkbench.create(),
      port = FakeQueryPort.create()
    Object.assign(window, { [QLBridge.Key]: workbench.bridge })
    Object.assign(workbench.bridge.answers, {
      [IPCChannel.profilesList]: FakeWorkbench.profilesOf("local"),
      [IPCChannel.historyList]: [],
      [IPCChannel.savedList]: []
    })
    const { unmount } = render(<App store={workbench.store} bridge={workbench.bridge} queryPort={FakeQueryPort.asClient(port)} />)
    expect(screen.getByTestId("status-bar")).toBeInTheDocument()
    expect(port.start).toHaveBeenCalled()
    expect(workbench.bridge.on.mock.calls.map(([channel]) => channel)).toEqual([
      IPCEventChannel.menuAction,
      IPCEventChannel.storeChanged
    ])
    await waitFor(() => expect(workbench.store.getState().connections.activeProfileName).toBe("local"))
    expect(workbench.bridge.invoke.mock.calls.map(([channel]) => channel)).toEqual(
      expect.arrayContaining([IPCChannel.profilesList, IPCChannel.historyList, IPCChannel.savedList])
    )
    unmount()
    expect(port.stop).toHaveBeenCalled()
  })
})
