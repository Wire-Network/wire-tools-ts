import type { IPCChannel } from "../../../common/index.js"
import { ContextMenu } from "../../menu/index.js"
import type { IPCHandlers } from "../registerIPCHandlers.js"
import { assertOwnerWindow } from "./DialogHandlers.js"

/** The context-menu invoke channel. */
export type ContextMenuHandlerMap = Pick<IPCHandlers, IPCChannel.showContextMenu>

/**
 * Handler popping a native context menu over the calling window.
 *
 * @returns The handler.
 */
export function createContextMenuHandlers(): ContextMenuHandlerMap {
  return {
    showContextMenu: (request, sender) => ContextMenu.popup(assertOwnerWindow(sender), request)
  }
}
