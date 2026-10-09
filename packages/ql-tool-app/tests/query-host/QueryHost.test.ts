import { EventEmitter } from "node:events"

import type { ParentPort } from "electron"
import { BindConfigProvider, sleep } from "@wireio/cluster-tool"
import {
  ConnectionProfile,
  PageSizeMode,
  QueryErrorCode,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryFailureKind,
  type QueryExecution
} from "@wireio/ql-shared"

import {
  HostControlKind,
  QueryHostMessageKind,
  type QueryHostExecute,
  type QueryHostExecuted,
  type QueryHostFailed,
  type QueryHostResponse
} from "@wireio/ql-tool-app/common"
import {
  handleQueryHostRequest,
  QueryHost,
  QueryHostContext,
  type QueryHostRequestControllers
} from "@wireio/ql-tool-app/query-host"

import { FakeMessagePort } from "../__mocks__/electron.js"
import { ExecutionFixtures } from "../common/ExecutionFixtures.js"
import { StubQueryEngine } from "../common/StubQueryEngine.js"

/** Fixture constants. */
namespace Fixture {
  export const Window = { limit: 50, offset: 0 }
  export const SlowQuery = `SELECT * FROM ${StubQueryEngine.Owner}.slow`
  export const SyntaxErrorQuery = `${ExecutionFixtures.PositionsQuery} JOIN x`
  /** Time for a slow request to reach the stub before it is cancelled. */
  export const AbortSettleMs = 100
}

let stub: StubQueryEngine = null,
  profile: ConnectionProfile = null

beforeAll(async () => {
  stub = await StubQueryEngine.start()
  profile = ConnectionProfile.create({ name: "stub", endpoint: stub.url, retries: 0 })
})

afterAll(async () => {
  await stub?.close()
})

/**
 * An execute request.
 *
 * @param requestId - Correlation id.
 * @param query - SQL.
 * @returns The request.
 */
function executeOf(requestId: string, query: string): QueryHostExecute {
  return { kind: QueryHostMessageKind.execute, requestId, profile, query, window: Fixture.Window, mode: PageSizeMode.paged }
}

/** The execution inside an `executed` response. */
function executionOf(response: QueryHostResponse): QueryExecution {
  expect(response.kind).toBe(QueryHostMessageKind.executed)
  return (response as QueryHostExecuted).execution
}

describe("handleQueryHostRequest", () => {
  it("execute → executed with the engine rows", async () => {
    const execution = executionOf(
      await handleQueryHostRequest(new QueryHostContext(), new Map(), executeOf("e1", ExecutionFixtures.PositionsQuery))
    )
    expect(execution.status).toBe(QueryExecutionStatus.success)
    expect(JSON.stringify(execution)).toContain("alice")
  })

  it("an engine error is serialized inside executed", async () => {
    const execution = executionOf(
      await handleQueryHostRequest(new QueryHostContext(), new Map(), executeOf("e2", Fixture.SyntaxErrorQuery))
    )
    expect(execution.status).toBe(QueryExecutionStatus.failure)
    expect(execution.status === QueryExecutionStatus.failure && execution.failure.kind).toBe(QueryFailureKind.engine)
  })

  it("cancel by requestId aborts the in-flight execute and answers nothing", async () => {
    const context = new QueryHostContext(),
      controllers: QueryHostRequestControllers = new Map(),
      running = handleQueryHostRequest(context, controllers, executeOf("slow", Fixture.SlowQuery))
    await sleep(Fixture.AbortSettleMs)
    await expect(
      handleQueryHostRequest(context, controllers, { kind: QueryHostMessageKind.cancel, requestId: "slow" })
    ).resolves.toBeUndefined()
    const execution = executionOf(await running)
    expect(execution.status === QueryExecutionStatus.failure && execution.failure.kind).toBe(
      QueryFailureKind.cancelled
    )
    expect(controllers.size).toBe(0)
  })

  it("loadOwner → catalog snapshot; describe → described", async () => {
    const context = new QueryHostContext(),
      loaded = await handleQueryHostRequest(context, new Map(), {
        kind: QueryHostMessageKind.loadOwner,
        requestId: "l1",
        profile,
        owner: StubQueryEngine.Owner
      })
    expect(loaded.kind).toBe(QueryHostMessageKind.catalog)
    const described = await handleQueryHostRequest(context, new Map(), {
      kind: QueryHostMessageKind.describe,
      requestId: "d1",
      profile,
      owner: StubQueryEngine.Owner,
      table: "positions"
    })
    expect(described.kind).toBe(QueryHostMessageKind.described)
  })

  it("loadOwner passes its request's abort signal to the catalog", async () => {
    const context = new QueryHostContext(),
      loadOwner = jest.spyOn(context.servicesFor(profile).catalog, "loadOwner")
    await handleQueryHostRequest(context, new Map(), {
      kind: QueryHostMessageKind.loadOwner,
      requestId: "l3",
      profile,
      owner: StubQueryEngine.Owner
    })
    expect(loadOwner).toHaveBeenCalledWith(StubQueryEngine.Owner, { signal: expect.any(AbortSignal) })
  })

  it("a describe failing in the engine answers failed with the ENGINE failure (kind, code, retryable kept)", async () => {
    const response = await handleQueryHostRequest(new QueryHostContext(), new Map(), {
      kind: QueryHostMessageKind.describe,
      requestId: "d2",
      profile,
      owner: StubQueryEngine.Owner,
      table: "busy"
    })
    expect(response.kind).toBe(QueryHostMessageKind.failed)
    expect((response as QueryHostFailed).failure).toMatchObject({
      kind: QueryFailureKind.engine,
      code: QueryErrorCode.QUERY_BUSY,
      data: { kind: QueryErrorKind.QUERY_BUSY, retryable: true }
    })
  })

  it("an unreachable profile endpoint fails catalog requests as transport", async () => {
    // A registry-issued port nothing listens on: the connection is refused.
    const closedPort = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp),
      unreachable = ConnectionProfile.create({
        name: "gone",
        endpoint: `http://${StubQueryEngine.Host}:${closedPort}`,
        retries: 0
      }),
      response = await handleQueryHostRequest(new QueryHostContext(), new Map(), {
        kind: QueryHostMessageKind.loadOwner,
        requestId: "l2",
        profile: unreachable,
        owner: StubQueryEngine.Owner
      })
    expect(response.kind).toBe(QueryHostMessageKind.failed)
    expect((response as QueryHostFailed).failure.kind).toBe(QueryFailureKind.transport)
  })
})

