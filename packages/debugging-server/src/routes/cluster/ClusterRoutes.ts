import { ApiPaths } from "@wireio/debugging-shared"

import { JsonRPC } from "../../JsonRPC.js"
import type { ClusterAccess } from "../../services/ClusterAccess.js"

/**
 * Register the cluster-info JSON-RPC handlers (`Cluster.GetConfig`,
 * `Cluster.GetState`) on the given registry. Bodies are plain JSON —
 * no protobuf — so the unified dispatch in `JsonRPC.mount` skips the
 * `MessageType` round-trip for these methods.
 */
export namespace ClusterRoutes {
  /**
   * @param registry      Mutable registry to populate.
   * @param clusterAccess Source-of-truth for `cluster-config.json` and
   *                      `cluster-state.json`.
   * @returns The same `registry` instance for fluent chaining.
   */
  export function register(
    registry: JsonRPC.HandlerRegistry,
    clusterAccess: ClusterAccess
  ): JsonRPC.HandlerRegistry {
    JsonRPC.addRoute(
      registry,
      ApiPaths.Cluster.Methods.GetConfig,
      async () => {
        return clusterAccess.getConfig()
      }
    )
    JsonRPC.addRoute(
      registry,
      ApiPaths.Cluster.Methods.GetState,
      async () => {
        const state = await clusterAccess.getState()
        return { state }
      }
    )
    return registry
  }
}
