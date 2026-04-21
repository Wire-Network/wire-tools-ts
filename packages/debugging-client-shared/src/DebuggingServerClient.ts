import Assert from "node:assert"

import { defaults } from "lodash"

import {
  ApiPaths,
  DebuggingDefaults,
  type HandlerURIType,
  type InferredRequestType,
  type InferredResponseType
} from "@wire-e2e-tests/debugging-shared"

export interface DebuggingToolClientOptions {
  /** Server base URL, e.g. "http://localhost:9876" */
  baseUrl?: string
}

export interface DebuggingToolClientConfig extends Required<DebuggingToolClientOptions> {}

export class DebuggingServerClient {
  private nextId = 1

  static async create(
    options: DebuggingToolClientOptions = {}
  ): Promise<DebuggingServerClient> {
    const config = defaults(
      { ...options },
      {
        baseUrl: `http://${DebuggingServerClient.DefaultHost}:${DebuggingServerClient.DefaultPort}`
      }
    ) as DebuggingToolClientConfig

    // Validate connectivity via health check (plain HTTP GET, not JSON-RPC)
    const pingUrl = `${config.baseUrl}${ApiPaths.Ping}`
    const resp = await fetch(pingUrl)
    Assert.ok(
      resp.status === 200,
      `Debugging server not reachable at ${pingUrl}`
    )

    return new DebuggingServerClient(config)
  }

  private constructor(readonly config: DebuggingToolClientConfig) {}

  /**
   * Typed JSON-RPC 2.0 call. The method name is the HandlerMap key
   * (e.g. ApiPaths.OPP.Routes.Envelope). Params and result types are inferred.
   *
   * POSTs to the OPP base path with JSON-RPC 2.0 envelope.
   * The server auto-detects JSON-RPC by checking for `"jsonrpc":"2.0"`.
   */
  async call<U extends HandlerURIType>(
    method: U,
    params: InferredRequestType<U>
  ): Promise<InferredResponseType<U>> {
    const id = this.nextId++
    const url = `${this.config.baseUrl}${ApiPaths.OPP.Endpoint}`

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        jsonrpc: DebuggingDefaults.JsonrpcVersion,
        method,
        params,
        id
      })
    })

    Assert.ok(
      resp.ok,
      `JSON-RPC POST failed: ${resp.status} ${resp.statusText}`
    )

    const body = (await resp.json()) as any

    Assert.ok(
      body.jsonrpc === DebuggingDefaults.JsonrpcVersion,
      "Invalid JSON-RPC version in response"
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
    return body.result as InferredResponseType<U>
  }
}

export namespace DebuggingServerClient {
  /** Network defaults re-surfaced from {@link DebuggingDefaults} for factory ergonomics. */
  export const DefaultHost = DebuggingDefaults.Host
  export const DefaultPort = DebuggingDefaults.Port
  export const DefaultScheme = DebuggingDefaults.Scheme
  export const DefaultURL = DebuggingDefaults.URL
}
