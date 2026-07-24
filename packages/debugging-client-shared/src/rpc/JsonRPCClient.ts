import Assert from "node:assert"

import {
  DebuggingDefaults,
  JsonRPCResponseEnvelopeSchemaCodec,
  PlainJsonRpcResponseCodecs,
  type HandlerURIType,
  type InferredRequestType,
  type InferredResponseType
} from "@wireio/debugging-shared"

/**
 * Strongly-typed JSON-RPC 2.0 client bound to a fully-qualified endpoint URL.
 *
 * `invoke()` resolves request/response types from `HandlerMap` at the call
 * site — callers get compile-time checking of both params AND the awaited
 * result without writing generics themselves.
 *
 * The client is pure transport: no health check, no config object, no URL
 * composition. For a batteries-included wrapper with a ping round-trip and
 * default host/port resolution, use `DebuggingServerClient`.
 *
 * @example
 * const rpc = new JsonRPCClient("http://127.0.0.1:9876/api/opp")
 * const resp = await rpc.invoke(ApiPaths.OPP.Methods.EnvelopeList, {
 *   epochStart: 0n,
 *   epochEnd: 0n,
 *   endpointsType: DebugOutpostEndpointsType.UNKNOWN,
 *   timestampStart: 0n,
 *   timestampEnd: 0n
 * })
 */
export class JsonRPCClient {
  /**
   * Monotonic request id. JSON-RPC 2.0 doesn't require monotonic ids, but
   * correlating request → response via equality is the simplest valid scheme.
   */
  private nextId = JsonRPCClient.InitialRequestId

  /**
   * @param url - Fully-qualified endpoint URL including the path segment
   *              (e.g. `http://127.0.0.1:9876/api/opp`). The client does
   *              not compose scheme/host/port itself — callers own that.
   */
  constructor(readonly url: string) {}

  /**
   * Invoke a JSON-RPC 2.0 method.
   *
   * @param method - A key of `HandlerMap` (typically an enum member like
   *                 `ApiPaths.OPP.Methods.Envelope`). Narrowing happens
   *                 purely at the type level; at runtime this is just a
   *                 string written into the request envelope.
   * @param params - Request body, typed from the handler entry.
   * @returns The decoded `result` field, typed from the handler entry.
   * @throws When the HTTP fetch fails, the envelope is malformed, or the
   *         server returns a JSON-RPC `error` field.
   */
  async invoke<P extends HandlerURIType>(
    method: P,
    params: InferredRequestType<P>
  ): Promise<InferredResponseType<P>> {
    const id = this.nextId++

    const resp = await fetch(this.url, {
      method: JsonRPCClient.HttpMethod,
      headers: JsonRPCClient.Headers,
      body: JSON.stringify(
        {
          jsonrpc: DebuggingDefaults.JsonrpcVersion,
          method,
          params,
          id
        },
        JsonRPCClient.bigintReplacer
      )
    })

    Assert.ok(
      resp.ok,
      `JSON-RPC POST failed: ${resp.status} ${resp.statusText}`
    )

    // Validate the response envelope structurally via the codec (replaces the
    // hand-rolled `as ResponseEnvelope` cast); `result` stays opaque per-method.
    const parsed: unknown = await resp.json()
    if (!JsonRPCResponseEnvelopeSchemaCodec.check(parsed)) {
      throw new Error("JSON-RPC response is not a valid response envelope")
    }
    const body = parsed

    Assert.ok(
      body.jsonrpc === DebuggingDefaults.JsonrpcVersion,
      `Invalid JSON-RPC version in response: ${body.jsonrpc}`
    )
    Assert.ok(
      body.id === id,
      `JSON-RPC id mismatch: expected ${id}, got ${body.id}`
    )

    if (body.error) {
      throw new Error(
        `JSON-RPC error ${body.error.code}: ${body.error.message}`
      )
    }

    Assert.ok("result" in body, "JSON-RPC response missing 'result'")
    // Validate the plain-JSON result via the method's codec (closes the
    // `as InferredResponseType` cast gap); proto methods have no entry and
    // pass through — protobuf-ts already validated them on the server's toJson.
    const responseCodec = PlainJsonRpcResponseCodecs[method]
    Assert.ok(
      !responseCodec || responseCodec.check(body.result),
      `JSON-RPC result for ${method} failed response validation`
    )
    return body.result as InferredResponseType<P>
  }
}

export namespace JsonRPCClient {
  /**
   * Starting value for the request-id counter. JSON-RPC 2.0 permits any id
   * (numeric, string, or null). Starting at 1 keeps logs readable and
   * preserves the "1-indexed request" convention most JSON-RPC tooling uses.
   */
  export const InitialRequestId = 1

  /** HTTP verb used for every RPC invocation. */
  export const HttpMethod = "POST" as const

  /** HTTP headers attached to every RPC invocation. */
  export const Headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  } as const

  /**
   * `JSON.stringify` replacer that turns `bigint` values into their
   * decimal string form. `JSON.stringify` would otherwise throw
   * `TypeError: Do not know how to serialize a BigInt`.
   *
   * Server-side, protobuf-ts's JSON parser accepts uint64 fields as
   * either string or number, so this round-trips losslessly.
   */
  export function bigintReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value
  }
}
