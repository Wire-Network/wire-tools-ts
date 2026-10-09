import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads"

import { identity } from "lodash"

import {
  PageSizeMode,
  QueryEngineClient,
  QueryErrorCode,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryFailure,
  QueryFailureKind,
  type ConnectionProfile,
  type QueryExecution
} from "@wireio/ql-shared"

import { QueryHostMessageKind, type QueryHostRequest } from "@wireio/ql-tool-app/common"
import {
  QueryPortClient,
  QueryPortError,
  QueryPortStatus,
  type QueryPortConnector,
  type QueryPortLike
} from "@wireio/ql-tool-app/renderer/query"

import { ConnectionFixtures } from "../../common/ConnectionFixtures.js"

/** Fixture constants. */
namespace Fixture {
  export const Profile = { name: "p", endpoint: ConnectionFixtures.Endpoint, retries: 0 } as ConnectionProfile
  export const Window = { limit: 10, offset: 0 }
}

/** A fake bridge connector recording call order. */
interface FakeConnector extends QueryPortConnector {
  calls: string[]
  deliver(port: QueryPortLike): void
  exited(): void
  failed(): void
}

/** A connector whose events the test fires. */
function newConnector(): FakeConnector {
  const calls: string[] = []
  let onPort: (port: QueryPortLike) => void = null,
    onExited: () => void = null,
    onFailed: () => void = null
  return {
    calls,
    onQueryPort: listener => {
      calls.push("onQueryPort")
      onPort = listener
      return () => undefined
    },
    requestQueryPort: () => calls.push("requestQueryPort"),
    restartQueryHost: () => calls.push("restartQueryHost"),
    onQueryHostExited: listener => {
      onExited = listener
      return () => undefined
    },
    onQueryHostFailed: listener => {
      onFailed = listener
      return () => undefined
    },
    deliver: port => onPort(port),
    exited: () => onExited(),
    failed: () => onFailed()
  }
}

const opened: NodeMessagePort[] = []

/** A channel whose ports are closed after the test. */
function newChannel(): MessageChannel {
  const channel = new MessageChannel()
  opened.push(channel.port1, channel.port2)
  return channel
}

/**
 * A host end that records requests and answers on demand.
 *
 * @param port - The host's end.
 * @returns The received requests.
 */
function hostEnd(port: NodeMessagePort): QueryHostRequest[] {
  const received: QueryHostRequest[] = []
  port.on("message", (request: QueryHostRequest) => received.push(request))
  return received
}

/** An executed reply for `requestId`. */
function executedOf(requestId: string): object {
  const execution = { status: QueryExecutionStatus.success, requestId } as unknown as QueryExecution
  return { kind: QueryHostMessageKind.executed, requestId, execution }
}

/** Execute params. */
function paramsOf(requestId: string): Parameters<QueryPortClient["execute"]>[0] {
  return { requestId, profile: Fixture.Profile, query: "SELECT 1", window: Fixture.Window, mode: PageSizeMode.paged }
}

/** Wait for `count` requests on the host end. */
async function receivedCount(received: QueryHostRequest[], count: number): Promise<void> {
  while (received.length < count) await new Promise(resolve => setImmediate(resolve))
}

afterEach(() => {
  opened.splice(0).forEach(port => port.close())
})

