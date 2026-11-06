import Assert from "node:assert"

import { ChainKind } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { Constants, ProtocolTiming } from "../Constants.js"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildStep,
  outputKey,
  Steps,
  SyndicationUserSteps,
  type StepInput
} from "../orchestration/index.js"
import { verifyStep, pollUntil } from "../orchestration/StepTools.js"
import { Report } from "../report/Report.js"
import { AuthExLinkTool } from "../tools/all/AuthExLinkTool.js"
import { EthereumSyndicationTool } from "../tools/ethereum/EthereumSyndicationTool.js"
import { SwapUserIdentities } from "../tools/all/SwapUserIdentities.js"
import { WireSyndicationTool } from "../tools/wire/WireSyndicationTool.js"
import { loadOutpostContract } from "../utils/ethereumUtils.js"
import { ethereumPrivateKeyFromWallet } from "../utils/keyPairUtils.js"
import { FlowScenario } from "./FlowScenario.js"
import { SyndicationScenario } from "./SyndicationScenario.js"

const { Actor } = Report
const { SysioSyndItemKind } = SysioContracts

/** One fresh Ethereum custody-to-wallet round trip, with explicit integration hooks. */
export abstract class EthereumRoundTripScenario extends FlowScenario {
  override readonly defaults = {
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 1,
    batchOperatorCount: 1,
    operatorsPerEpoch: 1,
    batchOpGroups: 1,
    underwriterCount: 0
  }

