import {
  ClusterConfigSchema,
  ClusterStateSchema,
  SchemaCodec,
  type ClusterConfig,
  type ClusterState
} from "@wireio/cluster-tool-shared"
import { z } from "zod"

/** Empty request body for `Cluster.GetConfig`. */
export interface GetClusterConfigRequest {}

/** Response body for `Cluster.GetConfig`. */
export type GetClusterConfigResponse = ClusterConfig

/** Empty request body for `Cluster.GetState`. */
export interface GetClusterStateRequest {}

/** Response body for `Cluster.GetState`. `state` is `null` when the cluster has not bootstrapped yet (no `cluster-state.json` on disk). */
export interface GetClusterStateResponse {
  state: ClusterState | null
}

// ---------------------------------------------------------------------------
//  Zod schemas + codecs — the responses REUSE the existing ClusterConfig /
//  ClusterState schemas (never re-declared).
// ---------------------------------------------------------------------------

/** Schema for {@link GetClusterConfigRequest} (empty body). */
export const GetClusterConfigRequestSchema = z.object({})
/** Codec for the `Cluster.GetConfig` request body. */
export const GetClusterConfigRequestSchemaCodec =
  SchemaCodec.create<GetClusterConfigRequest>(GetClusterConfigRequestSchema)

/** Codec for the `Cluster.GetConfig` response body (= the shared `ClusterConfig`). */
export const GetClusterConfigResponseSchemaCodec =
  SchemaCodec.create<GetClusterConfigResponse>(ClusterConfigSchema)

/** Schema for {@link GetClusterStateRequest} (empty body). */
export const GetClusterStateRequestSchema = z.object({})
/** Codec for the `Cluster.GetState` request body. */
export const GetClusterStateRequestSchemaCodec =
  SchemaCodec.create<GetClusterStateRequest>(GetClusterStateRequestSchema)

/** Schema for {@link GetClusterStateResponse} — wraps the shared nullable `ClusterState`. */
export const GetClusterStateResponseSchema = z.object({
  state: ClusterStateSchema.nullable()
})
/** Codec for the `Cluster.GetState` response body. (Generic inferred — the
 *  nullable `state` infers optional under strictNullChecks-off, which the
 *  explicit interface generic would reject.) */
export const GetClusterStateResponseSchemaCodec = SchemaCodec.create(
  GetClusterStateResponseSchema
)
