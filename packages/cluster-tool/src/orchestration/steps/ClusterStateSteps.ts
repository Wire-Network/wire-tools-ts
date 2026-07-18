import { getLogger } from "../../logging/Logger.js"
import { ClusterState } from "../../cluster/ClusterState.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"

const log = getLogger(__filename)

/**
 * Steps that persist the finished build's post-bootstrap state + key
 * material to disk: `cluster-state.json` (secret-free topology snapshot) and
 * `cluster-keys.json` (0600, node key sets + every provisioned operator
 * account). The LAST phase of `ClusterManager.create` — once this runs,
 * `wire-cluster-tool run` can relaunch the cluster from disk.
 */
export namespace ClusterStateSteps {
  /**
   * Persist `cluster-state.json` + `cluster-keys.json` from the build's
   * current context (`ctx.keyStore` must already hold every provisioned
   * account — this step runs after every provisioning phase).
   *
   * @param actor - The Report actor the step is attributed to.
   * @param name - The step's Report name.
   * @param description - The step's Report description.
   * @param options - Step execution options (timeouts, retries).
   * @returns The persist step (input-less; runner: {@link runPersist}).
   */
  export function planPersist<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runPersist
    )
  }

  /**
   * Named runner for {@link planPersist} — capture + save both files.
   *
   * @param ctx - The build context (config + keyStore + outputs).
   * @param _input - Unused (the step is input-less).
   * @param signal - The step's abort signal.
   */
  export async function runPersist<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = ClusterState.capture(ctx),
      keys = ClusterState.captureKeys(ctx)
    ClusterState.save(ctx.config, state)
    ClusterState.saveKeys(ctx.config, keys)
    log.info(
      `[cluster-state] persisted ${ClusterState.stateFilePath(ctx.config)} + ${ClusterState.keysFilePath(ctx.config)}`
    )
  }
}
