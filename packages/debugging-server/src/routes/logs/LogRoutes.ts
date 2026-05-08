import {
  ApiPaths,
  buildLineIndex,
  isPathUnder,
  readLines,
  type LogReadRequest,
  type LogReadResponse,
  type LogStat,
  type LogStatRequest
} from "@wireio/debugging-shared"

import { JsonRPC } from "../../JsonRPC.js"

/**
 * Register the log-read JSON-RPC handlers (`Logs.GetStat`, `Logs.Read`).
 *
 * Both routes validate that the requested `path` resolves underneath
 * `clusterPath` before reading — without this check, a remote client
 * could traverse the server's filesystem at will.
 */
export namespace LogRoutes {
  /**
   * @param registry    Mutable registry to populate.
   * @param clusterPath Cluster root used as the path-traversal anchor.
   * @returns The same `registry` instance for fluent chaining.
   */
  export function register(
    registry: JsonRPC.HandlerRegistry,
    clusterPath: string
  ): JsonRPC.HandlerRegistry {
    JsonRPC.addRoute(
      registry,
      ApiPaths.Logs.Methods.GetStat,
      async (params: LogStatRequest): Promise<LogStat> => {
        assertUnderClusterPath(params.path, clusterPath)
        const idx = await buildLineIndex(params.path)
        return {
          path: idx.path,
          ino: idx.ino,
          totalBytes: idx.totalBytes,
          totalLines: idx.completeLineCount
        }
      }
    )

    JsonRPC.addRoute(
      registry,
      ApiPaths.Logs.Methods.Read,
      async (params: LogReadRequest): Promise<LogReadResponse> => {
        assertUnderClusterPath(params.path, clusterPath)
        const idx = await buildLineIndex(params.path),
          lines = await readLines(idx, params.fromLine, params.count)
        return { lines }
      }
    )

    return registry
  }
}

/** Reject any path that isn't contained under `clusterPath`. */
function assertUnderClusterPath(path: string, clusterPath: string): void {
  if (!isPathUnder(path, clusterPath)) {
    throw new Error(
      `Path traversal rejected: ${path} is not under ${clusterPath}`
    )
  }
}
