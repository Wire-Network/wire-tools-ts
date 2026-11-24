import { SysioContracts } from "@wireio/sdk-core"
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
  /**
   * `sysio.msgch::bootstrap` — the network bootstrap: the genesis advance (epoch 0 → 1) of
   * every active outpost chain, each starting its own consensus epoch 1.
   */
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

  /** Input for {@link planBootchain} — the generated `msgch::bootchain` data. */
  export interface BootchainInput extends StepInput {
    readonly kind: "MsgchContractSteps.BootchainInput"
    /** The action data: the outpost chain whose genesis advance runs. */
    readonly data: SysioContracts.SysioMsgchBootchainAction
  }

  /**
   * `sysio.msgch::bootchain` — the genesis advance of one outpost chain activated after the
   * network genesis, so it starts its own consensus epoch 1. Refused before the network
   * genesis and once the chain's epoch has started.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain to start.
   * @returns The `sysio.msgch` step.
   */
  export function planBootchain<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsgchBootchainAction
  ): ClusterBuildStep<C, BootchainInput> {
    return ClusterBuildStep.create<C, BootchainInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsgchContractSteps.BootchainInput", data },
      runBootchain
    )
  }

  /** Named runner — `sysio.msgch::bootchain` for the input's chain. */
  export async function runBootchain<C extends ClusterBuildContext>(
    ctx: C,
    input: BootchainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .actions.bootchain.invoke(input.data)
  }

  /** Input for {@link planChkcons} — the generated `msgch::chkcons` data. */
  export interface ChkconsInput extends StepInput {
    readonly kind: "MsgchContractSteps.ChkconsInput"
    /** The action data: the outpost chain whose envelope consensus is cranked. */
    readonly data: SysioContracts.SysioMsgchChkconsAction
  }

  /**
   * `sysio.msgch::chkcons` — crank one outpost chain's envelope consensus: advances that
   * chain's epoch once its outpost has consensus and its boundary has passed.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain to crank.
   * @returns The `sysio.msgch` step.
   */
  export function planChkcons<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioMsgchChkconsAction
  ): ClusterBuildStep<C, ChkconsInput> {
    return ClusterBuildStep.create<C, ChkconsInput>(
      actor,
      name,
      description,
      options,
      { kind: "MsgchContractSteps.ChkconsInput", data },
      runChkcons
    )
  }

  /** Named runner — `sysio.msgch::chkcons` for the input's chain (waits for finality so
   *  repeated cranks don't collide on a shared TAPOS reference). */
  export async function runChkcons<C extends ClusterBuildContext>(
    ctx: C,
    input: ChkconsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.msgch).actions.chkcons.invoke(input.data)
  }
}
