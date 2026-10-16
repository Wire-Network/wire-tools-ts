import type { IpcMain, WebContents } from "electron"
import { getLogger, NestedError } from "@wireio/shared"

import { IPCContract, type IPCInvokeChannel, type IPCInvokeContract } from "../../common/index.js"
import type { RendererTrust } from "../security/index.js"

const log = getLogger(__filename)

/** One invoke handler; `sender` is the calling window (dialogs and menus need their owner). */
export type IPCHandler<C extends IPCInvokeChannel> = (
  request: IPCInvokeContract[C]["request"],
  sender: WebContents
) => Promise<IPCInvokeContract[C]["response"]>

/** Main-side handler map (one handler per invoke channel). */
export type IPCHandlers = { [C in IPCInvokeChannel]: IPCHandler<C> }

/**
 * Register every invoke handler on Electron's ipcMain (one loop over the
 * contract's invoke channels). An invoke whose sender frame is not the app's
 * renderer is refused before its handler runs; a rejected handler is logged
 * with its error and rethrown, so the renderer's `invoke` rejects with it.
 *
 * @param ipcMain - Electron's ipcMain.
 * @param handlers - One handler per invoke channel.
 * @param trust - Which sender frames are the app's renderer.
 */
export function registerIPCHandlers(ipcMain: IpcMain, handlers: IPCHandlers, trust: RendererTrust): void {
  IPCContract.InvokeChannels.forEach(channel => {
    const handler = handlers[channel] as IPCHandler<IPCInvokeChannel>
    ipcMain.handle(channel, async (event, request) => {
      try {
        trust.assertSender(event, channel)
        return await handler(request, event.sender)
      } catch (error) {
        log.error(`${channel} failed: ${NestedError.toError(error).message}`, error)
        throw error
      }
    })
  })
}
