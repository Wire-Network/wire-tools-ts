import type {
  IPCEventContract,
  IPCInvokeChannel,
  IPCInvokeContract,
  IPCSendChannel,
  IPCSendContract
} from "./IPCContract.js"
import type { IPCEventChannel } from "./IPCEventChannel.js"

/** Removes a listener registration. */
export type Unsubscribe = () => void

/**
 * The typed preload bridge exposed to the isolated renderer as `window.wireQL` —
 * one generic facade per concept: invoke, send, events. The renderer has no Node;
 * every Node need goes through here.
 */
export interface QLBridge {
  /**
   * Request/response to main.
   *
   * @param channel - Invoke channel.
   * @param request - Typed request.
   * @returns Main's typed response.
   */
  invoke<C extends IPCInvokeChannel>(
    channel: C,
    request: IPCInvokeContract[C]["request"]
  ): Promise<IPCInvokeContract[C]["response"]>

  /**
   * Fire-and-forget to main.
   *
   * @param channel - Send channel.
   * @param payload - Typed payload.
   */
  send<C extends IPCSendChannel>(channel: C, payload: IPCSendContract[C]): void

  /**
   * Subscribe to a main → renderer event (payload only; the IPC event never leaks).
   *
   * @param channel - Event channel.
   * @param listener - Receives the typed payload.
   * @returns Unsubscribe.
   */
  on<E extends IPCEventChannel>(
    channel: E,
    listener: (payload: IPCEventContract[E]) => void
  ): Unsubscribe
}

/** Bridge constants. */
export namespace QLBridge {
  /** `window` property the preload exposes. */
  export const Key = "wireQL"
  /** `window.postMessage` tag carrying the query MessagePort into the main world. */
  export const QueryPortMessage = "wireQL:queryPort"
  /** `window.postMessage` target origin used by the preload (the main world of the same window). */
  export const QueryPortTargetOrigin = "*"
}
