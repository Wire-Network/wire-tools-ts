import { identity } from "lodash"

import {
  JsonRPCProtocol,
  JsonRPCTransportError,
  JsonRPCTransportStage
} from "@wireio/cluster-tool-shared"
import { ApiPaths } from "@wireio/debugging-shared"

import { JsonRPCClient } from "@wireio/debugging-client-shared"
import { NestedError } from "@wireio/shared"

/** Endpoint the client is bound to — never dialed: `fetch` is stubbed. */
const EndpointURL = "http://debugging-server.invalid/api/opp"

/** Body a stubbed server answers with. */
interface StubResponseBody {
  jsonrpc: string
  id: number
  result: object
}

/** One captured `fetch` invocation. */
interface CapturedRequest {
  url: string
  init: RequestInit
}

function stubFetch(body: StubResponseBody): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (url: string | URL | Request, init: RequestInit) => {
        captured.push({ url: String(url), init })
        return new Response(JSON.stringify(body), { status: 200 })
      }
    )
  return captured
}

describe("JsonRPCClient", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("POSTs a JSON-RPC 2.0 envelope with the shared protocol method + headers", async () => {
    const captured = stubFetch({
        jsonrpc: JsonRPCProtocol.Version,
        id: JsonRPCClient.InitialRequestId,
        result: { records: [] }
      }),
      client = new JsonRPCClient(EndpointURL),
      result = await client.invoke(ApiPaths.OPP.Methods.LoadRecords, {})

    expect(result).toEqual({ records: [] })
    expect(captured).toHaveLength(1)
    const [{ url, init }] = captured
    expect(url).toBe(EndpointURL)
    expect(init.method).toBe(JsonRPCProtocol.HttpMethod)
    expect(init.headers).toEqual(JsonRPCProtocol.RequestHeaders)
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: JsonRPCProtocol.Version,
      method: ApiPaths.OPP.Methods.LoadRecords,
      params: {},
      id: JsonRPCClient.InitialRequestId
    })
  })

  it("rejects a response whose jsonrpc version is not 2.0", async () => {
    stubFetch({
      jsonrpc: "1.0",
      id: JsonRPCClient.InitialRequestId,
      result: { records: [] }
    })
    const client = new JsonRPCClient(EndpointURL)

    await expect(
      client.invoke(ApiPaths.OPP.Methods.LoadRecords, {})
    ).rejects.toThrow("not a valid response envelope")
  })

  it("rejects a response whose id does not match the request", async () => {
    stubFetch({
      jsonrpc: JsonRPCProtocol.Version,
      id: JsonRPCClient.InitialRequestId + 1,
      result: { records: [] }
    })
    const client = new JsonRPCClient(EndpointURL)

    await expect(
      client.invoke(ApiPaths.OPP.Methods.LoadRecords, {})
    ).rejects.toThrow("id mismatch")
  })

  it("rejects a JSON-RPC error member with its code", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: JsonRPCProtocol.Version,
            id: JsonRPCClient.InitialRequestId,
            error: { code: JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND, message: "nope" }
          })
        )
    )
    await expect(
      new JsonRPCClient(EndpointURL).invoke(ApiPaths.OPP.Methods.LoadRecords, {})
    ).rejects.toThrow(`JSON-RPC error ${JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND}: nope`)
  })

  it("rejects a non-2xx answer naming the status", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }))
    await expect(
      new JsonRPCClient(EndpointURL).invoke(ApiPaths.OPP.Methods.LoadRecords, {})
    ).rejects.toThrow(`${JsonRPCClient.PostFailedMessage}: HTTP 503`)
  })

  it("keeps the zod issues of an invalid envelope in the cause chain", async () => {
    stubFetch({ jsonrpc: "1.0", id: JsonRPCClient.InitialRequestId, result: {} })
    const error = await new JsonRPCClient(EndpointURL)
      .invoke(ApiPaths.OPP.Methods.LoadRecords, {})
      .then(() => null, identity<NestedError>)
    expect(error).toBeInstanceOf(NestedError)
    const [transport] = error.causes
    expect(transport).toBeInstanceOf(JsonRPCTransportError)
    expect((transport as JsonRPCTransportError).causes[0].name).toBe("ZodError")
  })

  describe("RequestSerializer", () => {
    it("writes the envelope with bigint params as decimal strings", () => {
      expect(
        JsonRPCClient.RequestSerializer.serialize({ jsonrpc: JsonRPCProtocol.Version, id: 1, method: "m", params: { value: 10n } })
      ).toBe('{"jsonrpc":"2.0","id":1,"method":"m","params":{"value":"10"}}')
    })
  })

  describe("transportError", () => {
    const failed = (stage: JsonRPCTransportStage) =>
      new JsonRPCTransportError(`${stage} failed`, { stage, url: EndpointURL, status: 500, requestId: 1, body: null })

    it("rewraps status and decode failures, keeping the transport error as the cause", () => {
      const status = JsonRPCClient.transportError(failed(JsonRPCTransportStage.status)) as NestedError,
        decode = JsonRPCClient.transportError(failed(JsonRPCTransportStage.decode)) as NestedError
      expect(status.message).toContain(`${JsonRPCClient.PostFailedMessage}: status failed`)
      expect(decode.message).toContain(JsonRPCClient.InvalidEnvelopeMessage)
      ;[status, decode].forEach(error => expect(error.causes[0]).toBeInstanceOf(JsonRPCTransportError))
    })

    it("returns the other stages and non-transport errors unchanged", () => {
      const request = failed(JsonRPCTransportStage.request),
        other = new TypeError("x")
      expect(JsonRPCClient.transportError(request)).toBe(request)
      expect(JsonRPCClient.transportError(other)).toBe(other)
    })
  })

  describe("bigintReplacer", () => {
    it("renders bigint values as decimal strings", () => {
      expect(
        JSON.stringify({ value: 10n }, JsonRPCClient.bigintReplacer)
      ).toBe('{"value":"10"}')
    })

    it("passes non-bigint values through unchanged", () => {
      expect(JsonRPCClient.bigintReplacer("key", 7)).toBe(7)
    })
  })
})
