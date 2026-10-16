import { BridgeLogAppender, IPCChannel, type QLBridge } from "../../common/index.js"

/** Renderer logging: every record goes through the bridge to main, which applies `LOG_LEVEL` and writes renderer.log. */
export namespace RendererLogging {
  /**
   * Install the bridge appender (before the first log write).
   *
   * @param bridge - The preload bridge.
   * @returns The installed appender.
   */
  export function install(bridge: QLBridge): BridgeLogAppender {
    return BridgeLogAppender.install(payload => bridge.send(IPCChannel.log, payload))
  }
}
