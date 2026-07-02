import Assert from "node:assert"
import { ethers } from "ethers"
import { ChainKind } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  AuthExLinkTool,
  ClusterBuildPhase,
  ClusterBuildStep,
  FlowScenario,
  Report,
  ethereumPrivateKeyFromWallet,
  outputKey,
  pollUntil,
  provisionWireUser,
  sleep,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type StepInput
} from "@wireio/test-cluster-tool"
import { YieldDistributionScenarioConstants as Constants } from "./YieldDistributionScenarioConstants.js"
import { YieldDistributionScenarioEmitSteps as EmitSteps } from "./steps/index.js"

const { SysioContractName } = SysioContracts
const { Actor } = Report

// ── reads (execute freely inside verify steps) ──────────────────────────────

/** All `sysio.dclaim::pclaims` rows (a read). */
async function readPclaimsRows(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioDclaimPendingClaimType[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.dclaim)
    .tables.pclaims.query({ limit: Constants.TableQueryLimit })
  return rows
}

/** How many `pclaims` rows credit `wireAccount` (a read — the dedupe metric). */
async function readPclaimsCount(ctx: ClusterBuildContext, wireAccount: string): Promise<number> {
  return (await readPclaimsRows(ctx)).filter(row => row.wire_account === wireAccount).length
}

/** All `sysio.dclaim::unmapped` rows (a read). */
async function readUnmappedRows(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioDclaimUnmappedTokenType[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.dclaim)
    .tables.unmapped.query({ limit: Constants.TableQueryLimit })
  return rows
}

/** The `sysio::t5state` emissions-accounting singleton (a read). */
async function readT5State(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioSystemT5StateType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.system)
    .tables.t5state.query({ limit: 1 })
  Assert.ok(rows.length >= 1, "sysio::t5state has no row — was initt5 run at bootstrap?")
  return rows[0]
}

/**
 * `capital_shortfall_total` as a number (a read). Large int64 columns can
 * arrive as JSON strings, so the conversion is runtime normalization, not
 * ceremony — the expected value here is 0 either way.
 */
async function readCapitalShortfallTotal(ctx: ClusterBuildContext): Promise<number> {
  return Number((await readT5State(ctx)).capital_shortfall_total)
}

/** Lowercased, `0x`-stripped hex of an ETH address — dclaim's `unmapped.native_pubkey` spelling. */
function ethereumNativePubkey(address: string): string {
  return address.toLowerCase().replace(/^0x/, "")
}

// ── SetupStakers step inputs + named runners ────────────────────────────────

/** Input for the linked-staker provisioning step. */
interface ProvisionLinkedStakerInput extends StepInput {
  readonly kind: "YieldDistributionScenario.ProvisionLinkedStakerInput"
  /** WIRE account name to create + resource-policy. */
  readonly account: string
}

/**
 * Named runner — mint the linked staker's ETH wallet into `ctx.outputs`, then
 * provision its WIRE account (creation under the dev key + the standard
 * resource policy, via the shared harness helper).
 */
async function runProvisionLinkedStaker(
  ctx: ClusterBuildContext,
  input: ProvisionLinkedStakerInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  ctx.outputs.set(YieldDistributionScenario.LinkedStakerWalletKey, ethers.Wallet.createRandom())
  await provisionWireUser(ctx.wire, input.account)
}

/** Input for the authex-link step. */
interface AuthexLinkLinkedStakerInput extends StepInput {
  readonly kind: "YieldDistributionScenario.AuthexLinkLinkedStakerInput"
  /** WIRE account being linked to its ETH wallet. */
  readonly account: string
}

/** Named runner — ONE `sysio.authex::createlink` write binding the staker's ETH wallet to its WIRE account. */
async function runAuthexLinkLinkedStaker(
  ctx: ClusterBuildContext,
  input: AuthexLinkLinkedStakerInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const wallet = ctx.outputs.assert(YieldDistributionScenario.LinkedStakerWalletKey)
  await AuthExLinkTool.createLink(ctx.wire, {
    chainKind: ChainKind.EVM,
    account: input.account,
    privateKey: ethereumPrivateKeyFromWallet(wallet),
    ethereumWallet: wallet
  })
}

/**
 * Named runner — mint the UNLINKED staker's ETH wallet into `ctx.outputs`.
 * Deliberately NO WIRE account and NO authex link: the depot parking its
 * reward in `unmapped` IS the scenario under test.
 */
