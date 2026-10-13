import { NestedError } from "@wireio/shared"

import {
  IPCChannel,
  IPCEventChannel,
  QLBridge,
  type Unsubscribe
} from "../../common/index.js"
import { QueryPortEventType, type QueryPortConnector } from "../query/index.js"

/** The window property the preload exposes the bridge under. */
interface BridgeWindow extends Window {
  /** `window.wireQL`. */
  [QLBridge.Key]?: QLBridge
}

/** Typed access to `window.wireQL` plus the query-port receiver. */
export namespace BridgeClient {
  /**
   * The exposed bridge.
   *
   * @returns `window.wireQL`.
   * @throws NestedError when the preload did not expose it (the app cannot work without it).
   */
  export function bridge(): QLBridge {
    const exposed = (window as BridgeWindow)[QLBridge.Key]
    if (exposed == null) {
      throw new NestedError(`window.${QLBridge.Key} is missing — the preload did not run`, {
        context: { key: QLBridge.Key }
      })
    }
    return exposed
  }

  /**
   * Receive each new query port the preload forwards with `window.postMessage`
   * (only messages from this window carrying {@link QLBridge.QueryPortMessage}).
   * Register BEFORE {@link requestQueryPort}.
   *
   * @param listener - Receives the port.
   * @returns Unsubscribe.
   */
  export function onQueryPort(listener: (port: MessagePort) => void): Unsubscribe {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data !== QLBridge.QueryPortMessage) return
      const [port] = event.ports
      if (port != null) listener(port)
    }
    window.addEventListener(QueryPortEventType.message, receive)
    return () => window.removeEventListener(QueryPortEventType.message, receive)
  }

  /** Ask main for a new query port. */
  export function requestQueryPort(): void {
    bridge().send(IPCChannel.requestQueryPort, undefined)
  }

  /**
   * The {@link QueryPortConnector} over the bridge.
   *
   * @returns The connector.
   */
  export function createQueryPortConnector(): QueryPortConnector {
    return {
      onQueryPort,
      requestQueryPort,
      restartQueryHost: () => bridge().send(IPCChannel.restartQueryHost, undefined),
      onQueryHostExited: listener => bridge().on(IPCEventChannel.queryHostExited, listener),
      onQueryHostFailed: listener => bridge().on(IPCEventChannel.queryHostFailed, listener)
    }
  }
}
