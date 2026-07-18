import Assert from "node:assert"
import type { ClusterConfig, ClusterState } from "@wireio/cluster-tool-shared"
import { defaults } from "lodash"

import {
  ApiPaths,
  DebuggingDefaults,
  FROM_JSON_OPTIONS,
  type GetClusterConfigResponse,
  type GetClusterStateResponse,
  type GetProcessLivenessRequest,
  type GetProcessLivenessResponse,
  type InferredStreamEvent,
  type InferredStreamParams,
  type ListProcessesResponse,
  type LoadEnvelopeRecordsRequest,
  type LoadEnvelopeRecordsResponse,
  type LogReadRequest,
  type LogReadResponse,
  type LogStat,
  type LogStatRequest,
  type PidSource,
  type ProcessLivenessSnapshot,
  type StreamTopic
} from "@wireio/debugging-shared"
import {
  GetEnvelopeResponse,
  ListEnvelopesResponse,
  type GetEnvelopeRequest,
  type ListEnvelopesRequest
} from "@wireio/opp-typescript-models"
import type { JsonValue } from "@protobuf-ts/runtime"

import { DebuggingClient } from "../DebuggingClient.js"
import { JsonRPCClient } from "../rpc/JsonRPCClient.js"
import { DebuggingSubscription } from "../subscriptions/index.js"
import { WebSocketStreamClient } from "./WebSocketStreamClient.js"

/** Caller-facing knobs for {@link NetDebuggingClient.create}. */
export interface NetDebuggingClientOptions {
  /** Server base URL, e.g. `"http://localhost:9876"`. */
  baseUrl?: string
}

/** Fully-resolved runtime config. */
export interface NetDebuggingClientConfig extends Required<NetDebuggingClientOptions> {}

/**
 * `DebuggingClient` over HTTP+WebSocket. Per-feature {@link JsonRPCClient}
 * instances handle unary calls; a single {@link WebSocketStreamClient}
 * multiplexes every stream subscription.
 *
 * `create()` performs a `GET /api/ping` round-trip and opens the WS
 * connection so callers can fail fast on a misconfigured `baseUrl`.
 */
export class NetDebuggingClient extends DebuggingClient {
  static async create(
    options: NetDebuggingClientOptions = {}
  ): Promise<NetDebuggingClient> {
    const config = defaults(
      { ...options },
      { baseUrl: NetDebuggingClient.DefaultURL }
    ) as NetDebuggingClientConfig

    const pingUrl = `${config.baseUrl}${ApiPaths.Ping}`,
      pingResp = await fetch(pingUrl)
    Assert.ok(
      pingResp.status === 200,
      `Debugging server not reachable at ${pingUrl}`
    )

    const oppRpc = new JsonRPCClient(
        `${config.baseUrl}${ApiPaths.OPP.Endpoint}`
      ),
      clusterRpc = new JsonRPCClient(
        `${config.baseUrl}${ApiPaths.Cluster.Endpoint}`
      ),
      processesRpc = new JsonRPCClient(
        `${config.baseUrl}${ApiPaths.Processes.Endpoint}`
      ),
      logsRpc = new JsonRPCClient(`${config.baseUrl}${ApiPaths.Logs.Endpoint}`),
      ws = new WebSocketStreamClient(config.baseUrl)
    return new NetDebuggingClient(
      config,
      oppRpc,
      clusterRpc,
      processesRpc,
      logsRpc,
      ws
    )
  }

  protected constructor(
    readonly config: NetDebuggingClientConfig,
    private readonly oppRpc: JsonRPCClient,
    private readonly clusterRpc: JsonRPCClient,
    private readonly processesRpc: JsonRPCClient,
    private readonly logsRpc: JsonRPCClient,
    private readonly ws: WebSocketStreamClient
  ) {
    super()
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.ws.connect()
  }

  async disconnect(): Promise<void> {
    await this.ws.disconnect()
  }

  // -------------------------------------------------------------------------
  //  Cluster
  // -------------------------------------------------------------------------

  async getClusterConfig(): Promise<ClusterConfig> {
    const resp = (await this.clusterRpc.invoke(
      ApiPaths.Cluster.Methods.GetConfig,
      {}
    )) as GetClusterConfigResponse
    return resp
  }

