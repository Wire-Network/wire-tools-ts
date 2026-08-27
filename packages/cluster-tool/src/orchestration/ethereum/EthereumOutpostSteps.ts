import Path from "node:path"
import { chunk, range } from "lodash"
import { KeyType } from "@wireio/sdk-core"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { BatchOperatorSchedule } from "../../config/BatchOperatorSchedule.js"
import { Report } from "../../report/Report.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { KeySteps } from "../steps/KeySteps.js"
import {
  EthereumOutpostBootstrapper,
  type EthereumOutpostGenesisRoster
} from "./EthereumOutpostBootstrapper.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"

/** Steps that deploy + seed the Ethereum (anvil) outpost. */
export namespace EthereumOutpostSteps {
  /** Subpath (under the cluster data dir) for the annotated accounts file. */
  const AnvilDataSubpath = "anvil"

  /**
   * Derive the WNE-41 genesis batch-operator roster the outpost is constructed
   * with — the ETH addresses of every bootstrapped batch operator, grouped the
   * way the depot's `schbatchgps` will group them.
   *
   * The addresses are DERIVED rather than read off provisioned operators
   * because the outpost deploys in **Cluster Prerequisites**, while the batch
   * operators are provisioned later in **Cluster Post Contract Deployment**.
   * The (mnemonic, HD index) pair is fully determined by then, and both sides
   * read it from the SAME two authorities — {@link KeySteps.ethereumMnemonic}
   * and {@link Constants.batchOperatorEthereumHdIndex} — so the roster cannot
   * disagree with the keys the daemons later sign `epochIn` with.
   *
   * `groups[0].length` is the outpost's consensus threshold, so the grouping is
   * sized by the depot's own `operators_per_epoch` from
   * {@link BatchOperatorSchedule.resolve}. Membership in the later groups grants
   * delivery rights without raising that threshold; the depot replaces the whole
   * roster with its real schedule on the first BATCH_OPERATOR_GROUPS
   * attestation.
   *
   * @param ctx - The build context.
   * @returns The genesis roster for `OPPInbound.initialize`.
   */
  export async function resolveGenesisRoster<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<EthereumOutpostGenesisRoster> {
    const { config } = ctx,
      { operatorsPerEpoch } = BatchOperatorSchedule.resolve(config),
      keyContext = KeyGenerator.context(
        config.executables.clio,
        config.buildPath,
        KeySteps.ethereumMnemonic(ctx)
      ),
      addresses = await mapSeries(
        range(config.batchOperatorCount),
        async index =>
          (
            await KeyGenerator.create(KeyType.EM, keyContext, {
              ethereumHdIndex: Constants.batchOperatorEthereumHdIndex(index),
              purpose: "ethereum-outpost genesis batch-operator roster"
            })
          ).address
      )
    return {
      groups: chunk(addresses, operatorsPerEpoch),
      epochDurationSec: config.epochDurationSec
    }
  }

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
      genesisRoster: await resolveGenesisRoster(ctx)
    }).bootstrap()
  }
}
