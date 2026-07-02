import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.roa` (resource-owner allocation) actions. */
export namespace RoaContractSteps {
  /** Input for {@link activateroa} — the generated `roa::activateroa` data. */
  export interface ActivateroaInput extends StepInput {
    readonly kind: "RoaContractSteps.ActivateroaInput"
    readonly data: SysioContracts.SysioRoaActivateroaAction
  }

  /** `sysio.roa::activateroa` — activate ROA (seeds the sysio pool, makes sysio.* accounts finite). */
  export function activateroa<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioRoaActivateroaAction
  ): ClusterBuildStep<C, ActivateroaInput> {
    return ClusterBuildStep.create<C, ActivateroaInput>(
      actor,
      name,
      description,
      options,
      { kind: "RoaContractSteps.ActivateroaInput", data },
      runActivateroa
    )
  }

  /** Named runner — `sysio.roa::activateroa`. */
  export async function runActivateroa<C extends ClusterBuildContext>(
    ctx: C,
    input: ActivateroaInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.roa)
      .actions.activateroa.invoke(input.data)
  }

  /** Input for {@link newnameduser} — the generated `roa::newnameduser` data. */
  export interface NewnameduserInput extends StepInput {
    readonly kind: "RoaContractSteps.NewnameduserInput"
    readonly data: SysioContracts.SysioRoaNewnameduserAction
  }

  /**
   * `sysio.roa::newnameduser` — create a node-owner claim account with a
   * finite, pool-gifted RAM allocation (the create step the depot inline-sends
   * for a real NFT claim).
   */
  export function newnameduser<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioRoaNewnameduserAction
  ): ClusterBuildStep<C, NewnameduserInput> {
    return ClusterBuildStep.create<C, NewnameduserInput>(
      actor,
      name,
      description,
      options,
      { kind: "RoaContractSteps.NewnameduserInput", data },
      runNewnameduser
    )
  }

  /** Named runner — `sysio.roa::newnameduser`. */
  export async function runNewnameduser<C extends ClusterBuildContext>(
    ctx: C,
    input: NewnameduserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.roa)
      .actions.newnameduser.invoke(input.data)
  }

  /** Input for {@link nodeownreg} — the generated `roa::nodeownreg` data. */
  export interface NodeownregInput extends StepInput {
    readonly kind: "RoaContractSteps.NodeownregInput"
    readonly data: SysioContracts.SysioRoaNodeownregAction
  }

  /**
   * `sysio.roa::nodeownreg` — register a node owner at a tier (the production
   * claim path: records the ETH key as a `sysio.authex` link and allocates the
   * tier's ROA reserve, which policies are then issued from). Claim-payload
   * problems SOFT-FAIL into a `nodeownerreg` audit row rather than throwing —
   * follow with a verify step that asserts the `nodeowners` row exists.
   */
  export function nodeownreg<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioRoaNodeownregAction
  ): ClusterBuildStep<C, NodeownregInput> {
    return ClusterBuildStep.create<C, NodeownregInput>(
      actor,
      name,
      description,
      options,
      { kind: "RoaContractSteps.NodeownregInput", data },
      runNodeownreg
    )
  }

  /** Named runner — `sysio.roa::nodeownreg`. */
  export async function runNodeownreg<C extends ClusterBuildContext>(
    ctx: C,
    input: NodeownregInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.roa)
      .actions.nodeownreg.invoke(input.data)
  }
}
