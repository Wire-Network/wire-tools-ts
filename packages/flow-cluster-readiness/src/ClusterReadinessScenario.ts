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
  readonly name = "flow-cluster-readiness"
  readonly description =
    "Bootstrap a swap-capable cluster and collect read-only readiness evidence"

  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true
  }

  override createContext(
    config: ReadinessContextConstructor[0],
    contextLog: ReadinessContextConstructor[1]
  ): ClusterReadinessFlowContext {
    return new ClusterReadinessFlowContext(config, contextLog)
  }

  override plan(cluster: ClusterBuild<ClusterReadinessFlowContext>): void {
    ReadinessPhaseGroups.plan(cluster)
  }
}
