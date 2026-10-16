import type { IpcRenderer } from "electron"

import { IPCEventChannel, QLBridge } from "@wireio/ql-tool-app/common"
import { QueryPortForwarder } from "@wireio/ql-tool-app/preload"

import { ipcRenderer } from "../__mocks__/electron.js"

beforeEach(() => ipcRenderer.removeAllListeners())

describe("QueryPortForwarder", () => {
  it("re-posts each query port into the main world with the bridge tag", () => {
    const postMessage = jest.fn(),
      ports = [{ id: "port2" }]
    QueryPortForwarder.install(ipcRenderer as unknown as IpcRenderer, postMessage)
    ipcRenderer.emit(IPCEventChannel.queryPort, { ports })
    expect(postMessage).toHaveBeenCalledWith(QLBridge.QueryPortMessage, QLBridge.QueryPortTargetOrigin, ports)
  })

  it("ignores other event channels", () => {
    const postMessage = jest.fn()
    QueryPortForwarder.install(ipcRenderer as unknown as IpcRenderer, postMessage)
    ipcRenderer.emit(IPCEventChannel.queryHostExited, { ports: [] })
    expect(postMessage).not.toHaveBeenCalled()
  })
})
