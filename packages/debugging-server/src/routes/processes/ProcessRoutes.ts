import {
  ApiPaths,
  collectPidSources,
  pidIsAlive,
  readPid,
  type GetProcessLivenessRequest,
  type GetProcessLivenessResponse,
  type ListProcessesRequest,
  type ListProcessesResponse,
  type ProcessLivenessSnapshot
} from "@wireio/debugging-shared"

import { JsonRPC } from "../../JsonRPC.js"
import type { ClusterAccess } from "../../services/ClusterAccess.js"

/**
 * Register the process-monitor JSON-RPC handlers (`Processes.List`,
 * `Processes.GetLiveness`).
 *
 * `List` re-runs the pid-file scan on every call — the harness's pid
 * directory layout doesn't change frequently enough to warrant caching,
 * and process lifecycles can change between two consecutive calls.
 *
 * `GetLiveness` reads pid files and probes liveness via `process.kill(pid, 0)`.
 * The server is expected to run on the same host as the cluster, so the
 * kernel probe is meaningful (it would not be over a remote shell).
 */
export namespace ProcessRoutes {
  /**
   * @param registry      Mutable registry to populate.
   * @param clusterAccess Source-of-truth for cluster state (used to drive
   *                      `collectPidSources`).
   * @returns The same `registry` instance for fluent chaining.
   */
  export function register(
    registry: JsonRPC.HandlerRegistry,
    clusterAccess: ClusterAccess
  ): JsonRPC.HandlerRegistry {
    JsonRPC.addRoute(
      registry,
      ApiPaths.Processes.Methods.List,
      async (_params: ListProcessesRequest): Promise<ListProcessesResponse> => {
        const state = await clusterAccess.getState(),
          sources = collectPidSources(clusterAccess.clusterPath, state)
        return { sources }
      }
    )

    JsonRPC.addRoute(
      registry,
      ApiPaths.Processes.Methods.GetLiveness,
      async (
        params: GetProcessLivenessRequest
      ): Promise<GetProcessLivenessResponse> => {
        const state = await clusterAccess.getState(),
          allSources = collectPidSources(clusterAccess.clusterPath, state),
          filtered =
            params.labels.length === 0
              ? allSources
              : allSources.filter(s => params.labels.includes(s.label)),
          now = Date.now()
        const snapshots: ProcessLivenessSnapshot[] = filtered.map(src => {
          const pid = readPid(src.pidPath),
            alive = pidIsAlive(pid)
          return {
            label: src.label,
            pid,
            alive,
            lastCheckedAt: now,
            exitedAt: alive ? null : now
          }
        })
        return { snapshots }
      }
    )

    return registry
  }
}
