import { contextBridge, ipcRenderer } from "electron"
import { getLogger } from "@wireio/shared"

import { BridgeLogAppender, IPCChannel, QLBridge } from "../common/index.js"
import { createQLBridge } from "./createQLBridge.js"
import { QueryPortForwarder } from "./QueryPortForwarder.js"

BridgeLogAppender.install(payload => ipcRenderer.send(IPCChannel.log, payload))

const log = getLogger(__filename)

contextBridge.exposeInMainWorld(QLBridge.Key, createQLBridge(ipcRenderer))
QueryPortForwarder.install(ipcRenderer, (message, targetOrigin, transfer) =>
  window.postMessage(message, targetOrigin, transfer)
)
log.info(`preload exposed window.${QLBridge.Key}`)
