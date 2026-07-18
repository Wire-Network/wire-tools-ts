/**
 * On-disk filenames for a cluster directory. The TUI and any other
 * out-of-process tooling read these to discover a cluster's config and
 * runtime state.
 */
export namespace ClusterFiles {
  /** Resolved cluster config written by `wire-cluster-tool create`. */
  export const ConfigFilename = "cluster-config.json" as const
  /** Serialized cluster state written after bootstrap. */
  export const StateFilename = "cluster-state.json" as const
  /**
   * Serialized `ClusterKeyStore` (per-node key sets + provisioned operator
   * accounts), written 0600. `cluster-tool`-private — NEVER served over the
   * debugging-server RPC surface.
   */
  export const KeysFilename = "cluster-keys.json" as const
}
