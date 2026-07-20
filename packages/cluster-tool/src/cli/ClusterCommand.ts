/**
 * The `wire-cluster-tool` CLI's command names — an identity string enum
 * (value === key, per the WIRE string-enum convention) so each member doubles
 * as both the literal yargs command name AND a rename-safe identifier
 * everywhere else (function arguments, object keys, comparisons). Per
 * STYLE.md's "Framework-Native Dispatch": every `.command(...)` call passes
 * one of these members directly, never a raw string literal.
 */
export enum ClusterCommand {
  /** Create + bootstrap a new cluster from scratch. */
  create = "create",
  /** Start an existing cluster (produced by {@link ClusterCommand.create}) from saved state. */
  run = "run",
  /** Stop every daemon and delete a cluster's data directory. */
  destroy = "destroy",
  /** Package each node's config tree into a per-node archive (post-`create`). */
  package = "package",
  /**
   * Clone a created local cluster into a deployable external cluster directory
   * (external `BindConfig` merged in) + emit its `ExternalClusterConfig`. Quoted
   * member — access via `ClusterCommand["create-external-config"]` (the hyphen
   * is not a valid identifier), value === key like every other member.
   */
  "create-external-config" = "create-external-config"
}
