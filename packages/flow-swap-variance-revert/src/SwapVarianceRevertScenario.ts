import Assert from "node:assert"
import { ethers } from "ethers"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  contractView,
  ClusterBuildPhase,
  ClusterBuildStep,
  EthereumCollateralTool,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  containsSwapRevert,
  getLogger,
  outputKey,
  pollUntil,
  requestEthereumSwap,
  sleep,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type ClusterConfig,
  type Logger,
  type ReserveManagerRequestSwapContract,
  type StepInput
} from "@wireio/test-cluster-tool"
import { SwapVarianceRevertScenarioConstants as Constants } from "./SwapVarianceRevertScenarioConstants.js"

const log = getLogger(__filename)
const { Actor } = Report

// ── typed cross-step outputs ─────────────────────────────────────────────────

/** The deliberately-inflated `target_amount` (live quote × RevertMultiplier). */
const InflatedTargetAmountKey = outputKey<bigint>(
  "swapVarianceRevert.inflatedTargetAmount",
  "inflated swap target amount (destination-chain base units)"
)

/** The swap user's ETH balance (wei) snapshotted before the SwapRequest write. */
const EthereumBalanceBeforeKey = outputKey<bigint>(
  "swapVarianceRevert.ethereumBalanceBefore",
  "swap user's pre-swap ETH balance in wei"
)

// ── value helpers (reads / pure math — executed INSIDE runners) ──────────────

/**
 * Bind the Ethereum outpost's `ReserveManager` to `wallet` from the run's
 * deploy artifacts (address from `outpost-addrs.json`, ABI from the hardhat
 * artifact) — a pure value helper used inside the submit runner.
 *
 * @param ctx - The scenario context (carries `config.ethereumPath`).
 * @param wallet - The signer the contract binds to (the swap user's wallet).
 * @returns The `requestSwap`-capable contract surface.
 */
function loadReserveManager(
  ctx: SwapScenarioContext,
  wallet: ethers.Signer
): ReserveManagerRequestSwapContract {
  const address = EthereumCollateralTool.loadOutpostAddresses(
    ctx.config.ethereumDeploymentsPath
  )[Constants.ReserveManagerContractName]
  Assert.ok(
    ethers.isAddress(address),
    `SwapVarianceRevertScenario: ${Constants.ReserveManagerContractName} not in outpost-addrs.json (got ${address})`
  )
  const abi = EthereumCollateralTool.loadOutpostAbi(
    ctx.config.ethereumPath,
    Constants.ReserveManagerContractName
  )
  return contractView<ReserveManagerRequestSwapContract>(address, abi, wallet)
}

// ── Step: compute the live quote and inflate the target (setup) ──────────────

/** Input for the quote-and-inflate setup step. */
interface ComputeQuoteAndInflateInput extends StepInput {
  readonly kind: "SwapVarianceRevertScenario.ComputeQuoteAndInflateInput"
  /** The swap input in the depot's 9-decimal frame (the quote basis). */
  readonly sourceDepotAmount: bigint
  /** Multiplier applied to the live quote (drives the target past tolerance). */
  readonly revertMultiplier: bigint
}

/**
 * Named runner — quote the swap live via {@link WireReserveTool.swapquote}
 * (the same two-hop `src → WIRE → dst` constant-product math the depot runs
 * when the SwapRequest is dispatched — a read), assert the quote is non-zero,
 * inflate it by `revertMultiplier`, and store the target in `ctx.outputs`.
 */
async function runComputeQuoteAndInflate(
  ctx: SwapScenarioContext,
  input: ComputeQuoteAndInflateInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const liveQuote = await WireReserveTool.swapquote(ctx.wire, {
    from: {
      chainCode: Constants.EthereumChainCode,
      tokenCode: Constants.EthereumTokenCode,
      reserveCode: Constants.PrimaryReserveCode
    },
    fromAmount: input.sourceDepotAmount,
    to: {
      chainCode: Constants.SolanaChainCode,
      tokenCode: Constants.SolanaTokenCode,
      reserveCode: Constants.PrimaryReserveCode
    }
  })
  Assert.ok(
    liveQuote > 0n,
    `SwapVarianceRevertScenario: live swap quote must be > 0 (got ${liveQuote})`
  )
  // Inflate by RevertMultiplier — far past the 50 bps tolerance. Doubling the
  // target gives a 10_000 bps drift (100% off), guaranteeing the depot's
  // variance check rejects on first inspection.
  const inflatedTargetAmount = liveQuote * input.revertMultiplier
  ctx.outputs.set(InflatedTargetAmountKey, inflatedTargetAmount)
  log.info(
    `[VarianceRevert] liveQuote=${liveQuote} inflatedTarget=${inflatedTargetAmount} tolerance_bps=${Constants.ToleranceBps}`
  )
}

/**
 * Named runner — snapshot the swap user's pre-swap ETH balance (a read) into
 * `ctx.outputs` so the refund step can assert against it.
 */