  async getClusterState(): Promise<ClusterState> {
    const resp = (await this.clusterRpc.invoke(
      ApiPaths.Cluster.Methods.GetState,
      {}
    )) as GetClusterStateResponse
    return resp.state
  }

  // -------------------------------------------------------------------------
  //  Process monitor
  // -------------------------------------------------------------------------

  async listProcessSources(): Promise<PidSource[]> {
    const resp = (await this.processesRpc.invoke(
      ApiPaths.Processes.Methods.List,
      {}
    )) as ListProcessesResponse
    return resp.sources
  }

  async getProcessLiveness(
    labels: string[]
  ): Promise<ProcessLivenessSnapshot[]> {
    const params: GetProcessLivenessRequest = { labels },
      resp = (await this.processesRpc.invoke(
        ApiPaths.Processes.Methods.GetLiveness,
        params
      )) as GetProcessLivenessResponse
    return resp.snapshots
  }

  // -------------------------------------------------------------------------
  //  Logs
  // -------------------------------------------------------------------------

  async getLogStat(path: string): Promise<LogStat> {
    const params: LogStatRequest = { path }
    return (await this.logsRpc.invoke(
      ApiPaths.Logs.Methods.GetStat,
      params
    )) as LogStat
  }

  async readLogWindow(req: LogReadRequest): Promise<string[]> {
    const resp = (await this.logsRpc.invoke(
      ApiPaths.Logs.Methods.Read,
      req
    )) as LogReadResponse
    return resp.lines
  }

  // -------------------------------------------------------------------------
  //  OPP envelope debug
  //
  //  Server-side these go through protobuf-ts JSON encoding (the wire
  //  format is JSON). We round-trip the response back through
  //  `MessageType.fromJson()` so callers receive a proper protobuf-ts
  //  message with the right field types (`bigint` for uint64,
  //  `Uint8Array` for bytes).
  // -------------------------------------------------------------------------

  async listEnvelopes(
    req: ListEnvelopesRequest
  ): Promise<ListEnvelopesResponse> {
    const json = await this.oppRpc.invoke(
      ApiPaths.OPP.Methods.EnvelopeList,
      req
    )
    // `invoke`'s inferred type is the protobuf-ts message interface
    // (`ListEnvelopesResponse`, with real `bigint`/`Uint8Array` field types),
    // but the value crossing the wire is plain parsed JSON matching
    // protobuf-ts's own `JsonValue` shape — the two are genuinely
    // structurally incompatible (bigint has no JsonValue member), so a
    // single-step assertion doesn't typecheck either direction.
    return ListEnvelopesResponse.fromJson(
      json as unknown as JsonValue,
      FROM_JSON_OPTIONS
    )
  }

  async getEnvelope(key: string): Promise<GetEnvelopeResponse> {
    const params: GetEnvelopeRequest = { key },
      json = await this.oppRpc.invoke(ApiPaths.OPP.Methods.EnvelopeGet, params)
    // Same protobuf-ts JSON-boundary mismatch as `listEnvelopes` above.
    return GetEnvelopeResponse.fromJson(
      json as unknown as JsonValue,
      FROM_JSON_OPTIONS
    )
  }

  async loadEnvelopeRecords(
    req: LoadEnvelopeRecordsRequest
  ): Promise<LoadEnvelopeRecordsResponse> {
    return (await this.oppRpc.invoke(
      ApiPaths.OPP.Methods.LoadRecords,
      req
    )) as LoadEnvelopeRecordsResponse
  }

  // -------------------------------------------------------------------------
  //  Streams
  // -------------------------------------------------------------------------

  async subscribe<T extends StreamTopic>(
    topic: T,
    params: InferredStreamParams<T>
  ): Promise<DebuggingSubscription<InferredStreamEvent<T>>> {
    return this.ws.subscribe(topic, params)
  }
}

export namespace NetDebuggingClient {
  /** Network defaults re-surfaced from {@link DebuggingDefaults} for factory ergonomics. */
  export const DefaultHost = DebuggingDefaults.Host
  export const DefaultPort = DebuggingDefaults.Port
  export const DefaultScheme = DebuggingDefaults.Scheme
  export const DefaultURL = DebuggingDefaults.URL
}