async function runProvisionUnlinkedStaker(
  ctx: ClusterBuildContext,
  _input: null,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  ctx.outputs.set(YieldDistributionScenario.UnlinkedStakerWalletKey, ethers.Wallet.createRandom())
}

/**
 * Yield distribution — synthetic STAKING_REWARD attestations driven through
 * both outposts into the depot's reward-distribution path
 * (`sysio.dclaim::onreward` → `sysio.system::fundclaim` → `sysio.token`),
 * porting the old jest suite's four tests 1:1:
 *
 * 1. **SetupStakers** — the AuthEx-LINKED staker (WIRE account + `createlink`)
 *    and the UNLINKED staker (a bare ETH wallet), one provisioning step each.
 * 2. **EmitEthereumLinked** — `MockYieldEmitter.emitYield` → batchop ferry →
 *    `pclaims` row for the linked account; `capital_shortfall_total` stays
 *    unchanged (emissions cover the credit).
 * 3. **EmitEthereumUnlinked** — the same emit with an empty WIRE account →
 *    the depot parks the credit in `unmapped` keyed by the ETH address.
 * 4. **DedupReplay** — snapshot the linked `pclaims` count, re-emit the SAME
 *    `external_epoch_ref` (the emitter's monotonic check reverts), and after a
 *    settle window the count is unchanged.
 * 5. **EmitSolanaReward** — `opp_outpost::add_attestation` mirrors the flow on
 *    the SOL side for a new unlinked staker; the `unmapped` count grows.
 */
export class YieldDistributionScenario extends FlowScenario {
  readonly name = "flow-yield-distribution"
  readonly description =
    "Fake STAKING_REWARD emissions on both outposts: pclaims credit (linked), unmapped park (unlinked), and external_epoch_ref replay dedupe"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  build(cluster: ClusterBuild): void {
    const emitStepOptions = { timeoutMs: Constants.EmitStepTimeoutMs },
      propagationStepOptions = {
        timeoutMs: Constants.PropagationTimeoutMs + Constants.PollDeadlineBufferMs
      },
      dedupeStepOptions = {
        timeoutMs: Constants.dedupeSettleMs() + Constants.PollDeadlineBufferMs
      }

    // ── 1. SetupStakers — linked (account + authex link) vs unlinked (bare wallet) ──
    ClusterBuildPhase.create(
      cluster,
      "SetupStakers",
      "Provision the AuthEx-linked staker (WIRE account + createlink) and the unlinked staker"
    ).push(
      ClusterBuildStep.create<ClusterBuildContext, ProvisionLinkedStakerInput>(
        Actor.User,
        "provision-linked-staker",
        `provision WIRE account ${Constants.LinkedStakerAccount} + mint its ETH wallet`,
        {},
        {
          kind: "YieldDistributionScenario.ProvisionLinkedStakerInput",
          account: Constants.LinkedStakerAccount
        },
        runProvisionLinkedStaker
      ),
      ClusterBuildStep.create<ClusterBuildContext, AuthexLinkLinkedStakerInput>(
        Actor.User,
        "authex-link-linked-staker",
        `sysio.authex::createlink binds ${Constants.LinkedStakerAccount} to its ETH wallet`,
        {},
        {
          kind: "YieldDistributionScenario.AuthexLinkLinkedStakerInput",
          account: Constants.LinkedStakerAccount
        },
        runAuthexLinkLinkedStaker
      ),
      ClusterBuildStep.create<ClusterBuildContext, null>(
        Actor.User,
        "provision-unlinked-staker",
        "mint the unlinked staker's ETH wallet (no WIRE account, no authex link)",
        {},
        null,
        runProvisionUnlinkedStaker
      )
    )

    // ── 2. EmitEthereumLinked — emitYield → pclaims row; shortfall unchanged ──
    ClusterBuildPhase.create(
      cluster,
      "EmitEthereumLinked",
      "MockYieldEmitter emits a linked-staker STAKING_REWARD; the depot credits pclaims"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-capital-shortfall",
        "record t5state.capital_shortfall_total before the emission",
        async ctx => {
          ctx.outputs.set(
            YieldDistributionScenario.CapitalShortfallBeforeKey,
            await readCapitalShortfallTotal(ctx)
          )
        }
      ),
      EmitSteps.ethereumEmit(
        Actor.EthereumOutpost,
        "emit-ethereum-linked",
        `emit ${Constants.EthereumRewardPerStaker} wei STAKING_REWARD for ${Constants.LinkedStakerAccount}`,
        emitStepOptions,
        YieldDistributionScenario.LinkedStakerWalletKey,
        Constants.LinkedStakerAccount,
        Constants.EthereumRewardPerStaker,
        Constants.FullShareBps,
        Constants.LinkedStakerExternalEpochRef,
        Constants.RewardEpochIndex
      ),
      verifyStep(
        Actor.Sysio,
        "pclaims-row-linked",
        `a NEW pclaims row appears for ${Constants.LinkedStakerAccount} (new account — any row is new)`,
        async ctx => {
          await pollUntil(
            `pclaims row for ${Constants.LinkedStakerAccount} (ETH)`,
            async () => (await readPclaimsCount(ctx, Constants.LinkedStakerAccount)) >= 1,
            Constants.PropagationTimeoutMs,
            Constants.PropagationPollMs
          )
        },
        propagationStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "capital-shortfall-unchanged",
        "t5state.capital_shortfall_total is unchanged (emissions cover the credit)",
        async ctx => {
          const before = ctx.outputs.assert(YieldDistributionScenario.CapitalShortfallBeforeKey)
          Assert.strictEqual(
            await readCapitalShortfallTotal(ctx),
            before,
            "capital_shortfall_total moved — emissions did not cover the credit"
          )
        }
      )
    )

