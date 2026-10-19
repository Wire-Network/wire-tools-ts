import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.msgch` (message channel) actions. */
export namespace MsgchContractSteps {
  /** Input for {@link planDeliver} — the generated `msgch::deliver` data. */
  export interface DeliverInput extends StepInput {
    readonly kind: "MsgchContractSteps.DeliverInput"
    readonly data: SysioContracts.SysioMsgchDeliverAction
  }

  /** `sysio.msgch::deliver` — submit one batch-operator envelope. */
  export function planDeliver<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsgchDeliverAction
  ): ClusterBuildStep<C, DeliverInput> {
    return ClusterBuildStep.create<C, DeliverInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsgchContractSteps.DeliverInput", data },
      runDeliver
    )
  }

  /** Named runner — `sysio.msgch::deliver`, signed by the delivering operator. */
  export async function runDeliver<C extends ClusterBuildContext>(
    ctx: C,
    input: DeliverInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.deliver.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.batch_op_name)
      })
  }

  /** `sysio.msgch::bootstrap` — bootstrap the first epoch (epoch 0 → 1). */
  export function planBootstrap<
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
  export function planChkcons<
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
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.chkcons.invoke({})
  }
}
