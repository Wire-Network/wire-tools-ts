import Assert from "node:assert"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Report } from "../../report/Report.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { EthereumOutpostBootstrapper } from "./EthereumOutpostBootstrapper.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { OperatorAccount } from "../outputs/OperatorAccount.js"
import { EpochContractSteps } from "../steps/contracts/sysio/EpochContractSteps.js"

/** Steps that deploy + seed the Ethereum (anvil) outpost. */
export namespace EthereumOutpostSteps {
  /** Subpath (under the cluster data dir) for the annotated accounts file. */
  const AnvilDataSubpath = "anvil"

  /**
   * Deploy the Ethereum outpost against the already-running run anvil
   * (`Steps.processes.anvil.start` must precede this in the phase): deploy the
   * `wire-ethereum` contracts, seed the ReserveManager, and write the annotated
   * accounts file (later phases re-read `accounts.json` / `outpost-addrs.json`
   * from disk). Input-less — paths + the anvil port come from `ctx.config`.
   */
  export function planDeploy<
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
      runDeploy
    )
  }

  /** Named runner — `EthereumOutpostBootstrapper.bootstrap` against the run anvil. */
  export async function runDeploy<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epochState = await EpochContractSteps.readEpochState(ctx)
    Assert.ok(
      epochState?.batch_op_groups?.length > 0,
      "runDeploy: initial batch-operator schedule is empty"
    )
    const initialOperatorGroups = resolveInitialOperatorGroups(
      ctx.keyStore.operatorsByType(OperatorType.BATCH),
      epochState.batch_op_groups
    )
    // Same derivation as AnvilProcess.rpcUrl — the run anvil was bound to this
    // exact port by Steps.processes.anvil.start, so they cannot diverge.
    await new EthereumOutpostBootstrapper({
      ethereumPath: ctx.config.ethereumPath,
      anvilDataPath: Path.join(ctx.config.dataPath, AnvilDataSubpath),
      rpcUrl: toURL(
        ctx.config.bind.anvil.port,
        toDialAddress(ctx.config.bind.anvil.address)
      ),
      deploymentsPath: ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      initialOperatorGroups,
      initialActiveGroupIndex: epochState.current_batch_op_group,
      epochDurationSec: ctx.config.epochDurationSec
    }).bootstrap()
  }

  /**
   * Map the depot's materialized schedule to the exact Ethereum keys its
   * operator daemons use. Account names are generated during provisioning, so
   * this mapping must be resolved from the live key store after
   * `schbatchgps`; deriving it from labels or HD indexes can authorize the
   * wrong first-epoch signers.
   */
  export function resolveInitialOperatorGroups(
    batchOperators: OperatorAccount[],
    scheduleGroups: string[][]
  ): string[][] {
    Assert.ok(scheduleGroups.length > 0, "resolveInitialOperatorGroups: schedule is empty")
    const operatorByAccount = new Map(
      batchOperators.map(operator => [operator.account, operator])
    )
    return scheduleGroups.map((group, groupIndex) => {
      Assert.ok(
        group.length > 0,
        `resolveInitialOperatorGroups: schedule group ${groupIndex} is empty`
      )
      return group.map(accountName => {
        const operator = operatorByAccount.get(accountName)
        Assert.ok(
          operator,
          `resolveInitialOperatorGroups: schedule member ${accountName} not found among provisioned batch operators`
        )
        Assert.ok(
          operator.ethereum?.address,
          `resolveInitialOperatorGroups: schedule member ${accountName} has no Ethereum address`
        )
        return operator.ethereum.address
      })
    })
  }
}
