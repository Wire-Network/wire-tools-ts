import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.msgch` (message channel) actions. */
export namespace MsgchContractSteps {
  /** `sysio.msgch::bootstrap` — bootstrap the first epoch (epoch 0 → 1). */
  export function planBootstrap<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runBootstrap
    )
  }

  /** Named runner — `sysio.msgch::bootstrap` (empty payload). */
  export async function runBootstrap<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.bootstrap.invoke({})
  }

  /** `sysio.msgch::chkcons` — crank depot envelope consensus. */
  export function planChkcons<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runChkcons
    )
  }

  /** Named runner — `sysio.msgch::chkcons` (empty payload; waits for finality so
   *  repeated cranks don't collide on a shared TAPOS reference). */
  export async function runChkcons<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.msgch).actions.chkcons.invoke({})
  }
}