async function runSnapshotEthereumBalance(
  ctx: SwapScenarioContext,
  _input: null,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const swapUser = ctx.outputs.assert(swapUserOutputKey())
  const balance = await ctx.ethereum.provider.getBalance(
    swapUser.ethereumWallet.address
  )
  ctx.outputs.set(EthereumBalanceBeforeKey, balance)
}

// ── Step: the out-of-tolerance SwapRequest (the flow's ONE write) ────────────

/** Input for the out-of-tolerance `requestSwap` write step. */
interface RequestSwapOutOfToleranceInput extends StepInput {
  readonly kind: "SwapVarianceRevertScenario.RequestSwapOutOfToleranceInput"
  /** Wei escrowed as the swap's source deposit. */
  readonly sourceAmountWei: bigint
  /** Acceptable variance (bps) — far below the inflated target's drift. */
  readonly targetToleranceBps: number
}

/**
 * Named runner — ONE `ReserveManager.requestSwap(...)` write carrying the
 * inflated `target_amount`, signed by the swap user's wallet.
 */
async function runRequestSwapOutOfTolerance(
  ctx: SwapScenarioContext,
  input: RequestSwapOutOfToleranceInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const swapUser = ctx.outputs.assert(swapUserOutputKey())
  const inflatedTargetAmount = ctx.outputs.assert(InflatedTargetAmountKey)
  const reserveManager = loadReserveManager(ctx, swapUser.ethereumWallet)
  const result = await requestEthereumSwap(reserveManager, {
    sourceTokenCode: BigInt(Constants.EthereumTokenCode),
    sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
    sourceAmountWei: input.sourceAmountWei,
    targetChainCode: BigInt(Constants.SolanaChainCode),
    targetTokenCode: BigInt(Constants.SolanaTokenCode),
    targetReserveCode: BigInt(Constants.PrimaryReserveCode),
    targetRecipient: swapUser.solanaPublicKeyBytes,
    targetAmount: inflatedTargetAmount,
    targetToleranceBps: input.targetToleranceBps
  })
  Assert.ok(
    result.transactionHash,
    "SwapVarianceRevertScenario: requestSwap must return a mined transaction hash"
  )
}

/**
 * Swap Variance-Tolerance Revert — exercises `sysio.uwrit::createuwreq`'s
 * variance guard end-to-end through OPP. The depot computes a live `swap_quote`
 * for the (src, dst) reserves at the moment the SwapRequest is dispatched; if
 * the user's `target_amount` deviates from the live quote by more than
 * `target_tolerance_bps`, the depot:
 *
 * 1. Skips the UWREQ row entirely (no `reqs.emplace` runs).
 * 2. Queues a `SWAP_REVERT` attestation back to the source outpost.
 * 3. The source outpost refunds the user's source-side deposit.
 *
 * Canonical proof:
 * - A `DEPOT_OUTPOST_ETHEREUM` envelope carrying an
 *   `ATTESTATION_TYPE_SWAP_REVERT` entry ({@link containsSwapRevert}).
 * - The user's ETH balance returns to (initial − gas) within
 *   {@link SwapVarianceRevertScenarioConstants.RevertDeadlineMs}.
 *
 * The user passes a deliberately-inflated `target_amount` (live quote ×
 * {@link SwapVarianceRevertScenarioConstants.RevertMultiplier}) so the guard
 * fires every time without needing to drift the reserve.
 */
