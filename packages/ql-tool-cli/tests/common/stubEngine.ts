import Http from "node:http"

import { BindConfigProvider, Localhost, toURL } from "@wireio/cluster-tool"
import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"
import type { QueryRequestParams } from "@wireio/ql-shared"

import { sampleResult } from "./engineFixtures.js"

/** One request the stub received. */
export interface StubRequest {
  /** URL path. */
  path: string
  /** JSON-RPC id. */
  id: string
  /** `params`. */
  params: QueryRequestParams
}

/** Builds the JSON-RPC response body of a request (the id is filled in by the stub); {@link HoldResponse} never answers. */
export type StubResponder = (request: StubRequest) => object

/** Responder result meaning "keep the request open, never answer" (abandon / cancel tests). */
export const HoldResponse = Object.freeze({ hold: true })

/** A running stub engine. */
export interface StubEngine {
  /** Base URL. */
  endpoint: string
  /** Received requests, in order. */
  requests: StubRequest[]
  /** Replace the responder. */
  respondWith(responder: StubResponder): void
  /** Stop listening. */
  close(): Promise<void>
}

/**
 * The default responder: the sample result (3 rows) for any request.
 *
 * @returns A success body without id.
 */
export const successResponder: StubResponder = () => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult() })

/**
 * Start a `node:http` stub of `POST /v1/query/execute` on a registry-issued port.
 *
 * @param responder - Response body builder.
 * @returns The stub.
 */
export async function startStubEngine(responder: StubResponder = successResponder): Promise<StubEngine> {
  const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
  await BindConfigProvider.clearPortLocks()
  const requests: StubRequest[] = []
  let current = responder
  const server = Http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      const { id, params } = JSON.parse(Buffer.concat(chunks).toString("utf8")),
        received: StubRequest = { path: request.url, id, params }
      requests.push(received)
      const body = current(received)
      if (body === HoldResponse) return
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ ...body, id }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, Localhost, () => resolve())
  })
  return {
    endpoint: toURL(port),
    requests,
    respondWith: next => {
      current = next
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}

/**
 * An endpoint on a registry-issued port with nothing listening (connection refused).
 *
 * @returns The endpoint.
 */
export async function unusedEndpoint(): Promise<string> {
  const port = await BindConfigProvider.findAvailable(BindConfigProvider.DefaultBiosHttp)
  await BindConfigProvider.clearPortLocks()
  return toURL(port)
}

/**
 * One stub engine for the enclosing `describe`: started in `beforeAll`, closed
 * (and awaited) in `afterAll`.
 *
 * @param responder - Response body builder (default: the sample result).
 * @returns Accessor of the running stub.
 */
export function useStubEngine(responder: StubResponder = successResponder): () => StubEngine {
  let engine: StubEngine = null
  beforeAll(async () => {
    engine = await startStubEngine(responder)
  })
  afterAll(async () => {
    await engine?.close()
    engine = null
  })
  return () => engine
}
