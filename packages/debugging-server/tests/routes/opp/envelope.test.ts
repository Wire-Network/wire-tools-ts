import { JsonRPC } from "@wireio/debugging-server"
import { ApiPaths } from "@wireio/debugging-shared"
import { type PutEnvelopeResponse } from "@wireio/opp-typescript-models"

import {
  EnvelopeRouteHarness,
  makeRouteEnvelope,
  routePutParams
} from "./envelopeRouteTestSupport.js"

describe(`JSON-RPC 2.0 via POST ${ApiPaths.OPP.Endpoint}`, () => {
  let harness: EnvelopeRouteHarness

  beforeAll(async () => {
    harness = await EnvelopeRouteHarness.start("opp-jsonrpc")
  })

  afterAll(async () => {
    await harness.stop()
  })

  it("returns the generated response shape for a valid call", async () => {
    const response = await harness.rpc<PutEnvelopeResponse>(
      ApiPaths.OPP.Methods.Envelope,
      routePutParams(makeRouteEnvelope(100), "batchop.a")
    )

    expect(response).toMatchObject({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: response.id,
        result: {
          dataExisted: false,
          batchOpNames: ["batchop.a"]
        }
      }
    })
    expect(response.body.result?.key).toMatch(/^00000100-/)
    expect(response.body.error).toBeUndefined()
  })

  it("returns METHOD_NOT_FOUND for an unknown method", async () => {
    const response = await harness.rpc("/api/opp/nonexistent", {})

    expect(response.body.result).toBeUndefined()
    expect(response.body.error?.code).toBe(JsonRPC.ErrorCode.METHOD_NOT_FOUND)
  })

  it("returns HTTP 400 when the jsonrpc field is missing", async () => {
    const response = await fetch(`${harness.baseUrl}${ApiPaths.OPP.Endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: ApiPaths.OPP.Methods.Envelope,
        params: {}
      })
    })

    expect(response.status).toBe(400)
  })

  it("auto-detects JSON-RPC on the individual method path", async () => {
    const response = await fetch(`${harness.baseUrl}${ApiPaths.OPP.Endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: ApiPaths.OPP.Methods.Envelope,
          params: routePutParams(makeRouteEnvelope(201), "batchop.mixed"),
          id: 42
        })
      }),
      body: { readonly id?: number; readonly result?: PutEnvelopeResponse } =
        await response.json()

    expect(response.status).toBe(200)
    expect(body.id).toBe(42)
    expect(body.result?.key).toMatch(/^00000201-/)
  })
})

describe(`GET ${ApiPaths.Ping}`, () => {
  let harness: EnvelopeRouteHarness

  beforeAll(async () => {
    harness = await EnvelopeRouteHarness.start("opp-ping")
  })

  afterAll(async () => {
    await harness.stop()
  })

  it("returns status ok", async () => {
    const response = await fetch(`${harness.baseUrl}${ApiPaths.Ping}`),
      body: { readonly status?: string } = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe("ok")
  })
})
