import Assert from "node:assert"
import { EthereumDeploymentKind } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  EthereumLadderImportKey,
  FlowScenario,
  Report,
  Steps,
  SyndicationScenario,
  WireSyndicationTool,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { EthereumGoLiveScenarioConstants as Constants } from "./EthereumGoLiveScenarioConstants.js"

const { Actor } = Report
const { SysioSyndChainkind } = SysioContracts

/**
 * The pre-launch Ethereum outpost taken live. The bootstrap does the heavy
 * lifting (`ethereumDeployment: ladder`): the ladder, the pre-launch use, the
 * freeze, the capital-index import into the depot, the go-live. The flow then
 * proves what the launch depends on — the pool, the depot and the booked
 * figure agree, every frozen position is parked against its staker's key —
 * and sweeps one position to its owner's freshly linked WIRE account.
 */
export class EthereumGoLiveScenario extends FlowScenario {
  readonly name = "ethereum-go-live"
  readonly description =
    "The pre-launch Ethereum outpost taken live: ladder, freeze, capital-index import, go-live, then a frozen position swept to its linked account"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    ethereumDeployment: EthereumDeploymentKind.ladder
  }

  plan(cluster: ClusterBuild): void {
    const writeStepOptions = { timeoutMs: Constants.WriteTimeoutMs }

    // ── 1. The launch reconciliation ──
    ClusterBuildPhase.create(
      cluster,
      "GoLiveReconciliation",
      "The pool's principal, the depot's outstanding and the booked figure agree; every imported position is parked"
    ).push(
      verifyStep(
        Actor.Sysio,
        "pool-depot-booked-agree",
        "SyndicationPool.syndicatedPrincipal == depot outstanding LIQETH == the frozen Depositor's lastPoolLiqBalance",
        Steps.ethereumLadderImport.assertPoolSeededFromBooked
      ),
      verifyStep(
        Actor.Sysio,
        "imported-positions-parked",
        "each staker's credit sits in sysio.synd::parked against the pubkey capital-index recovered",
        EthereumGoLiveScenario.assertCreditsParked
      )
    )

    // ── 2. One frozen position swept to its owner ──
    ClusterBuildPhase.create(
      cluster,
      "SweepImportedPosition",
      "The first staker provisions a WIRE account, links its Ethereum key, and the parked credit lands as its LIQETH"
    ).push(
      Steps.user.planProvisionWire(
        Actor.User,
        "provision-staker-account",
        `create ${Constants.StakerAccount}, the frozen staker's WIRE account`,
        writeStepOptions,
        Constants.StakerAccount,
        0n
      ),
      Steps.ethereumLadderImport.planLinkActor(
        Actor.User,
        "link-staker-ethereum-key",
        "sysio.authex::createlink with the staker's own Ethereum key — the sweep's trigger",
        writeStepOptions,
        Constants.SweptStakerIndex,
        Constants.StakerAccount
      ),
      verifyStep(
        Actor.Sysio,
        "parked-credit-swept",
        "the parked row is gone and the account's LIQETH balance is the imported credit",
        EthereumGoLiveScenario.assertCreditSwept,
        { timeoutMs: Constants.SweepTimeoutMs }
      )
    )
  }

  /** Every imported credit has its parked row, with the imported balance. */
  static async assertCreditsParked(ctx: ClusterBuildContext): Promise<void> {
    const { credits } = ctx.outputs.assert(EthereumLadderImportKey)
    Assert.ok(credits.length > 0, "the ladder import yielded no credits")
    for (const credit of credits) {
      const row = await WireSyndicationTool.readParked(
        ctx,
        Constants.LiqTokenCodename,
        SysioSyndChainkind.CHAIN_KIND_EVM,
        credit.pubkey
      )
      Assert.ok(row, `no parked row for pubkey ${credit.pubkey}`)
      Assert.strictEqual(
        BigInt(row.balance),
        BigInt(credit.amount),
        `parked balance for ${credit.pubkey} is not the imported credit`
      )
    }
  }

  /** The swept staker's parked row is gone and its account holds the credit. */
  static async assertCreditSwept(ctx: ClusterBuildContext): Promise<void> {
    const credit = EthereumGoLiveScenario.sweptCredit(ctx)
    await pollUntil(
      "the parked credit sweeps into the linked account",
      async () =>
        (await WireSyndicationTool.readParked(
          ctx,
          Constants.LiqTokenCodename,
          SysioSyndChainkind.CHAIN_KIND_EVM,
          credit.pubkey
        )) == null &&
        (await SyndicationScenario.readBalance(
          ctx,
          Constants.StakerAccount,
          Constants.LiqTokenCodename
        )) === BigInt(credit.amount),
      Constants.SweepTimeoutMs,
      Constants.SweepPollMs
    )
  }

  /** The credit the flow sweeps: the one parked against the first pre-launch staker's key. */
  static sweptCredit(ctx: ClusterBuildContext): SysioContracts.SysioSyndImportCreditType {
    return Steps.ethereumLadderImport.actorSyndicationCredit(
      ctx.outputs.assert(EthereumLadderImportKey),
      Constants.SweptStakerIndex
    )
  }
}
