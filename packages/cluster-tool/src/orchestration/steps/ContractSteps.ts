import Assert from "node:assert"
import Path from "node:path"
import { match } from "ts-pattern"
import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../report/Report.js"
import { WireSysioContractTool } from "../../tools/wire/WireSysioContractTool.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { ContractArtifactResolver } from "../ContractArtifactResolver.js"
import type { StepInput } from "../StepRunner.js"

/** Steps that deploy system contracts. */
export namespace ContractSteps {
  /** How a contract is deployed. */
  export enum DeployMode {
    /** Raw `set contract` (setcode+setabi billed to the account) — bios/system/roa,
     *  deployed before ROA is active. */
    raw = "raw",
    /** Production `sysio.roa::setsyscode`/`setsysabi` (privileged, RAM-gifted). */
    system = "system"
  }

  /** Input for {@link planDeploy}. */
  export interface DeployInput extends StepInput {
    readonly kind: "ContractSteps.DeployInput"
    readonly contract: SysioContracts.SysioContractName
    readonly mode: DeployMode
  }

  /**
   * Deploy a system contract. `mode` selects the raw vs production path (default
   * production); the artifacts are resolved from `ctx.config.buildPath`.
   */
  export function planDeploy<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    contract: SysioContracts.SysioContractName,
    mode: DeployMode = DeployMode.system
  ): ClusterBuildStep<C, DeployInput> {
    return ClusterBuildStep.create<C, DeployInput>(
      actor,
      name,
      description,
      options,
      { kind: "ContractSteps.DeployInput", contract, mode },
      runDeploy
    )
  }

  /** Named runner — resolve artifacts, deploy via the selected path. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    input: DeployInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const resolver = new ContractArtifactResolver(ctx.config.buildPath)
    Assert.ok(
      resolver.exists(input.contract),
      `Contract artifacts missing for sysio.${input.contract} under ${ctx.config.buildPath}`
    )
    const artifact = resolver.resolve(input.contract)
    await match(input.mode)
      .with(DeployMode.raw, () =>
        ctx.wire.setContract(
          artifact.account,
          Path.dirname(artifact.wasm),
          artifact.wasm,
          artifact.abi
        )
      )
      .with(DeployMode.system, () =>
        new WireSysioContractTool(ctx.wire).deploySystemContract(
          artifact.account,
          artifact.wasm,
          artifact.abi
        )
      )
      .exhaustive()
  }

  /** Input for {@link planGrantSysioCode}. */
  export interface GrantSysioCodeInput extends StepInput {
    readonly kind: "ContractSteps.GrantSysioCodeInput"
    readonly account: string
  }

  /**
   * Grant `account` its own `@sysio.code` permission so it can inline-send its
   * own actions (epoch advance, evalcons, dispatch, …), kept governed by
   * `sysio@active`.
   */
  export function planGrantSysioCode<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, GrantSysioCodeInput> {
    return ClusterBuildStep.create<C, GrantSysioCodeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ContractSteps.GrantSysioCodeInput", account },
      runGrantSysioCode
    )
  }

  /** Named runner — `WireSysioContractTool.grantSysioCode`. */
  export async function runGrantSysioCode<C extends ClusterBuildContext>(
    ctx: C,
    input: GrantSysioCodeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await new WireSysioContractTool(ctx.wire).grantSysioCode(input.account)
  }
}
