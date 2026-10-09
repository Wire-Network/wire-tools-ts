import type { IpcMain } from "electron"

import { IPCChannel } from "../../../common/index.js"
import type { QueryHostLauncher } from "../../query/index.js"
import type { RendererTrust } from "../../security/index.js"

/** Renderer-initiated query-port lifecycle: port requests and the status-bar Restart. */
export namespace QueryPortHandlers {
  /**
   * Receive `requestQueryPort` / `restartQueryHost` sends from the app's renderer.
   *
   * @param ipcMain - Electron's ipcMain.
   * @param launcher - The query-host launcher.
   * @param trust - Which sender frames are the app's renderer.
   */
  export function register(ipcMain: IpcMain, launcher: QueryHostLauncher, trust: RendererTrust): void {
    trust.on(ipcMain, IPCChannel.requestQueryPort, event => launcher.portRequested(event.sender))
    trust.on(ipcMain, IPCChannel.restartQueryHost, () => launcher.restartRequested())
  }
}
