import Assert from "node:assert"

import {
  ClusterBuildPhase,
  Report,
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  SolanaLiqSyndicationTool,
  EthereumSyndicationTool,
  Constants as HarnessConstants,
  WireSyndicationTool,
  Steps,
  SyndicationUserSteps,
  pollUntil,
  verifyStep,
  SyndicationScenario,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationPluginUnderwritingScenarioConstants as Constants } from "./SyndicationPluginUnderwritingScenarioConstants.js"

const { Actor } = Report

/**
 * Prove the batch_operator_plugin's underwriter role, configured properly, underwrites
 * syndication with no intervention: the cluster's batch operators run the role and hold an
 * imported LIQSOL and LIQETH credits from bootstrap, the pair is configured in setup, and from then on the
 * flow only acts as users — two syndications, an unlinked recipient's syndication and its
 * `createlink`. Every bond, crank, approval and claim is the operators'; the flow only waits
 * for each and checks the exact accounting.
 */
export class SyndicationPluginUnderwritingScenario extends SyndicationScenario {
  readonly name = "flow-syndication-plugin-underwriting"
  readonly description =
    "Batch operators underwrite LIQSOL and LIQETH: bonded, released, approved and claimed; parked Solana credit is linked"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    enableBatchOperatorUnderwriting: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 0
  }

  plan(cluster: ClusterBuild): void {
    const plan = Constants.Plan
    // No flow-side bond provider: the batch operators bond from their bootstrap credits.
    this.planSetup(cluster, [plan.user, plan.unlinked], null)
    UnderwritingSteps.planConfigureUnderwriting(
      cluster,
      plan,
      Constants.Config,
      {
        phase:
          "Set the pair rules; every batch operator holds its underwriting credit",
        configure: "enable the scenario fee and buckets",
        funded:
          "each batch operator holds exactly its imported LIQSOL; record the balances"
      }
    )
    ClusterBuildPhase.create(
      cluster,
      "Syndicate",
      "The linked user syndicates twice; each request is bonded by the operators in turn"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "first-syndication",
        "syndicate the non-rounded amount",
        SyndicationScenario.OutpostOptions,
        plan.user.keypairName,
        plan.amount
      ),
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "first-requested",
        "the first envelope has an issued request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.amount,
        null,
        plan.firstEpoch,
        plan.firstRequest
      ),
      // Right after the request: its bond rows exist until the bond is paid, which the
      // challenge window holds back for at least window_sec.
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "first-bonded",
        "batch operators bond the first request's whole coverage within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.firstRequest
      ),
      UnderwritingSteps.planVerifyFirstCoveredCustody(
        Actor.Sysio,
        "first-covered-custody",
        "coverage rounds up, the attestation is persisted and the newest total_syndicated equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "second-syndication",
        "syndicate again",
        SyndicationScenario.OutpostOptions,
        plan.user.keypairName,
        plan.laterAmount
      ),
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "second-requested",
        "a later envelope has an issued request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.laterAmount,
        plan.firstEpoch,
        plan.secondEpoch,
        plan.secondRequest
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "second-bonded",
        "batch operators bond the second request's whole coverage within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.secondRequest
      ),
      UnderwritingSteps.planVerifySecondCoveredCustody(
        Actor.Sysio,
        "second-covered-custody",
        "coverage rounds up, total_syndicated grows by exactly the second syndication plus yield, and equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Release",
      "The operators' cranks release each envelope net of its fee, in queue order"
    ).push(
      UnderwritingSteps.planVerifyFirstRelease(
        Actor.Sysio,
        "first-released",
        "exact fee and linked credit",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      UnderwritingSteps.planVerifySecondDrained(
        Actor.Sysio,
        "second-drained",
        "both nets credited and both fees collected",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      UnderwritingSteps.planVerifyQueueOrder(
        Actor.Sysio,
        "queue-order",
        "the second request was issued only after the first was bonded",
        {},
        plan
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Approve",
      "After each challenge window the operators approve and claim"
    ).push(
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "first-approved-and-claimed",
        "first request APPROVED after its window and its bonds paid back",
        SyndicationScenario.VerifyOptions,
        plan.firstRequest
      ),
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "second-approved-and-claimed",
        "second request APPROVED after its window and its bonds paid back",
        SyndicationScenario.VerifyOptions,
        plan.secondRequest
      )
    )
    UnderwritingSteps.planUnlinkedIntake(cluster, plan)
    UnderwritingSteps.planParkAndLink(cluster, plan)
    UnderwritingSteps.planSettle(cluster, plan)
    this.planEthereum(cluster)
    this.planFinish(cluster)
  }

  /** Prove LIQETH is backed, automatically bonded, released to a linked wallet, and repaid. */
  private planEthereum(cluster: ClusterBuild): void {
    const plan = Constants.EthereumPlan,
      chain = "ETHEREUM",
      token = "LIQETH",
      options = SyndicationScenario.OutpostOptions,
      phase = ClusterBuildPhase.create(
        cluster,
        "EthereumUnderwriting",
        "The same operators underwrite and settle a real liqETH syndication"
      )
    phase.push(
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-ethereum-user",
        "create the independent Ethereum recipient",
        SyndicationScenario.WriteOptions,
        Constants.EthereumUser,
        HarnessConstants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "resources-ethereum-user",
        "allocate recipient resources",
        SyndicationScenario.WriteOptions,
        SyndicationScenario.resourcePolicy(Constants.EthereumUser)
      ),
      SyndicationUserSteps.planLinkEthereumKey(
        Actor.User,
        "link-ethereum-user",
        "link the independent Ethereum wallet",
        SyndicationScenario.WriteOptions,
        Constants.EthereumUser,
        Constants.EthereumHdIndex
      ),
      verifyStep(
        Actor.Sysio,
        "ethereum-underwriting-funded",
        "both shadows have funded operators and verified custody",
        async ctx => {
          const accounts = UnderwritingSteps.fundedOperatorAccounts(ctx)
          Assert.ok(accounts.length > 0)
          for (const account of accounts) {
            Assert.equal(
              await WireSyndicationTool.readLiqBalance(ctx, account, token),
              BigInt(Steps.registry.MockSyndicationImportAmount)
            )
          }
          Assert.ok(UnderwritingSteps.maxExposure(ctx, token) >= plan.amount)
          const outstanding = await WireSyndicationTool.readOutstanding(
            ctx,
            token
          )
          Assert.ok(
            (await EthereumSyndicationTool.readPoolBalanceDepot(ctx)) >=
              outstanding
          )
          Assert.equal(
            await EthereumSyndicationTool.readSyndicatedPrincipal(ctx),
            outstanding
          )
          Assert.equal(
            (await WireSyndicationTool.readSyndicationConfig(ctx, chain, token))
              .synd_fee_bps,
            0
          )
          ctx.outputs.set(Constants.EthereumBefore, {
            holder: await WireSyndicationTool.readLiqBalance(
              ctx,
              Constants.EthereumUser,
              token
            ),
            operators: (
              await Promise.all(
                accounts.map(account =>
                  WireSyndicationTool.readLiqBalance(ctx, account, token)
                )
              )
            ).reduce((sum, balance) => sum + balance, 0n)
          })
        }
      ),
      EthereumSyndicationTool.planDepositLiqEth(
        Actor.User,
        "ethereum-deposit",
        "deposit ETH for liqETH",
        options,
        Constants.EthereumHdIndex,
        Constants.EthereumDepositAmount
      ),
      EthereumSyndicationTool.planApproveLiqEth(
        Actor.User,
        "ethereum-approve",
        "approve the syndication pool",
        options,
        Constants.EthereumHdIndex,
        Constants.EthereumNativeAmount
      ),
      EthereumSyndicationTool.planSyndicate(
        Actor.User,
        "ethereum-syndicate",
        "syndicate to the holder's linked WIRE account",
        options,
        Constants.EthereumHdIndex,
        Constants.EthereumNativeAmount,
        EthereumSyndicationTool.compressedPubkey(Constants.EthereumHdIndex)
      ),
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "ethereum-requested",
        "the Ethereum envelope gets its request without a flow crank",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.amount,
        null,
        plan.firstEpoch,
        plan.firstRequest,
        chain,
        token
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "ethereum-bonded",
        "only funded operators bond the LIQETH request within its cap",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.firstRequest,
        token
      ),
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "ethereum-approved-and-claimed",
        "the operators approve after the window and claim their capital",
        SyndicationScenario.VerifyOptions,
        plan.firstRequest
      ),
      verifyStep(
        Actor.Sysio,
        "ethereum-settled",
        "the full principal reaches the linked holder and underwriting capital is returned",
        async ctx => {
          const accounts = UnderwritingSteps.fundedOperatorAccounts(ctx),
            before = ctx.outputs.assert(Constants.EthereumBefore)
          await pollUntil(
            "Ethereum envelope fully released",
            async () => {
              const row = await WireSyndicationTool.readEnvelope(
                ctx,
                chain,
                token,
                ctx.outputs.assert(plan.firstEpoch)
              )
              return (
                row != null &&
                BigInt(row.released) ===
                  BigInt(row.synd_total) + BigInt(row.yield_total)
              )
            },
            UnderwritingSteps.DaemonEffectBudgetMs,
            SyndicationScenario.PollMs
          )
          const balances = await Promise.all(
            accounts.map(account =>
              WireSyndicationTool.readLiqBalance(ctx, account, token)
            )
          )
          Assert.equal(
            await WireSyndicationTool.readLiqBalance(
              ctx,
              Constants.EthereumUser,
              token
            ),
            before.holder + plan.amount,
            "the holder must receive its entire LIQETH principal"
          )
          Assert.equal(
            balances.reduce((sum, balance) => sum + balance, 0n),
            before.operators,
            "all operator LIQETH underwriting capital must be returned"
          )
          const envelope = await WireSyndicationTool.readEnvelope(
            ctx,
            chain,
            token,
            ctx.outputs.assert(plan.firstEpoch)
          )
          Assert.equal(BigInt(envelope.synd_total), plan.amount)
          Assert.equal(
            BigInt(envelope.released),
            BigInt(envelope.synd_total) + BigInt(envelope.yield_total)
          )
          const outstanding = await WireSyndicationTool.readOutstanding(
            ctx,
            token
          )
          Assert.ok(
            (await EthereumSyndicationTool.readPoolBalanceDepot(ctx)) >=
              outstanding
          )
          Assert.equal(
            await EthereumSyndicationTool.readSyndicatedPrincipal(ctx),
            outstanding
          )
          Assert.deepEqual(await WireSyndicationTool.readMismatches(ctx), [])
          Assert.ok(!(await WireSyndicationTool.readCord(ctx))?.pulled)
        },
        SyndicationScenario.VerifyOptions
      )
    )
  }
}
