import type { IPCChannel } from "../../../common/index.js"
import { ExportService } from "../../services/index.js"
import type { IPCHandlers } from "../registerIPCHandlers.js"

/** The file-writing invoke channels. */
export type ExportHandlerMap = Pick<
  IPCHandlers,
  IPCChannel.exportWrite | IPCChannel.readQueryFile | IPCChannel.writeQueryFile
>

/**
 * Handlers that read/write files chosen through native dialogs.
 *
 * @returns The handlers.
 */
export function createExportHandlers(): ExportHandlerMap {
  return {
    exportWrite: request => ExportService.write(request),
    readQueryFile: request => ExportService.readQueryFile(request),
    writeQueryFile: request => ExportService.writeQueryFile(request)
  }
}
