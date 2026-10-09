/**
 * @jest-environment jsdom
 */
import { IPCChannel, IPCEventChannel, QLBridge } from "@wireio/ql-tool-app/common"
import { BridgeClient } from "@wireio/ql-tool-app/renderer/ipc"

import { FakeWorkbench, type FakeBridge } from "../../common/FakeWorkbench.js"

/** A fake bridge installed on window. */
function installBridge(): FakeBridge {
  const { bridge } = FakeWorkbench.create()
  Object.assign(window, { [QLBridge.Key]: bridge })
  return bridge
}

/**
 * Dispatch a window message event.
 *
 * @param data - Message data.
 * @param source - Event source.
 * @param ports - Transferred ports.
 */
function dispatchMessage(data: string, source: Window | null, ports: MessagePort[]): void {
  // jsdom implements neither MessageChannel nor transferred ports: attach them directly.
  const event = new MessageEvent("message", { data, source })
  Object.defineProperty(event, "ports", { value: ports })
  window.dispatchEvent(event)
}

/** A stand-in port (jsdom has no MessagePort). */
const port1 = { close: jest.fn() } as unknown as MessagePort

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[QLBridge.Key]
})

describe("BridgeClient", () => {
  it("bridge() returns window.wireQL and throws a clear error when the preload did not run", () => {
    expect(() => BridgeClient.bridge()).toThrow(`window.${QLBridge.Key} is missing`)
    const bridge = installBridge()
    expect(BridgeClient.bridge()).toBe(bridge)
  })

  it("accepts a port only from this window carrying the query-port tag", () => {
    const listener = jest.fn(),
      unsubscribe = BridgeClient.onQueryPort(listener)
    dispatchMessage("something else", window, [port1])
    dispatchMessage(QLBridge.QueryPortMessage, null, [port1])
    expect(listener).not.toHaveBeenCalled()
    dispatchMessage(QLBridge.QueryPortMessage, window, [port1])
    expect(listener).toHaveBeenCalledWith(port1)
    unsubscribe()
    dispatchMessage(QLBridge.QueryPortMessage, window, [port1])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("the connector sends port requests / restarts and subscribes to host events", () => {
    const bridge = installBridge(),
      connector = BridgeClient.createQueryPortConnector(),
      listener = jest.fn()
    connector.requestQueryPort()
    connector.restartQueryHost()
    connector.onQueryHostExited(listener)
    connector.onQueryHostFailed(listener)
    expect(bridge.send.mock.calls.map(([channel]) => channel)).toEqual([
      IPCChannel.requestQueryPort,
      IPCChannel.restartQueryHost
    ])
    expect(bridge.on.mock.calls.map(([channel]) => channel)).toEqual([
      IPCEventChannel.queryHostExited,
      IPCEventChannel.queryHostFailed
    ])
  })
})
