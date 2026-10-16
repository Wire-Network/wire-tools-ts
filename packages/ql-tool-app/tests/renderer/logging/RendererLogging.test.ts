import { getLogger, getLoggingManager, Level } from "@wireio/shared"

import { BridgeLogAppender, IPCChannel, type QLBridge } from "@wireio/ql-tool-app/common"
import { RendererLogging } from "@wireio/ql-tool-app/renderer/logging"

describe("RendererLogging", () => {
  it("routes renderer records through bridge.send(log) with the sender's category", () => {
    const bridge = { send: jest.fn(), invoke: jest.fn(), on: jest.fn() } as unknown as QLBridge
    RendererLogging.install(bridge)
    getLogger("renderer:App").warn("panel crashed")
    expect(bridge.send).toHaveBeenCalledWith(
      IPCChannel.log,
      expect.objectContaining({ category: "renderer:App", message: "panel crashed" })
    )
  })

  it("forwards every level — main applies LOG_LEVEL to forwarded records", () => {
    const bridge = { send: jest.fn(), invoke: jest.fn(), on: jest.fn() } as unknown as QLBridge,
      appender = RendererLogging.install(bridge)
    getLogger("renderer:Quiet").trace("noise")
    expect(bridge.send).toHaveBeenCalledWith(IPCChannel.log, expect.objectContaining({ level: Level.trace, message: "noise" }))
    expect(getLoggingManager().appenders).toEqual([appender])
    expect(getLoggingManager().rootLevel).toBe(BridgeLogAppender.ForwardingLevel)
  })
})
