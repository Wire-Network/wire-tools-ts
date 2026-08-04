import Path from "node:path"
import { AnvilProcess } from "../../../cluster/processes/AnvilProcess.js"
import { Report } from "../../../report/Report.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"

/** Steps that manage the cluster's run-time anvil (Ethereum) process. */
export namespace AnvilProcessSteps {
  /**
   * Start the run-time anvil (get-or-create from `ctx.processManager`). It starts
   * in **instamine** mode (no `--block-time`) so the Hardhat outpost deploy — which
   * depends on instant mining — succeeds; {@link planEnableIntervalMining} switches it
   * to interval mining afterward. Idempotent: a no-op if the anvil is already up.
   */
  export function planStart<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runStart)
  }

  /** Named runner — get-or-create the {@link AnvilProcess} and start it. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (ctx.processManager.get(AnvilProcess.ProcessLabel) != null) return
    const anvil = await AnvilProcess.create(ctx.processManager, {
      host: ctx.config.bind.anvil.address,
      port: ctx.config.bind.anvil.port,
      chainId: AnvilProcess.DefaultChainId,
      stateFile: Path.join(
        ctx.config.dataPath,
        AnvilProcess.StateSubpath,
        AnvilProcess.StateFilename
      )
    })
    await anvil.start()
  }

  /**
   * Switch the running anvil from instamine to interval mining (`block-time`),
   * emulating Ethereum finality for the flow tests. Run AFTER the outpost deploy.
   */
  export function planEnableIntervalMining<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runEnableIntervalMining
    )
  }

  /** Named runner — `evm_setIntervalMining` to the configured block time. */
  export async function runEnableIntervalMining<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.ethereum.provider.send("evm_setIntervalMining", [AnvilProcess.BlockTimeSec])
  }
}
