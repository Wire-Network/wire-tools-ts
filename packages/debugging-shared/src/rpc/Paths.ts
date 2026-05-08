import { MessageType } from "@protobuf-ts/runtime"
import {
  PutEnvelopeRequest,
  PutEnvelopeResponse,
  ListEnvelopesRequest,
  ListEnvelopesResponse,
  GetEnvelopeRequest,
  GetEnvelopeResponse
} from "@wireio/opp-typescript-models"

import type {
  GetClusterConfigRequest,
  GetClusterConfigResponse,
  GetClusterStateRequest,
  GetClusterStateResponse
} from "../cluster/index.js"
import type {
  LoadEnvelopeRecordsRequest,
  LoadEnvelopeRecordsResponse
} from "../opp/index.js"
import type {
  ListProcessesRequest,
  ListProcessesResponse,
  GetProcessLivenessRequest,
  GetProcessLivenessResponse
} from "../processes/index.js"
import type {
  LogStatRequest,
  LogStatResponse,
  LogReadRequest,
  LogReadResponse
} from "../logs/index.js"

// ---------------------------------------------------------------------------
//  API path constants — single source of truth for all URI strings
// ---------------------------------------------------------------------------

/** protobuf-ts JSON parser options reused on both ends of the OPP wire. */
export const FROM_JSON_OPTIONS = {
    ignoreUnknownFields: true
  } as const,
  /** protobuf-ts JSON encoder options reused on both ends of the OPP wire. */
  TO_JSON_OPTIONS = { enumAsInteger: true, emitDefaultValues: true } as const

export namespace ApiPaths {
  /** Health-check route mounted on the server. */
  export const Ping = "/api/ping" as const

  /**
   * OPP envelope debug feature. Routes carry **protobuf** request/response
   * bodies — the only feature in this package that does so, because the
   * data on the wire originates from the sysio `external_debugging_plugin`
   * which writes protobuf.
   */
  export namespace OPP {
    export const Endpoint = "/api/opp" as const

    /**
     * RPC method names exposed under the OPP feature section.
     *
     * Values double as JSON-RPC `method` strings on the wire and as keys in
     * `HandlerMap` / `HandlerTypeMappings`. Renaming a member is a breaking
     * wire-protocol change — bump the server version and update every client.
     */
    export enum Methods {
      Envelope = "Envelope",
      EnvelopeList = "EnvelopeList",
      EnvelopeGet = "EnvelopeGet",
      /**
       * Bulk-fetch fully-decoded envelope records grouped by epoch. Plain
       * JSON body — sits on the OPP endpoint alongside the protobuf
       * methods, dispatched through the same JSON-RPC mount but without
       * a `HandlerTypeMappings` entry.
       */
      LoadRecords = "LoadRecords"
    }
  }

  /**
   * Cluster information feature. Surfaces `cluster-config.json` and
   * `cluster-state.json` over JSON-RPC for clients that don't share the
   * filesystem with the server. Bodies are plain TypeScript interfaces —
   * no protobuf.
   */
  export namespace Cluster {
    export const Endpoint = "/api/cluster" as const

    export enum Methods {
      GetConfig = "Cluster.GetConfig",
      GetState = "Cluster.GetState"
    }
  }

  /**
   * Process monitor feature. Lists pid-file-backed sources and probes
   * kernel liveness for them. Bodies are plain TypeScript interfaces.
   */
  export namespace Processes {
    export const Endpoint = "/api/processes" as const

    export enum Methods {
      List = "Processes.List",
      GetLiveness = "Processes.GetLiveness"
    }
  }

  /**
   * Log read feature. Random-access reads + stat queries against log files
   * inside the server's `--cluster-path`. The matching live-tail topic is
   * exposed via the WebSocket transport (see `StreamTopic.LogTail`).
   */
  export namespace Logs {
    export const Endpoint = "/api/logs" as const

    export enum Methods {
      GetStat = "Logs.GetStat",
      Read = "Logs.Read"
    }
  }

  /**
   * WebSocket endpoint for stream subscriptions. Frame protocol lives in
   * `StreamProtocol.ts`. Path MUST match between server upgrade handler
   * and client connection URL.
   */
  export namespace Stream {
    export const Path = "/api/stream" as const
  }
}