    // ── 3. EmitEthereumUnlinked — emitYield("") → unmapped park ──
    ClusterBuildPhase.create(
      cluster,
      "EmitEthereumUnlinked",
      "MockYieldEmitter emits an unlinked-staker STAKING_REWARD; the depot parks it in unmapped"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-unmapped-ethereum",
        "record the unmapped row count before the emission",
        async ctx => {
          ctx.outputs.set(
            YieldDistributionScenario.EthereumUnmappedCountBeforeKey,
            (await readUnmappedRows(ctx)).length
          )
        }
      ),
      EmitSteps.ethereumEmit(
        Actor.EthereumOutpost,
        "emit-ethereum-unlinked",
        `emit ${Constants.EthereumRewardPerStaker} wei STAKING_REWARD for the unlinked staker`,
        emitStepOptions,
        YieldDistributionScenario.UnlinkedStakerWalletKey,
        Constants.UnlinkedWireAccount,
        Constants.EthereumRewardPerStaker,
        Constants.FullShareBps,
        Constants.UnlinkedStakerExternalEpochRef,
        Constants.RewardEpochIndex
      ),
      verifyStep(
        Actor.Sysio,
        "unmapped-row-unlinked",
        "an unmapped row appears keyed by the unlinked staker's ETH address",
        async ctx => {
          const wallet = ctx.outputs.assert(YieldDistributionScenario.UnlinkedStakerWalletKey),
            expectedPubkey = ethereumNativePubkey(wallet.address)
          await pollUntil(
            "unmapped row for the unlinked ETH staker",
            async () =>
              (await readUnmappedRows(ctx)).some(
                row => row.native_pubkey.toLowerCase() === expectedPubkey
              ),
            Constants.PropagationTimeoutMs,
            Constants.PropagationPollMs
          )
        },
        propagationStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "unmapped-count-grew-ethereum",
        "the unmapped row count grew past the snapshot",
        async ctx => {
          const before = ctx.outputs.assert(
            YieldDistributionScenario.EthereumUnmappedCountBeforeKey
          )
          const after = (await readUnmappedRows(ctx)).length
          Assert.ok(after > before, `unmapped count ${after} did not grow past ${before}`)
        }
      )
    )

    // ── 4. DedupReplay — same external_epoch_ref reverts; nothing credits ──
    ClusterBuildPhase.create(
      cluster,
      "DedupReplay",
      "Replaying the linked staker's external_epoch_ref reverts at the emitter and credits nothing"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-pclaims-count",
        `record ${Constants.LinkedStakerAccount}'s pclaims row count before the replay`,
        async ctx => {
          ctx.outputs.set(
            YieldDistributionScenario.ReplayPclaimsCountBeforeKey,
            await readPclaimsCount(ctx, Constants.LinkedStakerAccount)
          )
        }
      ),
      EmitSteps.ethereumEmitReplay(
        Actor.EthereumOutpost,
        "emit-ethereum-replay",
        "re-emit the SAME external_epoch_ref — the emitter's monotonic check must revert",
        emitStepOptions,
        YieldDistributionScenario.LinkedStakerWalletKey,
        Constants.LinkedStakerAccount,
        Constants.EthereumRewardPerStaker,
        Constants.FullShareBps,
        Constants.RewardEpochIndex
      ),
      verifyStep(
        Actor.Sysio,
        "pclaims-count-unchanged",
        `pclaims count unchanged after a ${Constants.DedupeSettleEpochs}-epoch settle window`,
        async ctx => {
          const before = ctx.outputs.assert(
            YieldDistributionScenario.ReplayPclaimsCountBeforeKey
          )
          await sleep(Constants.dedupeSettleMs())
          Assert.strictEqual(
            await readPclaimsCount(ctx, Constants.LinkedStakerAccount),
            before,
            "replay was not deduped — the linked staker's pclaims count changed"
          )
        },
        dedupeStepOptions
      )
    )

    // ── 5. EmitSolanaReward — add_attestation mirrors the flow on SOL ──
    ClusterBuildPhase.create(
      cluster,
      "EmitSolanaReward",
      "opp_outpost::add_attestation drives a SOL-side STAKING_REWARD to the depot (unlinked park)"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-unmapped-solana",
        "record the unmapped row count before the SOL emission",
        async ctx => {
          ctx.outputs.set(
            YieldDistributionScenario.SolanaUnmappedCountBeforeKey,
            (await readUnmappedRows(ctx)).length
          )
        }
      ),
      EmitSteps.solanaEmit(
        Actor.SolanaOutpost,
        "emit-solana-reward",
        `emit ${Constants.SolanaRewardPerStaker} lamports STAKING_REWARD for a new unlinked SOL staker`,
        emitStepOptions,
        Constants.UnlinkedWireAccount,
        Constants.SolanaRewardPerStaker,
        Constants.FullShareBps,
        BigInt(Constants.SolanaChainCode),
        BigInt(Constants.SolanaTokenCode),
        Constants.SolanaStakerExternalEpochRef,
        Constants.RewardEpochIndex
      ),
      verifyStep(
        Actor.Sysio,
        "unmapped-count-grew-solana",
        "the unmapped row count grew past the snapshot",
        async ctx => {
          const before = ctx.outputs.assert(
            YieldDistributionScenario.SolanaUnmappedCountBeforeKey
          )
          await pollUntil(
            "unmapped row for the unlinked SOL staker",
            async () => (await readUnmappedRows(ctx)).length > before,
            Constants.PropagationTimeoutMs,
            Constants.PropagationPollMs
          )
        },
        propagationStepOptions
      )
    )
  }
}

