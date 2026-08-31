import {
  ClusterReadinessFlowContext,
  FlowScenario,
  ReadinessPhaseGroups,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

type ReadinessContextConstructor = ConstructorParameters<
  typeof ClusterReadinessFlowContext
>

/** Bootstrap a representative swap cluster, then run the reusable read-only readiness suite. */
export class ClusterReadinessScenario extends FlowScenario<ClusterReadinessFlowContext> {
  /** Canonical flow package and report name. */
  readonly name = "flow-cluster-readiness"
  /** Human-readable purpose shown by the flow runner. */
  readonly description =
    "Bootstrap a swap-capable cluster and collect read-only readiness evidence"

  /** Bootstrap defaults required to exercise public swap routes. */
  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true
  }

  /**
   * Create the flow context used by bootstrap and readiness phases.
   *
   * @param config - Resolved cluster configuration produced by FlowCLI.
   * @param contextLog - Per-run orchestration logger.
   * @returns A readiness-capable cluster build context.
   */
  override createContext(
    config: ReadinessContextConstructor[0],
    contextLog: ReadinessContextConstructor[1]
  ): ClusterReadinessFlowContext {
    return new ClusterReadinessFlowContext(config, contextLog)
  }

  /**
   * Append the reusable read-only readiness PhaseGroup after bootstrap.
   *
   * @param cluster - Flow build receiving readiness phases.
   * @returns Nothing.
   */
  override plan(cluster: ClusterBuild<ClusterReadinessFlowContext>): void {
    ReadinessPhaseGroups.plan(cluster)
  }
}
