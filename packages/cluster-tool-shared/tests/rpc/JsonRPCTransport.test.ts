import { z } from "zod"

import {
  JsonRPCProtocol,
  JsonRPCResponseEnvelopeSchemaCodec,
  JsonRPCTransport,
  JsonRPCTransportError,
  JsonRPCTransportStage,
  SchemaCodec,
  type JsonRPCRequestEnvelope
} from "@wireio/cluster-tool-shared"

/** Endpoint the stubbed fetch pretends to answer for (never dialed). */
const EndpointURL = "http://rpc.invalid/rpc"

/** The request every case sends. */
const request: JsonRPCRequestEnvelope = { jsonrpc: JsonRPCProtocol.Version, id: 7, method: "ping", params: {} }

/** A plain JSON writer. */
const plainSerializer: JsonRPCTransport.RequestSerializer<JsonRPCRequestEnvelope> = {
  serialize: value => JSON.stringify(value)
}

/** A recorded fetch call. */
interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fetch answering with `response` (or rejecting with `failure`) and recording the call. */
function fetchAnswering(response: () => Response, calls: RecordedCall[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return response()
  }) as unknown as typeof fetch
}

/** Invoke against `fetchProvider` with the shared response codec. */
function invoke(fetchProvider: typeof fetch, signal?: AbortSignal) {
  return JsonRPCTransport.invoke({
    url: EndpointURL,
    request,
    requestSerializer: plainSerializer,
    responseCodec: JsonRPCResponseEnvelopeSchemaCodec,
    fetchProvider,
    signal
  })
}

/** The transport error a rejected invocation threw. */
async function failureOf(pending: Promise<unknown>): Promise<JsonRPCTransportError> {
  try {
    await pending
  } catch (error) {
    expect(error).toBeInstanceOf(JsonRPCTransportError)
    return error as JsonRPCTransportError
  }
  throw new Error("expected the invocation to reject")
}

describe("JsonRPCTransport.invoke", () => {
  it("POSTs the serialized envelope with the protocol method + headers and returns the decoded envelope", async () => {
    const calls: RecordedCall[] = [],
      controller = new AbortController(),
      envelope = await invoke(
        fetchAnswering(() => new Response(JSON.stringify({ jsonrpc: JsonRPCProtocol.Version, id: 7, result: { pong: true } })), calls),
        controller.signal
      )
    expect(envelope).toEqual({ jsonrpc: JsonRPCProtocol.Version, id: 7, result: { pong: true } })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(EndpointURL)
    expect(calls[0].init).toMatchObject({
      method: JsonRPCProtocol.HttpMethod,
      headers: JsonRPCProtocol.RequestHeaders,
      body: JSON.stringify(request),
      signal: controller.signal
    })
  })

  it("returns an error envelope for the client to branch on", async () => {
    const error = { code: JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND, message: "nope" },
      envelope = await invoke(fetchAnswering(() => new Response(JSON.stringify({ jsonrpc: JsonRPCProtocol.Version, id: 7, error }))))
    expect(envelope.error).toEqual(error)
  })

  it("lets a serializer throw propagate unwrapped (a caller bug)", async () => {
    const bug = new RangeError("bad request")
    await expect(
      JsonRPCTransport.invoke({
        url: EndpointURL,
        request,
        requestSerializer: { serialize: () => { throw bug } },
        responseCodec: JsonRPCResponseEnvelopeSchemaCodec,
        fetchProvider: fetchAnswering(() => new Response("{}"))
      })
    ).rejects.toBe(bug)
  })

  it("maps a fetch rejection to the request stage, keeping the cause", async () => {
    const cause = new TypeError("fetch failed"),
      failure = await failureOf(
        invoke((async () => {
          throw cause
        }) as unknown as typeof fetch)
      )
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.request, status: null, url: EndpointURL, requestId: 7, body: null })
    expect(failure.detail).toBe(`request to ${EndpointURL} failed`)
    expect(failure.causes).toContain(cause)
  })

  it.each([
    [500, "boom", "HTTP 500"],
    [JsonRPCTransport.NoContentStatus, null, "HTTP 204"]
  ])("maps HTTP %s to the status stage", async (status, text, detail) => {
    const failure = await failureOf(invoke(fetchAnswering(() => new Response(text, { status }))))
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.status, status })
    expect(failure.detail).toContain(detail)
  })

  it("maps a body read failure to the read stage", async () => {
    const failing = (async () => ({ ok: true, status: 200, statusText: "", text: () => Promise.reject(new Error("reset")) })) as unknown as typeof fetch,
      failure = await failureOf(invoke(failing))
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.read, status: 200, detail: "reading the response failed" })
  })

  it("maps a non-JSON body to the decode stage with a null body", async () => {
    const failure = await failureOf(invoke(fetchAnswering(() => new Response("{nope"))))
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.decode, body: null })
    expect(failure.causes[0]).toBeInstanceOf(SyntaxError)
  })

  it("maps an invalid envelope to the decode stage, carrying the parsed body and the zod issues", async () => {
    const body = { jsonrpc: "1.0", id: 7, result: {} },
      failure = await failureOf(invoke(fetchAnswering(() => new Response(JSON.stringify(body)))))
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.decode, body })
    expect(failure.detail).toContain("jsonrpc")
    expect(failure.causes[0]).toBeInstanceOf(z.ZodError)
  })

  it("maps an id mismatch to the id stage", async () => {
    const failure = await failureOf(
      invoke(fetchAnswering(() => new Response(JSON.stringify({ jsonrpc: JsonRPCProtocol.Version, id: 8, result: {} }))))
    )
    expect(failure).toMatchObject({ stage: JsonRPCTransportStage.id, detail: "JSON-RPC id mismatch: expected 7, got 8" })
  })

  it("accepts a validating SchemaCodec as the request serializer", async () => {
    const RequestSchema = z.object({ jsonrpc: z.literal(JsonRPCProtocol.Version), id: z.number(), method: z.string(), params: z.object({}) }),
      calls: RecordedCall[] = []
    await JsonRPCTransport.invoke({
      url: EndpointURL,
      request,
      requestSerializer: SchemaCodec.create<JsonRPCRequestEnvelope>(RequestSchema),
      responseCodec: JsonRPCResponseEnvelopeSchemaCodec,
      fetchProvider: fetchAnswering(() => new Response(JSON.stringify({ jsonrpc: JsonRPCProtocol.Version, id: 7, result: null })), calls)
    })
    expect(JSON.parse(calls[0].init.body as string)).toEqual(request)
  })
})

describe("JsonRPCTransportError", () => {
  it("carries stage, url, status, request id, body, detail and cause; folds the context into the message", () => {
    const cause = new Error("root"),
      error = new JsonRPCTransportError("broke", {
        stage: JsonRPCTransportStage.status,
        url: EndpointURL,
        status: 502,
        requestId: "r",
        body: null,
        cause
      })
    expect(error).toMatchObject({ name: "JsonRPCTransportError", stage: JsonRPCTransportStage.status, url: EndpointURL, status: 502, requestId: "r", detail: "broke" })
    expect(error.message).toContain("502")
    expect(error.causes).toEqual([cause])
  })

  it("works without a cause", () => {
    expect(
      new JsonRPCTransportError("x", { stage: JsonRPCTransportStage.id, url: "u", status: 200, requestId: null, body: null }).causes
    ).toEqual([])
  })
})
