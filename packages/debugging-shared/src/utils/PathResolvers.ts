import Path from "node:path"

/**
 * Subpath segments under a `<cluster-path>` root that the harness uses for
 * runtime artifacts the debugging surface consumes.
 */
export namespace ClusterSubpath {
  /**
   * Where the `external_debugging_plugin` writes one
   * `<NN>-<DIRECTION>-<digest>.{data,metadata}` pair per emitted/received
   * envelope. The `data/` segment matches the harness's
   * `ClusterConfig.dataPath` convention.
   */
  export const OppDebugging = Path.join("data", "opp-debugging")
}

/**
 * Resolve the OPP debugging dump directory for a cluster. Mirrors the
 * directory the `external_debugging_plugin` writes to, the harness's
 * `ClusterManager.OPPDebuggingSubpath`, and the `OPPTrackingService.StorageSubpath`
 * the TUI used to derive locally — all three originate here now.
 */
export function oppDebuggingPath(clusterPath: string): string {
  return Path.join(clusterPath, ClusterSubpath.OppDebugging)
}

/**
 * `true` when `candidate` resolves underneath `root`. Both arguments are
 * resolved before comparison so symlinks and relative segments do not bypass
 * the check. Used by the server's log-reading routes to reject any path
 * outside the cluster directory it was started with.
 */
export function isPathUnder(candidate: string, root: string): boolean {
  const resolvedCandidate = Path.resolve(candidate),
    resolvedRoot = Path.resolve(root),
    rootWithSep = resolvedRoot.endsWith(Path.sep)
      ? resolvedRoot
      : resolvedRoot + Path.sep
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(rootWithSep)
  )
}
