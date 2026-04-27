import type { ClusterConfig } from "@wire-e2e-tests/debugging-shared"

/**
 * Caller-supplied config for {@link FlowTestContext}. Field requirements
 * depend on the {@link FlowMode} resolved at construction time.
 */
export type ClusterOptions = Partial<ClusterConfig> & {
  /**
   * Path to the `cluster-config.json` written by `wire-test-cluster create`.
   * Required (implicitly or via `WIRE_CLUSTER_CONFIG`) when running in
   * `Attach` mode; ignored in `Fresh` mode.
   */
  clusterConfigPath?: string

  force?: boolean
}
