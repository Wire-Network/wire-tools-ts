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
  destroy = "destroy"
}
