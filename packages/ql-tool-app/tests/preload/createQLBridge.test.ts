import type { IpcRenderer } from "electron"

import { AppAction, IPCChannel, IPCEventChannel, type IPCInvokeChannel } from "@wireio/ql-tool-app/common"
import { createQLBridge } from "@wireio/ql-tool-app/preload"

import { ipcRenderer } from "../__mocks__/electron.js"

const fakeIpcRenderer = ipcRenderer as unknown as IpcRenderer

beforeEach(() => {
  ipcRenderer.removeAllListeners()
  ipcRenderer.invoke.mockClear()
  ipcRenderer.send.mockClear()
})

describe("createQLBridge", () => {
  it("invoke routes to ipcRenderer.invoke on the channel", async () => {
    const bridge = createQLBridge(fakeIpcRenderer),
      request = { limit: 10, search: "" }
    await bridge.invoke(IPCChannel.historyList, request)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(IPCChannel.historyList, request)
  })

  it("send routes to ipcRenderer.send", () => {
    createQLBridge(fakeIpcRenderer).send(IPCChannel.requestQueryPort, undefined)
    expect(ipcRenderer.send).toHaveBeenCalledWith(IPCChannel.requestQueryPort, undefined)
  })

  it("on delivers the payload only (the IpcRendererEvent never leaks)", () => {
    const received: unknown[][] = [],
      bridge = createQLBridge(fakeIpcRenderer)
    bridge.on(IPCEventChannel.menuAction, (...args: unknown[]) => received.push(args))
    ipcRenderer.emit(IPCEventChannel.menuAction, { sender: "event" }, AppAction.run)
    expect(received).toEqual([[AppAction.run]])
  })

  it("unsubscribe removes the listener", () => {
    const listener = jest.fn(),
      unsubscribe = createQLBridge(fakeIpcRenderer).on(IPCEventChannel.storeChanged, listener)
    unsubscribe()
    ipcRenderer.emit(IPCEventChannel.storeChanged, {}, "profiles")
    expect(listener).not.toHaveBeenCalled()
    expect(ipcRenderer.listenerCount(IPCEventChannel.storeChanged)).toBe(0)
  })

  it("rejects a channel outside its partition", () => {
    const bridge = createQLBridge(fakeIpcRenderer)
    expect(() => bridge.invoke(IPCChannel.log as unknown as IPCInvokeChannel, undefined)).toThrow(
      "channel log is not a invoke channel"
    )
    expect(() => bridge.send("profilesList" as unknown as IPCChannel.log, undefined)).toThrow(/not a send channel/)
    expect(() => bridge.on("nope" as unknown as IPCEventChannel, jest.fn())).toThrow(/not a event channel/)
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(ipcRenderer.send).not.toHaveBeenCalled()
  })
})
