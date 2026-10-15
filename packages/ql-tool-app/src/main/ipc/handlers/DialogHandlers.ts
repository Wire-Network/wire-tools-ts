import { BrowserWindow, type WebContents } from "electron"
import { NestedError } from "@wireio/shared"

import type { IPCChannel } from "../../../common/index.js"
import { NativeDialogs } from "../../dialogs/index.js"
import type { IPCHandlers } from "../registerIPCHandlers.js"

/** The native-dialog invoke channels. */
export type DialogHandlerMap = Pick<IPCHandlers, IPCChannel.showOpenDialog | IPCChannel.showSaveDialog>

/**
 * The window owning `sender`.
 *
 * @param sender - The calling webContents.
 * @returns Its window.
 * @throws NestedError when the sender has no window.
 */
export function assertOwnerWindow(sender: WebContents): BrowserWindow {
  const window = BrowserWindow.fromWebContents(sender)
  if (window == null) {
    throw new NestedError("the calling webContents has no window", { context: { webContentsId: sender.id } })
  }
  return window
}

/**
 * Handlers showing native open/save dialogs owned by the calling window.
 *
 * @returns The handlers.
 */
export function createDialogHandlers(): DialogHandlerMap {
  return {
    showOpenDialog: (request, sender) => NativeDialogs.showOpen(assertOwnerWindow(sender), request),
    showSaveDialog: (request, sender) => NativeDialogs.showSave(assertOwnerWindow(sender), request)
  }
}