/** Typed cross-step output keys for the yield-distribution scenario. */
export namespace YieldDistributionScenario {
  /** The AuthEx-linked staker's ETH wallet (minted by SetupStakers). */
  export const LinkedStakerWalletKey = outputKey<ethers.HDNodeWallet>(
    "yieldDistribution.linkedStakerWallet",
    "the AuthEx-linked staker's ETH wallet"
  )
  /** The UNLINKED staker's ETH wallet (no WIRE account, no authex link). */
  export const UnlinkedStakerWalletKey = outputKey<ethers.HDNodeWallet>(
    "yieldDistribution.unlinkedStakerWallet",
    "the unlinked staker's ETH wallet"
  )
  /** `t5state.capital_shortfall_total` snapshotted before the linked emission. */
  export const CapitalShortfallBeforeKey = outputKey<number>(
    "yieldDistribution.capitalShortfallBefore",
    "t5state.capital_shortfall_total before the linked emission"
  )
  /** `unmapped` row count snapshotted before the unlinked ETH emission. */
  export const EthereumUnmappedCountBeforeKey = outputKey<number>(
    "yieldDistribution.ethereumUnmappedCountBefore",
    "unmapped row count before the unlinked ETH emission"
  )
  /** `unmapped` row count snapshotted before the SOL emission. */
  export const SolanaUnmappedCountBeforeKey = outputKey<number>(
    "yieldDistribution.solanaUnmappedCountBefore",
    "unmapped row count before the SOL emission"
  )
  /** The linked staker's `pclaims` row count snapshotted before the replay. */
  export const ReplayPclaimsCountBeforeKey = outputKey<number>(
    "yieldDistribution.replayPclaimsCountBefore",
    "the linked staker's pclaims row count before the replayed emission"
  )
}
