import type { ClusterConfig, ClusterState } from "@wireio/cluster-tool-shared"

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