describe("QueryHostContext", () => {
  it("caches services per profile and rebuilds when the profile changes", () => {
    const context = new QueryHostContext(),
      first = context.servicesFor(profile)
    expect(context.servicesFor({ ...profile })).toBe(first)
    expect(context.servicesFor({ ...profile, retries: 1 })).not.toBe(first)
  })
})

describe("QueryHost", () => {
  /** A fake parentPort. */
  function newParentPort(): EventEmitter {
    return new EventEmitter()
  }

  /**
   * Wait for the port's next posted message.
   *
   * @param port - The fake port.
   * @returns The message.
   */
  function nextPosted(port: FakeMessagePort): Promise<QueryHostResponse> {
    const before = port.posted.length
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (port.posted.length > before) {
          clearInterval(poll)
          resolve(port.posted[before] as QueryHostResponse)
        }
      }, 10)
    })
  }

  it("attach serves requests on that port; detach aborts its in-flight requests and closes it", async () => {
    const parentPort = newParentPort(),
      host = new QueryHost(parentPort as unknown as ParentPort),
      port = new FakeMessagePort()
    parentPort.emit("message", { data: { kind: HostControlKind.attach, windowId: 7 }, ports: [port] })
    expect(host.attachedWindowIds).toEqual([7])
    expect(port.start).toHaveBeenCalled()
    const answered = nextPosted(port)
    port.emit("message", { data: executeOf("p1", ExecutionFixtures.PositionsQuery) })
    expect((await answered).requestId).toBe("p1")

    const slow = nextPosted(port)
    port.emit("message", { data: executeOf("p2", Fixture.SlowQuery) })
    await sleep(Fixture.AbortSettleMs)
    parentPort.emit("message", { data: { kind: HostControlKind.detach, windowId: 7 }, ports: [] })
    expect(port.closed).toBe(true)
    expect(host.attachedWindowIds).toEqual([])
    const execution = executionOf(await slow)
    expect(execution.status === QueryExecutionStatus.failure && execution.failure.kind).toBe(
      QueryFailureKind.cancelled
    )
  })

  it("a request whose handling throws is answered failed on its own port with the classified failure", async () => {
    const parentPort = newParentPort(),
      context = new QueryHostContext(),
      host = new QueryHost(parentPort as unknown as ParentPort, context),
      port = new FakeMessagePort()
    jest.spyOn(context, "servicesFor").mockImplementationOnce(() => {
      throw new Error("profile rejected")
    })
    parentPort.emit("message", { data: { kind: HostControlKind.attach, windowId: 3 }, ports: [port] })
    const answered = nextPosted(port)
    port.emit("message", { data: executeOf("c1", ExecutionFixtures.PositionsQuery) })
    expect(await answered).toEqual({
      kind: QueryHostMessageKind.failed,
      requestId: "c1",
      failure: { kind: QueryFailureKind.transport, message: "profile rejected", code: null, data: null }
    })
    expect(host.attachedWindowIds).toEqual([3])
  })

  it("detach of an unknown window is a no-op and leaves other ports attached", () => {
    const parentPort = newParentPort(),
      host = new QueryHost(parentPort as unknown as ParentPort)
    parentPort.emit("message", { data: { kind: HostControlKind.attach, windowId: 1 }, ports: [new FakeMessagePort()] })
    parentPort.emit("message", { data: { kind: HostControlKind.detach, windowId: 99 }, ports: [] })
    expect(host.attachedWindowIds).toEqual([1])
  })
})
