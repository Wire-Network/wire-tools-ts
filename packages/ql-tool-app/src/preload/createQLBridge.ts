import type { IpcRenderer, IpcRendererEvent } from "electron"
import { NestedError } from "@wireio/shared"

import {
  IPCContract,
  type IPCEventChannel,
  type IPCEventContract,
  type IPCInvokeChannel,
  type IPCInvokeContract,
  type IPCSendChannel,
  type IPCSendContract,
  type QLBridge,
  type Unsubscribe
} from "../common/index.js"

/**
 * Assert a channel belongs to the expected partition (the bridge is the only
 * route out of the isolated world — anything outside the enums is refused).
 *
 * @param channel - The requested channel.
 * @param allowed - Membership test.
 * @param partition - For the error.
 */
function assertChannel(channel: string, allowed: (name: string) => boolean, partition: string): void {
  if (!allowed(channel)) {
    throw new NestedError(`channel ${channel} is not a ${partition} channel`, { context: { channel, partition } })
  }
}

/**
 * Build the typed bridge over `ipcRenderer`. Channel allow-lists derive from the
 * enums (no literals); listeners receive the payload only — the
 * `IpcRendererEvent` never reaches the main world.
 *
 * @param ipcRenderer - The sandboxed preload's ipcRenderer.
 * @returns The bridge exposed as `window.wireQL`.
 */
export function createQLBridge(ipcRenderer: IpcRenderer): QLBridge {
  return {
    invoke<C extends IPCInvokeChannel>(
      channel: C,
      request: IPCInvokeContract[C]["request"]
    ): Promise<IPCInvokeContract[C]["response"]> {
      assertChannel(channel, IPCContract.isInvokeChannel, "invoke")
      return ipcRenderer.invoke(channel, request)
    },
    send<C extends IPCSendChannel>(channel: C, payload: IPCSendContract[C]): void {
      assertChannel(channel, IPCContract.isSendChannel, "send")
      ipcRenderer.send(channel, payload)
    },
    on<E extends IPCEventChannel>(channel: E, listener: (payload: IPCEventContract[E]) => void): Unsubscribe {
      assertChannel(channel, IPCContract.isEventChannel, "event")
      const forward = (_event: IpcRendererEvent, payload: IPCEventContract[E]) => listener(payload)
      ipcRenderer.on(channel, forward)
      return () => {
        ipcRenderer.removeListener(channel, forward)
      }
    }
  }
}