  /**
   * Append the complete round trip; subclasses perturb only the named boundary.
   * @param cluster - The bootstrap-loaded build receiving this scenario’s phases.
   */
  plan(cluster: ClusterBuild): void {
    this.planBeforeIntake(cluster)
    ClusterBuildPhase.create(
      cluster,
      "EthereumIntake",
      "Acquire liqETH with ETH and syndicate fresh principal"
    ).push(
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-holder",
        "create destination WIRE account",
        SyndicationScenario.WriteOptions,
        EthereumRoundTripScenario.Holder,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "holder-resources",
        "allocate destination resources",
        SyndicationScenario.WriteOptions,
        SyndicationScenario.resourcePolicy(EthereumRoundTripScenario.Holder)
      ),
      EthereumSyndicationTool.planDepositLiqEth(
        Actor.User,
        "deposit-eth",
        "deposit ETH for liqETH",
        SyndicationScenario.OutpostOptions,
        EthereumRoundTripScenario.HdIndex,
        EthereumRoundTripScenario.Wei
      ),
      verifyStep(
        Actor.User,
        "fresh-liqeth",
        "fresh holder owns exactly the deposited liqETH",
        async ctx => {
          Assert.strictEqual(
            await EthereumRoundTripScenario.externalBalance(ctx),
            EthereumRoundTripScenario.Wei
          )
          Assert.strictEqual(
            await EthereumRoundTripScenario.shadowBalance(ctx),
            0n
          )
          ctx.outputs.set(
            EthereumRoundTripScenario.PoolBefore,
            await EthereumSyndicationTool.readPoolBalanceDepot(ctx)
          )
          ctx.outputs.set(
            EthereumRoundTripScenario.OutstandingBefore,
            await WireSyndicationTool.readOutstanding(
              ctx,
              EthereumRoundTripScenario.Token
            )
          )
        }
      ),
      EthereumSyndicationTool.planApproveLiqEth(
        Actor.User,
        "approve-pool",
        "allow pool custody",
        SyndicationScenario.OutpostOptions,
        EthereumRoundTripScenario.HdIndex,
        EthereumRoundTripScenario.Wei
      ),
      EthereumSyndicationTool.planSyndicate(
        Actor.User,
        "syndicate-liqeth",
        "custody liqETH and emit real intake",
        SyndicationScenario.OutpostOptions,
        EthereumRoundTripScenario.HdIndex,
        EthereumRoundTripScenario.Wei,
        EthereumSyndicationTool.compressedPubkey(
          EthereumRoundTripScenario.HdIndex
        )
      ),
      verifyStep(
        Actor.Sysio,
        "ethereum-intake-held",
        "identify the fresh wallet's exact held principal",
        async ctx => {
          await pollUntil(
            "Ethereum syndication intake",
            async () => {
              const envelope = await WireSyndicationTool.readHeldEnvelope(
                ctx,
                EthereumRoundTripScenario.Chain,
                EthereumRoundTripScenario.Token,
                SysioSyndItemKind.SYNDICATION,
                EthereumRoundTripScenario.Amount,
                EthereumSyndicationTool.compressedPubkey(
                  EthereumRoundTripScenario.HdIndex
                ).slice(2)
              )
              if (!envelope) return false
              ctx.outputs.set(
                EthereumRoundTripScenario.Epoch,
                envelope.epoch_index
              )
              return true
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          Assert.strictEqual(
            await EthereumRoundTripScenario.externalBalance(ctx),
            0n
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readPoolBalanceDepot(ctx),
            ctx.outputs.assert(EthereumRoundTripScenario.PoolBefore) +
              EthereumRoundTripScenario.Amount
          )
        },
        SyndicationScenario.VerifyOptions
      ),
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "validate-intake",
        "validate real outpost custody through governance",
        SyndicationScenario.VerifyOptions,
        EthereumRoundTripScenario.Chain,
        EthereumRoundTripScenario.Token,
        EthereumRoundTripScenario.Epoch
      ),
      Steps.contracts.sysio.synd.planCrank(
        Actor.User,
        "release-principal",
        "release validated intake",
        SyndicationScenario.WriteOptions,
        { limit: SyndicationScenario.CrankLimit },
        EthereumRoundTripScenario.Holder
      ),
      EthereumRoundTripScenario.planLink(),
      verifyStep(
        Actor.User,
        "ethereum-shadow-delivered",
        "all principal reaches the linked WIRE wallet",
        async ctx => {
          await pollUntil(
            "exact Ethereum shadow",
            async () =>
              (await EthereumRoundTripScenario.shadowBalance(ctx)) ===
              EthereumRoundTripScenario.Amount,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          Assert.strictEqual(
            await WireSyndicationTool.readOutstanding(
              ctx,
              EthereumRoundTripScenario.Token
            ),
            ctx.outputs.assert(EthereumRoundTripScenario.OutstandingBefore) +
              EthereumRoundTripScenario.Amount
          )
        },
        SyndicationScenario.VerifyOptions
      )
    )
    this.planBeforeRedemption(cluster)
    ClusterBuildPhase.create(
      cluster,
      "EthereumRedemption",
      "Burn fresh shadow and queue its external release"
    ).push(
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "redeem-liqeth",
        "redeem the entire fresh shadow principal",
        SyndicationScenario.WriteOptions,
        {
          holder: EthereumRoundTripScenario.Holder,
          quantity: EthereumRoundTripScenario.Quantity
        }
      ),
      verifyStep(
        Actor.User,
        "shadow-burned",
        "entire principal is burned exactly once",
        async ctx => {
          Assert.strictEqual(
            await EthereumRoundTripScenario.shadowBalance(ctx),
            0n
          )
          Assert.strictEqual(
            await WireSyndicationTool.readOutstanding(
              ctx,
              EthereumRoundTripScenario.Token
            ),
            ctx.outputs.assert(EthereumRoundTripScenario.OutstandingBefore)
          )
        }
      )
    )
    this.planAfterRedemption(cluster)
    ClusterBuildPhase.create(
      cluster,
      "EthereumSettlement",
      "Verify actual external payout and continued delivery"
    ).push(
      verifyStep(
        Actor.User,
        "ethereum-paid-exactly",
        "external holder receives exactly the original liqETH principal",
        async ctx => {
          await pollUntil(
            "Ethereum redemption paid",
            async () =>
              (await EthereumRoundTripScenario.externalBalance(ctx)) ===
              EthereumRoundTripScenario.Wei,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          ctx.outputs.set(
            EthereumRoundTripScenario.SettledEpoch,
            await EthereumRoundTripScenario.readInboundEpoch(ctx)
          )
        },
        SyndicationScenario.VerifyOptions
      ),
      verifyStep(
        Actor.BatchOperator,
        "settlement-stays-exact",
        "another accepted Ethereum inbound epoch passes without a duplicate external payout",
        async ctx => {
          await pollUntil(
            "post-settlement Ethereum inbound progress",
            async () =>
              (await EthereumRoundTripScenario.readInboundEpoch(ctx)) >
              ctx.outputs.assert(EthereumRoundTripScenario.SettledEpoch),
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          Assert.strictEqual(
            await EthereumRoundTripScenario.externalBalance(ctx),
            EthereumRoundTripScenario.Wei
          )
          Assert.strictEqual(
            await EthereumRoundTripScenario.shadowBalance(ctx),
            0n
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readPoolBalanceDepot(ctx),
            ctx.outputs.assert(EthereumRoundTripScenario.PoolBefore)
          )
        },
        SyndicationScenario.VerifyOptions
      ),
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "solvent-after-round-trip",
        "cord remains clear and custody has no mismatch",
        {}
      )
    )
  }
  /**
   * Optional roster setup before user intake.
   * @param _cluster - The bootstrap-loaded build available to an integration variant.
   */
  protected planBeforeIntake(_cluster: ClusterBuild): void {}
  /**
   * Optional process interruption after intake has settled.
   * @param _cluster - The bootstrap-loaded build available to an integration variant.
   */
  protected planBeforeRedemption(_cluster: ClusterBuild): void {}
  /**
   * Optional recovery after a real release has been queued.
   * @param _cluster - The bootstrap-loaded build available to an integration variant.
   */
  protected planAfterRedemption(_cluster: ClusterBuild): void {}
}

/** Constants and exact balance readers for the Ethereum integration journey. */
export namespace EthereumRoundTripScenario {
  /** Unused anvil account, distinct from bootstrap actors. */
  export const HdIndex = SwapUserIdentities.DefaultEthereumHdIndex
  /** Destination shared only between isolated scenario clusters. */
  export const Holder = "eth.round"
  /** Registered external chain. */
  export const Chain = "ETHEREUM"
  /** Registered shadow token. */
  export const Token = EthereumSyndicationTool.LiqEthTokenCodename
  /** One token in depot units. */
  export const Amount = 1_000_000_000n
  /** Exact native-token amount; nine additional decimals on Ethereum. */
  export const Wei = Amount * 1_000_000_000n
  /** Full principal redemption action quantity. */
  export const Quantity = "1.000000000 LIQETH"
  /** Held intake's depot epoch. */
  export const Epoch = outputKey<number>(
    "EthereumRoundTrip.epoch",
    "fresh intake epoch"
  )
  /** Baseline external custody. */
  export const PoolBefore = outputKey<bigint>(
    "EthereumRoundTrip.pool",
    "pool baseline"
  )
  /** Baseline depot principal obligations. */
  export const OutstandingBefore = outputKey<bigint>(
    "EthereumRoundTrip.outstanding",
    "outstanding baseline"
  )
  /** Epoch observed once payout reached the recipient. */
  export const SettledEpoch = outputKey<bigint>(
    "EthereumRoundTrip.settledEpoch",
    "Ethereum inbound epoch after payout"
  )
  /** Typed destination cursor from the deployed inbound ABI. */
  export interface InboundCursorView {
    nextEpochIndex(): Promise<bigint>
  }
  /**
   * Observe actual destination OPP progress, independently of depot epoch production.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The destination’s next inbound epoch.
   */
  export async function readInboundEpoch(
    ctx: ClusterBuildContext
  ): Promise<bigint> {
    const inbound = loadOutpostContract<InboundCursorView>(
      ctx.config.ethereumPath,
      EthereumSyndicationTool.readDeployAddresses(ctx, "outpost-addrs.json"),
      "OPPInbound",
      ["outpost"],
      ctx.ethereum.provider
    )
    return inbound.nextEpochIndex()
  }
  /**
   * Read the real user's external liqETH holding.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The original wallet’s actual external liqETH balance.
   */
  export async function externalBalance(
    ctx: ClusterBuildContext
  ): Promise<bigint> {
    return EthereumSyndicationTool.readLiqEthBalance(
      ctx,
      EthereumSyndicationTool.hdWallet(ctx, HdIndex).address
    )
  }
  /**
   * Read only LIQETH in the destination wallet, refusing truncated table reads.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The destination’s exact shadow LIQETH balance.
   */
  export async function shadowBalance(
    ctx: ClusterBuildContext
  ): Promise<bigint> {
    return WireSyndicationTool.readLiqBalance(ctx, Holder, Token)
  }
  /**
   * One authenticated Ethereum wallet link, reported as its own write.
   * @returns One authenticated original-wallet link step.
   */
  export function planLink(): ClusterBuildStep<ClusterBuildContext, LinkInput> {
    return ClusterBuildStep.create(
      Actor.User,
      "link-ethereum-holder",
      "authenticate the original Ethereum wallet",
      SyndicationScenario.WriteOptions,
      { kind: "EthereumRoundTripScenario.LinkInput" },
      runLink
    )
  }
  /** Input for the single original-wallet link. */
  export interface LinkInput extends StepInput {
    readonly kind: "EthereumRoundTripScenario.LinkInput"
  }
  /**
   * Execute one link with the same key that syndicated externally.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param _input - The reported step input; this action needs no additional payload.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runLink(
    ctx: ClusterBuildContext,
    _input: LinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = EthereumSyndicationTool.hdWallet(ctx, HdIndex)
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: Holder,
      privateKey: ethereumPrivateKeyFromWallet(wallet),
      ethereumWallet: wallet
    })
  }
}
