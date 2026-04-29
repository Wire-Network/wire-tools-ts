import Assert from "node:assert"

import { defaults } from "lodash"

import {
  ApiPaths,
  DebuggingDefaults,
  type HandlerURIType,
  type InferredRequestType,
  type InferredResponseType
} from "@wireio/debugging-shared"

import { JsonRPCClient } from "./rpc/JsonRPCClient.js"

/**
 * Caller-facing knobs for {@link DebuggingServerClient.create}. Everything
 * is optional — omitted fields take defaults from {@link DebuggingDefaults}.
 */
export interface DebuggingToolClientOptions {
  /** Server base URL, e.g. `"http://localhost:9876"`. */
  baseUrl?: string
}

/** Fully-resolved runtime config derived from {@link DebuggingToolClientOptions}. */
export interface DebuggingToolClientConfig extends Required<DebuggingToolClientOptions> {}

/**
 * High-level client for the debugging server.
 *
 * Wraps {@link JsonRPCClient} for OPP RPC calls and adds:
 *   - a ping health check so constructor failure surfaces before any RPC,
 *   - default host/port resolution via {@link DebuggingDefaults}.
 *
 * Prefer this class for end-user tooling. If you only need the transport
 * (e.g. you already have a validated URL), construct {@link JsonRPCClient}
 * directly.
 */
export class DebuggingServerClient {
  /**
   * Create a client, verifying connectivity with a `GET /api/ping` round-trip.
   *
   * @param options - Optional overrides; omitted fields take defaults.
   * @returns A ready-to-use client. The underlying transport is constructed
   *          lazily in the private constructor — no connections are held
   *          open.
   * @throws When the health check does not return HTTP 200.
   */
  static async create(
    options: DebuggingToolClientOptions = {}
  ): Promise<DebuggingServerClient> {
    const config = defaults(
      { ...options },
      { baseUrl: DebuggingServerClient.DefaultURL }
    ) as DebuggingToolClientConfig

    const pingUrl = `${config.baseUrl}${ApiPaths.Ping}`
    const resp = await fetch(pingUrl)
    Assert.ok(
      resp.status === 200,
      `Debugging server not reachable at ${pingUrl}`
    )

    const rpc = new JsonRPCClient(`${config.baseUrl}${ApiPaths.OPP.Endpoint}`)
    return new DebuggingServerClient(config, rpc)
  }

  private constructor(
    readonly config: DebuggingToolClientConfig,
    private readonly rpc: JsonRPCClient
  ) {}

  /**
   * Typed JSON-RPC 2.0 call. Delegates to {@link JsonRPCClient.invoke}.
   *
   * @param method - `HandlerMap` key (e.g. `ApiPaths.OPP.Methods.Envelope`).
   * @param params - Request body; type inferred from the handler entry.
   * @returns The decoded response body, typed from the handler entry.
   */
  call<U extends HandlerURIType>(
    method: U,
    params: InferredRequestType<U>
  ): Promise<InferredResponseType<U>> {
    return this.rpc.invoke(method, params)
  }
}

export namespace DebuggingServerClient {
  /** Network defaults re-surfaced from {@link DebuggingDefaults} for factory ergonomics. */
  export const DefaultHost = DebuggingDefaults.Host
  export const DefaultPort = DebuggingDefaults.Port
  export const DefaultScheme = DebuggingDefaults.Scheme
  export const DefaultURL = DebuggingDefaults.URL
}
