/**
 * @jest-environment jsdom
 */
import { getLogger } from "@wireio/shared"

import { IPCChannel, IPCEventChannel, QLBridge } from "@wireio/ql-tool-app/common"

import { contextBridge, ipcRenderer } from "../__mocks__/electron.js"

describe("preload", () => {
  beforeAll(() => {
    // The preload is a side-effect entry (no exports): loading it installs the bridge.
    require("@wireio/ql-tool-app/preload/preload")
  })

  it("exposes exactly the bridge key in the main world", () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [key, bridge] = contextBridge.exposeInMainWorld.mock.calls[0]
    expect(key).toBe(QLBridge.Key)
    expect(Object.keys(bridge).sort()).toEqual(["invoke", "on", "send"])
  })

  it("forwards preload logs (every level) over the log send channel with their own category", () => {
    ipcRenderer.send.mockClear()
    getLogger("preload:probe").warn("probe line")
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      IPCChannel.log,
      expect.objectContaining({ category: "preload:probe", message: "probe line" })
    )
    getLogger("preload:probe").trace("trace line")
    expect(ipcRenderer.send).toHaveBeenCalledWith(IPCChannel.log, expect.objectContaining({ message: "trace line" }))
  })

  it("posts arriving query ports to the window", () => {
    const received: MessageEvent[] = [],
      listener = (event: MessageEvent) => received.push(event)
    window.addEventListener("message", listener)
    const postMessage = jest.spyOn(window, "postMessage").mockImplementation(() => undefined)
    ipcRenderer.emit(IPCEventChannel.queryPort, { ports: [] })
    expect(postMessage).toHaveBeenCalledWith(QLBridge.QueryPortMessage, QLBridge.QueryPortTargetOrigin, [])
    postMessage.mockRestore()
    window.removeEventListener("message", listener)
  })
})
