import Http from "node:http"

import { BindConfigProvider, Localhost, toURL } from "@wireio/cluster-tool"
import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"

import {
  QueryEngineClient,
  QueryEngineRPC,
  QueryExecutionStatus,
  type QueryExecutionSuccess
} from "@wireio/ql-shared"

import { createProfile } from "../common/profileFixtures.js"
import { readEngineExample } from "../common/resultFixtures.js"

/** One request the stub received. */
interface ReceivedRequest {
  path: string
  method: string
  contentType: string
  body: string
}

describe("QueryEngineClient over real HTTP (node:http stub on a registry-issued port)", () => {
  const received: ReceivedRequest[] = []
  let server: Http.Server
  let endpoint: string

  beforeAll(async () => {
    const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
    await BindConfigProvider.clearPortLocks()
    server = Http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8"),
          { id } = JSON.parse(body)
        received.push({ path: request.url, method: request.method, contentType: request.headers["content-type"], body })
        response.writeHead(200, { "Content-Type": JsonRPCProtocol.RequestHeaders["Content-Type"] })
        response.end(JSON.stringify({ ...JSON.parse(readEngineExample("response-paged.json")), id }))
      })
    })
    await new Promise<void>(resolve => server.listen(port, Localhost, () => resolve()))
    endpoint = toURL(port, Localhost)
  })

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  })

  it("POSTs JSON-RPC to /v1/query/execute and decodes the paged result", async () => {
    const client = new QueryEngineClient(createProfile({ name: "stub", endpoint })),
      execution = await client.execute("SELECT key.id AS id FROM sample.positions", { limit: 2, offset: 2 })
    expect(execution.status).toBe(QueryExecutionStatus.success)
    expect((execution as QueryExecutionSuccess).result.page).toMatchObject({ offset: "2", limit: "2", has_more: true })
    expect(received.at(-1)).toMatchObject({
      path: QueryEngineRPC.ExecutePath,
      method: JsonRPCProtocol.HttpMethod,
      contentType: JsonRPCProtocol.RequestHeaders["Content-Type"]
    })
    expect(JSON.parse(received.at(-1).body).params).toEqual({ query: "SELECT key.id AS id FROM sample.positions", limit: 2, offset: 2 })
  })
})
