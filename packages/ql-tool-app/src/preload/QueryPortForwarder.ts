import type { IpcRenderer, IpcRendererEvent } from "electron"

import { IPCEventChannel, QLBridge } from "../common/index.js"

/** The main-world `postMessage` the forwarder calls (the preload's `window.postMessage`). */
export type MainWorldPostMessage = (message: string, targetOrigin: string, transfer: MessagePort[]) => void

/**
 * `contextBridge` cannot pass a MessagePort, so the query port arriving on
 * `IPCEventChannel.queryPort` is re-posted into the main world with
 * `window.postMessage(QLBridge.QueryPortMessage, "*", ports)` — the documented
 * Electron message-ports pattern.
 */
export namespace QueryPortForwarder {
  /**
   * Forward every query port.
   *
   * @param ipcRenderer - The preload's ipcRenderer.
   * @param postMessage - The window's postMessage.
   */
  export function install(ipcRenderer: IpcRenderer, postMessage: MainWorldPostMessage): void {
    ipcRenderer.on(IPCEventChannel.queryPort, (event: IpcRendererEvent) =>
      postMessage(QLBridge.QueryPortMessage, QLBridge.QueryPortTargetOrigin, event.ports)
    )
  }
}
