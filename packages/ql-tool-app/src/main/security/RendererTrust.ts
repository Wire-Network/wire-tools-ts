import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { getLogger, NestedError } from "@wireio/shared"

import type { IPCSendChannel, IPCSendContract } from "../../common/index.js"

const log = getLogger(__filename)

/** A `send` listener of one channel, after the sender passed the trust check. */
export type TrustedSendListener<C extends IPCSendChannel> = (event: IpcMainEvent, payload: IPCSendContract[C]) => void

/**
 * Which pages main trusts: only the app's own renderer page. A URL is trusted
 * when it has the renderer URL's origin — for a `file://` renderer (no real
 * origin) the same file. Every IPC handler checks its event's `senderFrame`
 * against it, and windows may navigate only within it (Electron's security
 * checklist; main trusts what its own renderer sends, including file paths).
 */
export class RendererTrust {
  /**
   * @param rendererURL - The renderer page URL main loads (`AppPaths.rendererURL`).
   */
  constructor(readonly rendererURL: string) {}

  /**
   * Whether `url` belongs to the app's renderer.
   *
   * @param url - A frame or navigation URL.
   * @returns True for the renderer's origin (or its file).
   */
  isTrusted(url: string): boolean {
    const candidate = RendererTrust.parse(url),
      renderer = RendererTrust.parse(this.rendererURL)
    if (candidate == null || renderer == null) return false
    return renderer.protocol === RendererTrust.FileProtocol
      ? candidate.protocol === RendererTrust.FileProtocol && candidate.pathname === renderer.pathname
      : candidate.origin === renderer.origin
  }

  /**
   * Whether an IPC event came from the app's renderer (a destroyed or
   * navigated-away frame is not trusted).
   *
   * @param event - The IPC event.
   * @returns True for a trusted sender frame.
   */
  isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url
    return url != null && this.isTrusted(url)
  }

  /**
   * Refuse an invoke from anything but the app's renderer.
   *
   * @param event - The invoke event.
   * @param channel - For the error.
   * @throws NestedError naming the untrusted sender.
   */
  assertSender(event: IpcMainInvokeEvent, channel: string): void {
    if (!this.isTrustedSender(event)) {
      throw new NestedError(`refused ${channel} from an untrusted sender`, {
        context: { channel, senderURL: event.senderFrame?.url ?? null }
      })
    }
  }

  /**
   * `ipcMain.on(channel, …)` that drops (and logs) sends from untrusted senders.
   *
   * @param ipcMain - Electron's ipcMain.
   * @param channel - The send channel.
   * @param listener - Runs for trusted senders only.
   */
  on<C extends IPCSendChannel>(ipcMain: IpcMain, channel: C, listener: TrustedSendListener<C>): void {
    ipcMain.on(channel, (event, payload: IPCSendContract[C]) => {
      if (!this.isTrustedSender(event)) {
        log.warn(`dropped ${channel} from an untrusted sender ${event.senderFrame?.url ?? "(no frame)"}`)
        return
      }
      listener(event, payload)
    })
  }
}

/** Trust constants + helpers. */
export namespace RendererTrust {
  /** The `file:` URL protocol (packaged renderer pages). */
  export const FileProtocol = "file:"

  /**
   * Parse a URL.
   *
   * @param url - The text.
   * @returns The URL, or null when it does not parse.
   */
  export function parse(url: string): URL {
    return URL.canParse(url) ? new URL(url) : null
  }
}
