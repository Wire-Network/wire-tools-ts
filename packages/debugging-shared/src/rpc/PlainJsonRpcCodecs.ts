import type { SchemaCodec } from "@wireio/cluster-tool-shared"
import {
  GetClusterConfigResponseSchemaCodec,
  GetClusterStateResponseSchemaCodec
} from "../cluster/index.js"
import {
  LogReadResponseSchemaCodec,
  LogStatResponseSchemaCodec
} from "../logs/index.js"
import {
  GetProcessLivenessResponseSchemaCodec,
  ListProcessesResponseSchemaCodec
} from "../processes/index.js"
import { ApiPaths, type HandlerURIType } from "./Paths.js"

/**
 * Response codecs for the PLAIN-JSON RPC methods, keyed by method. The OPP
 * protobuf methods (and `LoadRecords`, which embeds decoded proto records) are
 * intentionally ABSENT — protobuf-ts validates those on `toJson`/`fromJson`
 * (never re-declared, per never-rewrap-generated-proto-types). `JsonRPCClient`
 * validates a plain-JSON `result` via the matching codec, closing the
 * `as InferredResponseType` cast gap; a method with no entry passes through.
 */
export const PlainJsonRpcResponseCodecs: Partial<
  Record<HandlerURIType, SchemaCodec<unknown>>
> = {
  [ApiPaths.Cluster.Methods.GetConfig]: GetClusterConfigResponseSchemaCodec,
  [ApiPaths.Cluster.Methods.GetState]: GetClusterStateResponseSchemaCodec,
  [ApiPaths.Processes.Methods.List]: ListProcessesResponseSchemaCodec,
  [ApiPaths.Processes.Methods.GetLiveness]:
    GetProcessLivenessResponseSchemaCodec,
  [ApiPaths.Logs.Methods.GetStat]: LogStatResponseSchemaCodec,
  [ApiPaths.Logs.Methods.Read]: LogReadResponseSchemaCodec
}