export class SwapVarianceRevertScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-variance-revert"
  readonly description =
    "Out-of-tolerance SwapRequest trips the depot's variance guard: no UWREQ, SWAP_REVERT refunds the user on the ETH outpost"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const defaultStepOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.DefaultStepTimeoutMs
      },
      negativeAssertStepOptions: ClusterBuildStepOptions = {
        timeoutMs:
          Constants.UwreqNegativeAssertMs + Constants.PollDeadlineBufferMs
      },
      revertStepOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.RevertDeadlineMs + Constants.PollDeadlineBufferMs
      }

    // ── 1. Provision the paired ETH + SOL swap end-user identity ──
    SwapUserIdentities.planIdentityProvisioning(
      cluster,
      "ProvisionSwapUser",
      "Provision the paired ETH + SOL swap end-user identity",
      {}
    )

    // ── 2. Chain health + bootstrap-seeded reserves ──
    ClusterBuildPhase.create(
      cluster,
      "ChainHealth",
      "Chain liveness + bootstrap-seeded primary reserves"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "wire-producing-blocks",
        "WIRE chain is producing blocks",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            `WIRE head_block_num must be > 0 (got ${info.head_block_num})`
          )
        },
        defaultStepOptions
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "bootstrap-reserves-seeded",
        "bootstrap seeded ETHEREUM/ETH/PRIMARY + SOLANA/SOL/PRIMARY reserves",
        async ctx => {
          // `reserveBook` throws when the row is absent — both reads
          // succeeding IS the assertion.
          await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrimaryReserveCode
          )
          await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
        },
        defaultStepOptions
      )
    )

    // ── 3. Quote the swap live; inflate the target past tolerance ──
    ClusterBuildPhase.create(
      cluster,
      "ComputeQuoteAndInflate",
      "Quote the swap live, inflate the user's target past tolerance, snapshot the pre-swap balance"
    ).push(
      ClusterBuildStep.create(
        Actor.User,
        "compute-quote-and-inflate",
        "compute live swapquote, then inflate the user's target to exceed tolerance",
        defaultStepOptions,
        {
          kind: "SwapVarianceRevertScenario.ComputeQuoteAndInflateInput",
          sourceDepotAmount: Constants.SourceDepotAmount,
          revertMultiplier: Constants.RevertMultiplier
        },
        runComputeQuoteAndInflate
      ),
      ClusterBuildStep.create(
        Actor.User,
        "snapshot-ethereum-balance",
        "snapshot the swap user's pre-swap ETH balance",
        defaultStepOptions,
        null,
        runSnapshotEthereumBalance
      )
    )

    // ── 4. The out-of-tolerance SwapRequest write ──
    ClusterBuildPhase.create(
      cluster,
      "SubmitOutOfTolerance",
      "User calls ReserveManager.requestSwap with the inflated target_amount"
    ).push(
      ClusterBuildStep.create(
        Actor.User,
        "request-swap-out-of-tolerance",
        `request a ${Constants.SourceEthereumWei} wei ETH → SOL swap carrying the inflated target`,
        defaultStepOptions,
        {
          kind: "SwapVarianceRevertScenario.RequestSwapOutOfToleranceInput",
          sourceAmountWei: Constants.SourceEthereumWei,
          targetToleranceBps: Constants.ToleranceBps
        },
        runRequestSwapOutOfTolerance
      )
    )

    // ── 5. The depot's variance guard fires: no UWREQ + SWAP_REVERT outbound ──
    ClusterBuildPhase.create(
      cluster,
      "VarianceGuardFires",
      "The depot rejects the swap without opening a UWREQ and queues SWAP_REVERT"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "no-uwreq-row",
        "depot does NOT create a UWREQ row (createuwreq variance branch fires)",
        async ctx => {
          // Give the SwapRequest envelope time to reach the depot. If the
          // depot's variance branch DIDN'T fire, a UWREQ row would appear
          // within ~1 epoch; we wait a generous window to be sure.
          await sleep(Constants.UwreqNegativeAssertMs)
          const inflatedTargetAmount = ctx.outputs.assert(
            InflatedTargetAmountKey
          )
          const request = await ctx.uwreq(
            Constants.EthereumChainCode,
            Constants.SolanaChainCode
          )
          Assert.ok(
            request == null ||
              BigInt(request.dst_amount ?? 0) !== inflatedTargetAmount,
            `UWREQ row ${request?.id} matches the rejected ETHEREUM→SOLANA swap (dst_amount=${request?.dst_amount}) — the variance guard did not fire`
          )
        },
        negativeAssertStepOptions
      ),
      verifyStep<SwapScenarioContext>(
        Actor.EthereumOutpost,
        "swap-revert-envelope",
        "SWAP_REVERT envelope queued outbound to the ETHEREUM outpost",
        async ctx => {
          await pollUntil(
            "SWAP_REVERT envelope appears for ETHEREUM outpost",
            async () =>
              containsSwapRevert(
                oppDebuggingPath(ctx.config.clusterPath),
                DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
              ),
            Constants.RevertDeadlineMs,
            Constants.LongPollIntervalMs
          )
        },
        revertStepOptions
      )
    )

    // ── 6. The ETH outpost refunds the user's source-side deposit ──
    ClusterBuildPhase.create(
      cluster,
      "RefundOnOutpost",
      "The ETH outpost processes SWAP_REVERT; the user's source deposit is refunded"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.EthereumOutpost,
        "refund-restores-balance",
        "user's ETH balance returns to ~initial (source-side refund landed)",
        async ctx => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey())
          const balanceBefore = ctx.outputs.assert(EthereumBalanceBeforeKey)
          // After the SwapRequest deducted sourceAmountWei + gas, the refund
          // should restore sourceAmountWei. Tolerate up to MaxGasReservedWei
          // for the request tx gas.
          const refundFloor = balanceBefore - Constants.MaxGasReservedWei
          await pollUntil(
            "user ETH balance back to (initial − gas)",
            async () =>
              (await ctx.ethereum.provider.getBalance(
                swapUser.ethereumWallet.address
              )) >= refundFloor,
            Constants.RevertDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const finalBalance = await ctx.ethereum.provider.getBalance(
            swapUser.ethereumWallet.address
          )
          const spent = balanceBefore - finalBalance
          log.info(
            `[VarianceRevert] user spent ${spent} wei (= gas only; source deposit refunded)`
          )
          Assert.ok(
            spent < Constants.MaxGasReservedWei,
            `user spent ${spent} wei — exceeds the ${Constants.MaxGasReservedWei} wei gas ceiling, so the refund did not land`
          )
        },
        revertStepOptions
      )
    )
  }
}
