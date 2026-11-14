import Assert from "node:assert"
import {
  SignatureProviderKeyPolicy,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import {
  BatchOperatorKeyTool,
  BatchOperatorPrefundingSteps as PrefundingSteps,
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterConfigProvider,
  Constants as HarnessConstants,
  FlowScenario,
  Report,
  SyndicationScenario,
  WireSyndicationTool,
  type ClusterBuild,
  type ClusterBuildOptions,
  type Logger
} from "@wireio/cluster-tool"
import { BatchOperatorPrefundingScenarioConstants as Constants } from "./BatchOperatorPrefundingScenarioConstants.js"
import { BatchOperatorPrefundingScenarioExports as Exports } from "./BatchOperatorPrefundingScenarioExports.js"

const { Actor } = Report

/**
 * The pre-funded launch, end to end, on a local KEY-custody cluster. Before the cluster is
 * composed, `prepare` pre-creates the three bootstrap batch operators' identities and
 * persists them by handle (the local twin of `create-batch-operator-keys`), freezes both
 * outposts' launch-data exports with each operator's positions keyed by its outpost keys,
 * and sets `batchOperatorKeyPolicy: adoptOnly`. The context seeds those identities into
 * its key store, so the bootstrap's `OperatorKeys` phase ADOPTS them, the import parks
 * each operator's positions under its keys, and the operators' own authex links sweep the
 * credit into their accounts; the bootstrap's `LcoImportOperatorCredit` verify records it.
 * The flow then checks the adoption, the links and the credit per operator, and proves the
 * point of pre-funding: an independent user's Ethereum syndication is bonded by a
 * pre-funded batch operator from its imported LIQETH within the first epochs, approved
 * after the challenge window and its bonds paid back.
 */
export class BatchOperatorPrefundingScenario extends FlowScenario {
  readonly name = "flow-batch-operator-prefunding"
  readonly description =
    "Pre-created batch-operator keys are adopted by the bootstrap, credited by the frozen launch-data import, and underwrite a user's Ethereum syndication from the first epochs"

  readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    enableBatchOperatorUnderwriting: true,
    lcoImport: Constants.LcoImport
  }

  /**
   * The pre-bootstrap stage: pre-create (or read back) every operator's identity under its
   * handle, write both exports from the committed templates with those keys in place of
   * the placeholders, point the bootstrap's import at them, and require the bootstrap to
   * ADOPT the pre-created keys — a missing one fails it rather than minting a replacement
   * the funding is not bound to.
   *
   * @param options - The resolved build options.
   * @returns The options the bootstrap composes with.
   */
  async prepare(options: ClusterBuildOptions): Promise<ClusterBuildOptions> {
    const { clusterPath, buildPath, batchOperatorCount } = options
    Assert.ok(
      clusterPath != null,
      "flow-batch-operator-prefunding: clusterPath must be resolved before the identities are persisted"
    )
    Assert.strictEqual(
      batchOperatorCount,
      Constants.BatchOperatorCount,
      `flow-batch-operator-prefunding: the templates pre-fund exactly ${Constants.BatchOperatorCount} batch operators`
    )
    const dataPath = ClusterConfigProvider.dataPath(clusterPath),
      operators = await Exports.createOperatorIdentities(dataPath, buildPath),
      { ethereum, solana } = Exports.writeExports(dataPath, operators)
    return {
      ...options,
      ethereumBootstrapJsonFile: ethereum,
      solanaBootstrapJsonFile: solana,
      signatureProvider: {
        ...options.signatureProvider,
        batchOperatorKeyPolicy: SignatureProviderKeyPolicy.adoptOnly
      }
    }
  }

  /**
   * The run's context, its key store pre-seeded with the persisted identities so the
   * bootstrap's `OperatorKeys` phase adopts them whole
   * (`WireOperatorProvisioningTool.runIdentityMaterialization`). A handle `prepare` did not
   * persist fails here, before anything is composed.
   *
   * @param config - The resolved cluster config.
   * @param log - The run logger.
   * @returns The seeded context.
   */
  createContext(config: ClusterConfig, log: Logger): ClusterBuildContext {
    const context = new ClusterBuildContext(config, log)
    BatchOperatorKeyTool.loadPersisted(
      config.dataPath,
      HarnessConstants.batchOperatorLabels(config.batchOperatorCount)
    ).forEach(operator => context.keyStore.setOperator(operator))
    return context
  }

  plan(cluster: ClusterBuild): void {
    const labels = HarnessConstants.batchOperatorLabels(
        cluster.config.batchOperatorCount
      ),
      plan = Constants.Plan

    // ── 1. The bootstrap adopted the pre-created identities ──
    PrefundingSteps.planVerifyAdoptedIdentities(
      cluster,
      "PrefundedIdentities",
      "Every batch operator's keys are the ones pre-created before the cluster existed",
      {},
      labels
    )

    // ── 2. Both outpost keys are linked to each operator's account ──
    PrefundingSteps.planVerifyAuthexLinks(
      cluster,
      "PrefundedOperatorLinks",
      "Every batch operator's Ethereum and Solana keys are linked to its account",
      {},
      labels
    )

    // ── 3. Each operator holds the credit its frozen positions carried ──
    PrefundingSteps.planVerifyShadowCredits(
      cluster,
      "PrefundedOperatorCredits",
      "Every batch operator holds LIQETH and LIQSOL from its frozen positions",
      {},
      labels,
      PrefundingSteps.PrefundedTokenCodes
    )

    // ── 4. The stimulus: an independent user syndicates liqETH ──
    UnderwritingSteps.planEthereumSyndication(
      cluster,
      "EthereumSyndication",
      "An independent user acquires liqETH and syndicates it to its linked WIRE account",
      Constants.Syndicator
    )

    // ── 5. The point of pre-funding: a pre-funded operator bonds it from its imported credit ──
    ClusterBuildPhase.create(
      cluster,
      "PrefundedUnderwriting",
      "A pre-funded batch operator bonds the user's syndication within the first epochs; the request is approved and its bonds paid back"
    ).push(
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "ethereum-requested",
        "the Ethereum envelope gets its request from the operators' crank, without a flow crank",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.amount,
        null,
        plan.firstEpoch,
        plan.firstRequest,
        Constants.Chain,
        Constants.Token
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "ethereum-bonded",
        "pre-funded batch operators bond the whole coverage from their imported LIQETH, within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.firstRequest,
        Constants.Token
      ),
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "ethereum-approved-and-claimed",
        "the operators approve after the challenge window and claim their capital back",
        SyndicationScenario.VerifyOptions,
        plan.firstRequest
      )
    )

    // ── 6. Healthy: no cord pulled, no custody mismatch ──
    ClusterBuildPhase.create(
      cluster,
      "PrefundedHealthy",
      "No solvency check pulled the cord or recorded a mismatch"
    ).push(
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "verify-prefunded-healthy",
        "the emergency cord is clear and sysio.synd records no custody mismatch",
        {}
      )
    )
  }
}
