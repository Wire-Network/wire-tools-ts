import { KiodProcess } from "../../../cluster/processes/KiodProcess.js"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"

/** Steps that manage the cluster's kiod (wallet daemon) process. */
export namespace KiodProcessSteps {
  /** Start kiod (get-or-create from `ctx.processManager`). Idempotent. */
  export function start<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runStart)
  }

  /** Named runner — get-or-create the {@link KiodProcess} and start it. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.processManager.get(KiodProcess.ProcessLabel) != null) return
    const kiod = await KiodProcess.create(ctx.processManager, {
      binary: ctx.config.executables.kiod,
      walletPath: ctx.config.walletPath,
      port: ctx.config.bind.kiod.port
    })
    await kiod.start()
  }
}