describe("QueryPortClient", () => {
  it("registers the port receiver before requesting a port", () => {
    const connector = newConnector()
    new QueryPortClient(connector).start()
    expect(connector.calls.slice(0, 2)).toEqual(["onQueryPort", "requestQueryPort"])
  })

  it("queues calls while connecting and correlates out-of-order responses", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1, port2 } = newChannel(),
      received = hostEnd(port2)
    client.start()
    const first = client.execute(paramsOf("a")),
      second = client.execute(paramsOf("b"))
    connector.deliver(port1 as unknown as QueryPortLike)
    expect(client.status).toBe(QueryPortStatus.connected)
    await receivedCount(received, 2)
    port2.postMessage(executedOf("b"))
    port2.postMessage(executedOf("a"))
    await expect(second).resolves.toMatchObject({ requestId: "b" })
    await expect(first).resolves.toMatchObject({ requestId: "a" })
    expect(client.pendingCount).toBe(0)
  })

  it("a replacement port rejects in-flight calls as restarted and later calls use the new port", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      old = newChannel(),
      newPort = newChannel(),
      oldReceived = hostEnd(old.port2),
      newReceived = hostEnd(newPort.port2)
    client.start()
    connector.deliver(old.port1 as unknown as QueryPortLike)
    const inFlight = client.execute(paramsOf("x"))
    await receivedCount(oldReceived, 1)
    connector.deliver(newPort.port1 as unknown as QueryPortLike)
    await expect(inFlight).rejects.toThrow(QueryPortError.HostRestarted)
    const next = client.execute(paramsOf("y"))
    await receivedCount(newReceived, 1)
    newPort.port2.postMessage(executedOf("y"))
    await expect(next).resolves.toMatchObject({ requestId: "y" })
    expect(oldReceived).toHaveLength(1)
  })

  it("queryHostExited rejects pending calls and re-requests a port", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1 } = newChannel()
    client.start()
    connector.deliver(port1 as unknown as QueryPortLike)
    const pending = client.execute(paramsOf("z"))
    connector.exited()
    await expect(pending).rejects.toThrow(QueryPortError.HostExited)
    expect(client.status).toBe(QueryPortStatus.connecting)
    expect(connector.calls.filter(call => call === "requestQueryPort")).toHaveLength(2)
  })

  it("queryHostFailed rejects queued calls and every new call until a port arrives", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1 } = newChannel()
    client.start()
    const queued = client.execute(paramsOf("q"))
    connector.failed()
    await expect(queued).rejects.toThrow(QueryPortError.HostFailed)
    await expect(client.execute(paramsOf("r"))).rejects.toBeInstanceOf(QueryPortError)
    client.restart()
    expect(connector.calls).toContain("restartQueryHost")
    connector.deliver(port1 as unknown as QueryPortLike)
    expect(client.status).toBe(QueryPortStatus.connected)
  })

  it("a failed response rejects with a QueryPortError carrying the received failure; status changes are reported once each", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1, port2 } = newChannel(),
      received = hostEnd(port2),
      statuses: QueryPortStatus[] = []
    client.onStatus(status => statuses.push(status))
    client.start()
    connector.deliver(port1 as unknown as QueryPortLike)
    const describing = client.describe("d", Fixture.Profile, "sample", "positions")
    await receivedCount(received, 1)
    const failure = {
      kind: QueryFailureKind.engine,
      message: "unknown table",
      code: QueryErrorCode.QUERY_SEMANTICS,
      data: { kind: QueryErrorKind.QUERY_SEMANTICS, retryable: false, line: null, column: null, limit: null }
    }
    port2.postMessage({ kind: QueryHostMessageKind.failed, requestId: "d", failure })
    const error = await describing.then(() => null, identity<QueryPortError>)
    expect(error).toBeInstanceOf(QueryPortError)
    expect(error.failure).toEqual(failure)
    expect(QueryFailure.of(error)).toEqual(failure)
    expect(statuses).toEqual([QueryPortStatus.connected])
  })

  it("cancelling a queued (unsent) call rejects it locally as cancelled; it is never sent", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1, port2 } = newChannel(),
      received = hostEnd(port2)
    client.start()
    const queued = client.execute(paramsOf("early"))
    client.cancel("early")
    const error = await queued.then(() => null, identity<QueryPortError>)
    expect(error.failure).toEqual(QueryEngineClient.cancelledFailure())
    expect(client.pendingCount).toBe(0)
    connector.deliver(port1 as unknown as QueryPortLike)
    const sent = client.execute(paramsOf("probe"))
    await receivedCount(received, 1)
    expect(received.map(request => request.requestId)).toEqual(["probe"])
    port2.postMessage(executedOf("probe"))
    await sent
  })

  it("cancelling a sent call posts cancel to the host; unknown ids are ignored", async () => {
    const connector = newConnector(),
      client = new QueryPortClient(connector),
      { port1, port2 } = newChannel(),
      received = hostEnd(port2)
    client.start()
    connector.deliver(port1 as unknown as QueryPortLike)
    client.cancel("unknown")
    const running = client.execute(paramsOf("late"))
    await receivedCount(received, 1)
    client.cancel("late")
    await receivedCount(received, 2)
    expect(received[1]).toEqual({ kind: QueryHostMessageKind.cancel, requestId: "late" })
    port2.postMessage(executedOf("late"))
    await expect(running).resolves.toMatchObject({ requestId: "late" })
    expect(received).toHaveLength(2)
  })
})
