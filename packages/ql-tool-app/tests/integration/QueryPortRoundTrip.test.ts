import { MessageChannel } from "node:worker_threads"

import { ConnectionProfile, PageSizeMode, QueryExecutionStatus } from "@wireio/ql-shared"

import type { QueryHostRequest } from "@wireio/ql-tool-app/common"
import { handleQueryHostRequest, QueryHostContext } from "@wireio/ql-tool-app/query-host"
import { QueryPortClient, type QueryPortConnector, type QueryPortLike } from "@wireio/ql-tool-app/renderer/query"

import { StubQueryEngine } from "../common/StubQueryEngine.js"

/**
 * The GUI query path without Electron: renderer-side QueryPortClient ↔ the host's
 * handleQueryHostRequest over a Node MessageChannel, against the node:http stub.
 */
describe("QueryPortClient ↔ handleQueryHostRequest", () => {
  let stub: StubQueryEngine = null
  const channel = new MessageChannel()

  beforeAll(async () => {
    stub = await StubQueryEngine.start()
  })

  afterAll(async () => {
    channel.port1.close()
    channel.port2.close()
    await stub?.close()
  })

  it("runs a query and loads the catalog over the port", async () => {
    const context = new QueryHostContext(),
      controllers = new Map<string, AbortController>(),
      profile = ConnectionProfile.create({ name: "stub", endpoint: stub.url, retries: 0 })
    channel.port2.on("message", (request: QueryHostRequest) =>
      handleQueryHostRequest(context, controllers, request).then(response => {
        if (response != null) channel.port2.postMessage(response)
      })
    )
    let deliver: (port: QueryPortLike) => void = null
    const connector: QueryPortConnector = {
        onQueryPort: listener => {
          deliver = listener
          return () => undefined
        },
        requestQueryPort: () => deliver(channel.port1 as unknown as QueryPortLike),
        restartQueryHost: () => undefined,
        onQueryHostExited: () => () => undefined,
        onQueryHostFailed: () => () => undefined
      },
      client = new QueryPortClient(connector)
    client.start()
    const execution = await client.execute({
      requestId: "r1",
      profile,
      query: `SELECT * FROM ${StubQueryEngine.Owner}.positions`,
      window: { limit: 2, offset: 0 },
      mode: PageSizeMode.paged
    })
    expect(execution.status).toBe(QueryExecutionStatus.success)
    expect(JSON.stringify(execution)).toContain("alice")
    const snapshot = await client.loadOwner("r2", profile, StubQueryEngine.Owner)
    expect(snapshot.owners.find(owner => owner.account === StubQueryEngine.Owner).loaded).toBe(true)
    expect(stub.requests.at(-1).params).toMatchObject({ limit: 2, offset: 0 })
  })
})