// ---------------------------------------------------------------------------
//  Core handler abstraction — no express dependency.
//  R = request body type, T = response type.
//  The server narrows the second/third args to express Request/Response;
//  this definition only needs to carry R and T for type inference.
// ---------------------------------------------------------------------------

export type Handler<R = unknown, T = unknown> = (
  body: R,
  ...args: any[]
) => Promise<T> | T

// ---------------------------------------------------------------------------
//  Handler map — pure type definition, no runtime object.
//  The server provides implementations that conform to this interface.
//  The client infers request/response types from it.
// ---------------------------------------------------------------------------

export interface HandlerMap {
  // OPP — protobuf bodies (preserved verbatim)
  [ApiPaths.OPP.Methods.Envelope]: Handler<
    PutEnvelopeRequest,
    PutEnvelopeResponse
  >
  [ApiPaths.OPP.Methods.EnvelopeList]: Handler<
    ListEnvelopesRequest,
    ListEnvelopesResponse
  >
  [ApiPaths.OPP.Methods.EnvelopeGet]: Handler<
    GetEnvelopeRequest,
    GetEnvelopeResponse
  >
  // OPP — plain JSON bulk-load of decoded records (no protobuf body)
  [ApiPaths.OPP.Methods.LoadRecords]: Handler<
    LoadEnvelopeRecordsRequest,
    LoadEnvelopeRecordsResponse
  >

  // Cluster — plain JSON bodies
  [ApiPaths.Cluster.Methods.GetConfig]: Handler<
    GetClusterConfigRequest,
    GetClusterConfigResponse
  >
  [ApiPaths.Cluster.Methods.GetState]: Handler<
    GetClusterStateRequest,
    GetClusterStateResponse
  >

  // Processes — plain JSON bodies
  [ApiPaths.Processes.Methods.List]: Handler<
    ListProcessesRequest,
    ListProcessesResponse
  >
  [ApiPaths.Processes.Methods.GetLiveness]: Handler<
    GetProcessLivenessRequest,
    GetProcessLivenessResponse
  >

  // Logs — plain JSON bodies
  [ApiPaths.Logs.Methods.GetStat]: Handler<LogStatRequest, LogStatResponse>
  [ApiPaths.Logs.Methods.Read]: Handler<LogReadRequest, LogReadResponse>
}

export type MessageTypeCtor<T extends object = any> = { new (): MessageType<T> }

/**
 * Runtime protobuf type table — used by the OPP JSON-RPC dispatcher to
 * `fromJson` request bodies and `toJson` responses. Keyed only by the
 * **protobuf** OPP methods; `LoadRecords` is plain JSON and intentionally
 * absent so the dispatcher's "no entry → plain JSON path" branch picks
 * it up. Adding an entry for a non-protobuf method here would break
 * runtime serialization.
 */
export const HandlerTypeMappings: {
  [ApiPaths.OPP.Methods.Envelope]: [MessageType<any>, MessageType<any>]
  [ApiPaths.OPP.Methods.EnvelopeList]: [MessageType<any>, MessageType<any>]
  [ApiPaths.OPP.Methods.EnvelopeGet]: [MessageType<any>, MessageType<any>]
} = {
  [ApiPaths.OPP.Methods.Envelope]: [PutEnvelopeRequest, PutEnvelopeResponse],
  [ApiPaths.OPP.Methods.EnvelopeList]: [
    ListEnvelopesRequest,
    ListEnvelopesResponse
  ],
  [ApiPaths.OPP.Methods.EnvelopeGet]: [GetEnvelopeRequest, GetEnvelopeResponse]
} as const

// ---------------------------------------------------------------------------
//  Inferred utility types — used by server addRoute(), client, and tests
// ---------------------------------------------------------------------------

/** Every method name carried by the unary RPC contract. */
export type HandlerURIType = keyof HandlerMap

/** Extract the full handler function type for a given URI. */
export type InferredHandlerType<U extends HandlerURIType> = HandlerMap[U]

/** Extract the request body type for a given URI. */
export type InferredRequestType<U extends HandlerURIType> =
  HandlerMap[U] extends Handler<infer R, unknown> ? R : never

/** Extract the response type for a given URI. */
export type InferredResponseType<U extends HandlerURIType> =
  HandlerMap[U] extends Handler<unknown, infer T> ? T : never

/** Lift result envelope shape used by some legacy callers. */
export type JsonRPCResult<T extends {} = any> = {
  status: number
  body: T
  id: number
}
