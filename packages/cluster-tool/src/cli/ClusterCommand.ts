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
  "create-external-config" = "create-external-config",
  /**
   * Generate a standalone (non-cluster) API node's `config.ini` + `start.sh`
   * into an output directory. Quoted member — access via
   * `ClusterCommand["create-api-node"]` (the hyphen is not a valid identifier),
   * value === key like every other member.
   */
  "create-api-node" = "create-api-node",
  /**
   * Pre-create (adopt-or-create + publish) the batch operators' signing keys in
   * a cluster's AWS custody store — SSM parameters and KMS keys — ahead of the
   * cluster, so they can be pre-funded on the outposts before launch. Quoted
   * member like the two above; value === key.
   */
  "create-batch-operator-keys" = "create-batch-operator-keys",
  /**
   * Fund the pre-created batch operators on both deployed outposts — adopt
   * their keys (adopt-only), check each balance covers stake + reserve, and
   * stake the configured amount so the launch snapshot carries their
   * positions. Cluster-less like `create-batch-operator-keys`. Quoted member;
   * value === key.
   */
  "fund-batch-operators" = "fund-batch-operators"
}
