import type { IpcMain } from "electron"
import { getLogger, LevelThresholds, type Appender, type LevelKind, type LogRecord } from "@wireio/shared"

import { IPCChannel, LogRecordPayloadSchema } from "../../../common/index.js"
import type { RendererTrust } from "../../security/index.js"

const log = getLogger(__filename)

/**
 * Writes forwarded renderer/preload records (each keeps its sender's category).
 * Those processes forward every record (they cannot read `LOG_LEVEL`), so the
 * level main's file logging runs at is applied here.
 */
export namespace LogHandlers {
  /**
   * Validate one forwarded payload and append it when it is at or above `level`.
   *
   * @param appender - The renderer log sink.
   * @param payload - The untrusted payload.
   * @param level - The lowest level written.
   * @returns Whether it was valid and written.
   */
  export function appendPayload(appender: Appender, payload: unknown, level: LevelKind): boolean {
    const parsed = LogRecordPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      log.warn(`rejected malformed renderer log payload: ${parsed.error.message}`)
      return false
    }
    if (LevelThresholds[parsed.data.level] < LevelThresholds[level]) return false
    appender.append(parsed.data satisfies LogRecord)
    return true
  }

  /**
   * Receive `IPCChannel.log` sends from the app's renderer.
   *
   * @param ipcMain - Electron's ipcMain.
   * @param appender - The renderer log sink.
   * @param level - The lowest level written (main's `LOG_LEVEL`).
   * @param trust - Which sender frames are the app's renderer.
   */
  export function register(ipcMain: IpcMain, appender: Appender, level: LevelKind, trust: RendererTrust): void {
    trust.on(ipcMain, IPCChannel.log, (_event, payload) => appendPayload(appender, payload, level))
  }
}
