/**
 * SwapNonNativeScenarioTokenSteps — flow-local Step factories for the
 * non-native swap matrix. One factory per on-chain WRITE (each mint, each
 * approve, each permit-signing setup, each requestSwap) plus one verify factory
 * per old-jest assertion, so the `Report` narrates every custody move and every
 * depot-side effect per swap cell. Cross-step runtime values (permit
 * signatures, pre-swap balances, uwreq id baselines) ride `ctx.outputs` under
 * per-cell typed {@link OutputKey}s; the {@link SwapCell} descriptors are pure
 * build-time data composed from the scenario constants.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ethers } from "ethers"
import { PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { match } from "ts-pattern"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  EthereumCollateralTool,
  Report,
  SolanaCollateralTool,
  SolanaFundingTool,
  SwapScenarioContext,
  WireReserveTool,
  matchesProtoEnum,
  mintMockErc20ToUser,
  outputKey,
  pollUntil,
  requestEthereumSwapErc20WithApproval,
  requestEthereumSwapErc20WithPermit,
  requestSolanaSwapSpl,
  contractView,
  resolveLatestNonce,
  signErc20Permit,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type Erc20ApprovableContract,
  type Erc20PermitTarget,
  type EthereumSwapArgs,
  type MintableErc20,
  type OutputKey,
  type PermitSignature,
  type ReserveManagerErc20SwapContract,
  type StepInput,
  type SwapUserOutput
} from "@wireio/test-cluster-tool"
import { SwapNonNativeScenarioConstants as Constants } from "../SwapNonNativeScenarioConstants.js"

const log = getLogger(__filename)

const { SysioContractName, SysioUwritUnderwriterequeststatus } = SysioContracts
const { Timing } = Constants

/** The per-underwriter collateral matrix shape carried on the cluster options. */
export type UnderwriterCollateralMatrix = NonNullable<
  ClusterBuildOptions["underwriterCollateral"]
>

/** How a swap cell's destination-side payout balance is observed. */
export enum SwapDestinationKind {
  solanaNative = "solanaNative",
  solanaSplToken = "solanaSplToken",
  ethereumNative = "ethereumNative"
}

/**
 * One cell of the non-native swap matrix — pure build-time data (composed from
 * the scenario constants) shared by the cell's write step and its verify steps.
 * Runtime values (balances, uwreq ids) ride `ctx.outputs` keyed by `name`.
 */
export interface SwapCell {
  /** Unique kebab-case cell id — prefixes every per-cell output key. */
  readonly name: string
  /** Source chain slug value (the outpost the custody lands on). */
  readonly sourceChainCode: number
  /** Source token slug value (a non-native mock stablecoin). */
  readonly sourceTokenCode: number
  /** Source amount in chain-native base units (6-dec for the mock stables). */
  readonly sourceAmount: bigint
  /**
   * Source token's chain-native decimals. The source outpost stamps the
   * outbound `SwapRequest.source_amount` as `toDepot(sourceAmount, this)` —
   * per-token depot precision `min(decimals, 9)`: identity for the 6-dec
   * stables, ÷1e9 for 18-dec wei — so
   * {@link SwapNonNativeScenarioTokenSteps.quoteTarget} must quote with the
   * SAME depot-frame amount the depot re-quotes with at ingestion. The
   * target itself is NEVER static — the depot re-quotes the live curve at
   * ingestion and variance-reverts anything outside tolerance.
   */
  readonly sourceDecimals: number
  /** Target chain slug value. */
  readonly targetChainCode: number
  /** Target token slug value. */
  readonly targetTokenCode: number
  /**
   * Destination token's chain-native decimals. The published target rides
   * the attestation in the DESTINATION token's depot frame
   * (`min(decimals, 9)` precision); the destination outpost pays out
   * `fromDepot(target, this)` native units, which is what the payout-floor
   * assertion must expect.
   */
  readonly destinationDecimals: number
  /** How the destination payout balance is read for the floor assertion. */
  readonly destination: SwapDestinationKind
}

/**
 * Flow-local Step factories + typed per-cell output keys for the non-native
 * swap matrix. Write factories return one {@link ClusterBuildStep} per on-chain
 * transaction; verify factories lift each old-jest assertion into a
 * {@link verifyStep}.
 */
export namespace SwapNonNativeScenarioTokenSteps {
  // ── Typed per-cell output keys (cross-step values ride ctx.outputs) ──────

  /** The cell's signed EIP-2612 permit (set by {@link signPermit}). */
  export function permitSignatureOutputKey(cellName: string): OutputKey<PermitSignature> {
    return outputKey<PermitSignature>(
      `${cellName}.permitSignature`,
      `signed EIP-2612 permit for ${cellName}`
    )
  }

  /** ReserveManager's source-token balance snapshotted before the swap write. */
  export function custodyBeforeOutputKey(cellName: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `${cellName}.custodyBefore`,
      `pre-swap ReserveManager source-token balance for ${cellName}`
    )
  }

  /** The user's destination balance snapshotted before the swap write. */
  export function destinationBeforeOutputKey(cellName: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `${cellName}.destinationBefore`,
      `pre-swap destination balance for ${cellName}`
    )
  }

  /** The LIVE depot quote for the cell (set by {@link quoteTarget}). */
  export function liveTargetOutputKey(cellName: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `${cellName}.liveTarget`,
      `live-quoted depot-frame target for ${cellName}`
    )
  }

  /** Highest pre-existing uwreq id for the cell's chain pair (-1 when none). */
  export function uwreqBaselineIdOutputKey(cellName: string): OutputKey<number> {
    return outputKey<number>(
      `${cellName}.uwreqBaselineId`,
      `pre-swap max uwreq id for ${cellName}`
    )
  }

  /** The cell's own uwreq row id (set once {@link verifyUwreqCreated} sees it). */
  export function uwreqIdOutputKey(cellName: string): OutputKey<number> {
    return outputKey<number>(`${cellName}.uwreqId`, `uwreq row id for ${cellName}`)
  }

  // ── Step: mint mock ERC-20 to the swap user (write) ──────────────────────

  /** Input for {@link mintErc20ToSwapUser}. */
  export interface MintErc20ToSwapUserInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.MintErc20ToSwapUserInput"
    /** Mock ERC-20 token slug value (resolves the deployed mock's address). */
    readonly tokenCode: number
    /** Token base units to mint to the swap user. */
    readonly amount: bigint
  }

  /**
   * ONE deployer-signed `mint(user, amount)` on the mock ERC-20 for
   * `tokenCode`. The mocks expose `mint` ungated, and the deployer signer
   * (anvil HD 0) sidesteps the intermittent user-wallet nonce races the old
   * jest run hit — the swap steps still sign source custody with the USER
   * wallet, so the user-signed path stays exercised.
   */
  export function mintErc20ToSwapUser(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    tokenCode: number,
    amount: bigint
  ): ClusterBuildStep<SwapScenarioContext, MintErc20ToSwapUserInput> {
    return ClusterBuildStep.create<SwapScenarioContext, MintErc20ToSwapUserInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapNonNativeScenarioTokenSteps.MintErc20ToSwapUserInput",
        tokenCode,
        amount
      },
      runMintErc20ToSwapUser
    )
  }

  /** Named runner — ONE mock-ERC-20 `mint(...)` write to the swap user. */
  export async function runMintErc20ToSwapUser(
    ctx: SwapScenarioContext,
    input: MintErc20ToSwapUserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "mintErc20ToSwapUser: amount must be positive")
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const token = mockErc20Contract<MintableErc20>(ctx, input.tokenCode)
    const transactionHash = await mintMockErc20ToUser(
      token,
      swapUser.ethereumWallet.address,
      input.amount
    )
    log.info(
      `[swap-non-native] minted ${input.amount} of token ${input.tokenCode} to ${swapUser.ethereumWallet.address} (${transactionHash})`
    )
  }

  // ── Step: mint mock SPL to the swap user's ATA (write) ───────────────────

  /** Input for {@link mintSplToSwapUser}. */
  export interface MintSplToSwapUserInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.MintSplToSwapUserInput"
    /** Mock SPL token slug value (resolves the persisted mint pubkey). */
    readonly tokenCode: number
    /** Token base units to mint into the swap user's ATA. */
    readonly amount: bigint
  }

  /**
   * ONE deployer-signed mock-SPL mint into the swap user's ATA (creating the
   * ATA on demand). The mint pubkey comes from the bootstrap-persisted
   * `sol-mock-mints.json`; the deployer keypair is the mint authority.
   */
  export function mintSplToSwapUser(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    tokenCode: number,
    amount: bigint
  ): ClusterBuildStep<SwapScenarioContext, MintSplToSwapUserInput> {
    return ClusterBuildStep.create<SwapScenarioContext, MintSplToSwapUserInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapNonNativeScenarioTokenSteps.MintSplToSwapUserInput",
        tokenCode,
        amount
      },
      runMintSplToSwapUser
    )
  }

  /** Named runner — ONE `mintMockSplToUser(...)` write into the swap user's ATA. */
  export async function runMintSplToSwapUser(
    ctx: SwapScenarioContext,
    input: MintSplToSwapUserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(input.amount > 0n, "mintSplToSwapUser: amount must be positive")
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const associatedTokenAddress = await SolanaFundingTool.mintMockSplToUser(
      ctx.solana.connection,
      SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      resolveSolanaMockMint(ctx.config.dataPath, input.tokenCode),
      swapUser.solanaKeypair.publicKey,
      input.amount
    )
    log.info(
      `[swap-non-native] minted ${input.amount} of token ${input.tokenCode} into ATA ${associatedTokenAddress.toBase58()}`
    )
  }

  // ── Step: sign the cell's EIP-2612 permit (setup — stores the output) ────

  /** Input for {@link signPermit}. */
  export interface SignPermitInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.SignPermitInput"
    readonly cell: SwapCell
  }

  /**
   * The user signs an EIP-2612 permit granting ReserveManager the cell's
   * source amount, stored under {@link permitSignatureOutputKey} for the
   * {@link requestSwapErc20WithPermit} write. Off-chain typed-data signing —
   * no transaction leaves this step.
   */
  /**
   * Quote the cell's swap LIVE against the depot's reserve books and store
   * the depot-frame target under {@link liveTargetOutputKey}. The depot
   * re-quotes at ingestion and reverts anything outside tolerance, so the
   * published target must come from the same curve — never a static constant.
   */
  export function quoteTarget(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        // Quote with the DEPOT-frame source — the amount the source outpost
        // stamps into SwapRequest.source_amount and the depot re-quotes with.
        const depotSourceAmount = WireReserveTool.toDepot(
          cell.sourceAmount,
          cell.sourceDecimals
        )
        const target = await WireReserveTool.swapquote(ctx.wire, {
          from: {
            chainCode: cell.sourceChainCode,
            tokenCode: cell.sourceTokenCode,
            reserveCode: Constants.Reserves.ReserveCode
          },
          fromAmount: depotSourceAmount,
          to: {
            chainCode: cell.targetChainCode,
            tokenCode: cell.targetTokenCode,
            reserveCode: Constants.Reserves.ReserveCode
          }
        })
        Assert.ok(
          target > 0n,
          `${cell.name}: live swapquote returned 0 — required reserves missing/inactive`
        )
        ctx.outputs.set(liveTargetOutputKey(cell.name), target)
        ctx.log.info(
          `[swap-non-native] ${cell.name}: live target ${target} (depot frame) for depot source ${depotSourceAmount} (native ${cell.sourceAmount})`
        )
      },
      options
    )
  }

  export function signPermit(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, SignPermitInput> {
    return ClusterBuildStep.create<SwapScenarioContext, SignPermitInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapNonNativeScenarioTokenSteps.SignPermitInput", cell },
      runSignPermit
    )
  }

  /** Named runner — sign the permit typed-data payload, store the signature. */
  export async function runSignPermit(
    ctx: SwapScenarioContext,
    input: SignPermitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { cell } = input
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const token = mockErc20Contract<Erc20PermitTarget>(ctx, cell.sourceTokenCode)
    const deadline = BigInt(
      Math.floor(Date.now() / 1_000) + Constants.PermitDeadlineWindowSec
    )
    const signature = await signErc20Permit(
      swapUser.ethereumWallet,
      token,
      assertReserveManagerAddress(ctx),
      cell.sourceAmount,
      deadline
    )
    ctx.outputs.set(permitSignatureOutputKey(cell.name), signature)
  }

  // ── Step: pre-set ERC-20 allowance for the approval path (write) ─────────

  /** Input for {@link approveErc20Spend}. */
  export interface ApproveErc20SpendInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.ApproveErc20SpendInput"
    readonly cell: SwapCell
  }

  /**
   * ONE user-signed `approve(ReserveManager, sourceAmount)` on the cell's
   * source ERC-20. Mainnet USDT does not implement EIP-2612, so this pre-set
   * allowance is the production codepath for those tokens.
   */
  export function approveErc20Spend(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, ApproveErc20SpendInput> {
    return ClusterBuildStep.create<SwapScenarioContext, ApproveErc20SpendInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapNonNativeScenarioTokenSteps.ApproveErc20SpendInput", cell },
      runApproveErc20Spend
    )
  }

  /** Named runner — ONE user-signed ERC-20 `approve(...)` write. */
  export async function runApproveErc20Spend(
    ctx: SwapScenarioContext,
    input: ApproveErc20SpendInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { cell } = input
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const token = mockErc20Contract<Erc20ApprovableContract>(
      ctx,
      cell.sourceTokenCode,
      swapUser.ethereumWallet
    )
    const nonce = await resolveLatestNonce(token)
    const response = await token.approve(
      assertReserveManagerAddress(ctx),
      cell.sourceAmount,
      { nonce }
    )
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `approveErc20Spend: approve reverted (status=${receipt?.status ?? "null"})`
    )
  }

  // ── Step: ERC-20 swap via inline permit (write) ──────────────────────────

  /** Input for {@link requestSwapErc20WithPermit}. */
  export interface RequestSwapErc20WithPermitInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.RequestSwapErc20WithPermitInput"
    readonly cell: SwapCell
  }

  /**
   * ONE user-signed `ReserveManager.requestSwapErc20WithPermit(...)` write —
   * permit consumption + transferFrom + fee-on-transfer guard + SWAP_REQUEST
   * queue, all atomic. Snapshots the custody / destination / uwreq baselines
   * (reads) immediately before submitting.
   */
  export function requestSwapErc20WithPermit(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, RequestSwapErc20WithPermitInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RequestSwapErc20WithPermitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapNonNativeScenarioTokenSteps.RequestSwapErc20WithPermitInput",
        cell
      },
      runRequestSwapErc20WithPermit
    )
  }

  /** Named runner — snapshot baselines, then ONE permit-path swap write. */
  export async function runRequestSwapErc20WithPermit(
    ctx: SwapScenarioContext,
    input: RequestSwapErc20WithPermitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { cell } = input
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const permitSignature = ctx.outputs.assert(permitSignatureOutputKey(cell.name))
    await snapshotErc20Custody(ctx, cell)
    await snapshotSwapBaselines(ctx, swapUser, cell)
    const result = await requestEthereumSwapErc20WithPermit(
      reserveManagerForSwapUser(ctx, swapUser.ethereumWallet),
      erc20SwapArgs(swapUser, cell, ctx.outputs.assert(liveTargetOutputKey(cell.name))),
      permitSignature
    )
    Assert.ok(result.transactionHash, "requestSwapErc20WithPermit: no tx hash")
    log.info(`[swap-non-native] ${cell.name}: swap requested (${result.transactionHash})`)
  }

  // ── Step: ERC-20 swap via pre-set allowance (write) ──────────────────────

  /** Input for {@link requestSwapErc20WithApproval}. */
  export interface RequestSwapErc20WithApprovalInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.RequestSwapErc20WithApprovalInput"
    readonly cell: SwapCell
  }

  /**
   * ONE user-signed `ReserveManager.requestSwapErc20WithApproval(...)` write.
   * The allowance MUST be pre-set by an {@link approveErc20Spend} Step earlier
   * in the same phase.
   */
  export function requestSwapErc20WithApproval(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, RequestSwapErc20WithApprovalInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RequestSwapErc20WithApprovalInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapNonNativeScenarioTokenSteps.RequestSwapErc20WithApprovalInput",
        cell
      },
      runRequestSwapErc20WithApproval
    )
  }

  /** Named runner — snapshot baselines, then ONE approval-path swap write. */
  export async function runRequestSwapErc20WithApproval(
    ctx: SwapScenarioContext,
    input: RequestSwapErc20WithApprovalInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { cell } = input
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    await snapshotErc20Custody(ctx, cell)
    await snapshotSwapBaselines(ctx, swapUser, cell)
    const result = await requestEthereumSwapErc20WithApproval(
      reserveManagerForSwapUser(ctx, swapUser.ethereumWallet),
      erc20SwapArgs(swapUser, cell, ctx.outputs.assert(liveTargetOutputKey(cell.name)))
    )
    Assert.ok(result.transactionHash, "requestSwapErc20WithApproval: no tx hash")
    log.info(`[swap-non-native] ${cell.name}: swap requested (${result.transactionHash})`)
  }

  // ── Step: SPL swap via signed request_swap_spl IX (write) ────────────────

  /** Input for {@link requestSwapSpl}. */
  export interface RequestSwapSplInput extends StepInput {
    readonly kind: "SwapNonNativeScenarioTokenSteps.RequestSwapSplInput"
    readonly cell: SwapCell
  }

  /**
   * ONE user-signed `opp_outpost::request_swap_spl` instruction — transfers
   * the source amount from the user's ATA into the reserve vault PDA and
   * queues the SWAP_REQUEST attestation. Snapshots the destination / uwreq
   * baselines (reads) immediately before submitting.
   */
  export function requestSwapSpl(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, RequestSwapSplInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RequestSwapSplInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapNonNativeScenarioTokenSteps.RequestSwapSplInput", cell },
      runRequestSwapSpl
    )
  }

  /** Named runner — snapshot baselines, then ONE `request_swap_spl` write. */
  export async function runRequestSwapSpl(
    ctx: SwapScenarioContext,
    input: RequestSwapSplInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { cell } = input
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    await snapshotSwapBaselines(ctx, swapUser, cell)
    const signature = await requestSolanaSwapSpl(
      ctx.solana.connection,
      SolanaCollateralTool.loadOppOutpostProgram(ctx, swapUser.solanaKeypair),
      swapUser.solanaKeypair,
      {
        sourceTokenCode: BigInt(cell.sourceTokenCode),
        sourceReserveCode: BigInt(Constants.Reserves.ReserveCode),
        sourceAmount: cell.sourceAmount,
        sourceMint: resolveSolanaMockMint(ctx.config.dataPath, cell.sourceTokenCode),
        targetChainCode: BigInt(cell.targetChainCode),
        targetTokenCode: BigInt(cell.targetTokenCode),
        targetReserveCode: BigInt(Constants.Reserves.ReserveCode),
        targetRecipient: targetRecipient(swapUser, cell),
        targetAmount: ctx.outputs.assert(liveTargetOutputKey(cell.name)),
        targetToleranceBps: Constants.Variance.ToleranceBps
      }
    )
    Assert.ok(signature, "requestSwapSpl: no transaction signature")
    log.info(`[swap-non-native] ${cell.name}: swap requested (${signature})`)
  }

  // ── Verify factories (each old-jest assertion → one verify step) ─────────

  /**
   * Source side: ReserveManager's source-token balance bumped by EXACTLY
   * `sourceAmount` (proves the fee-on-transfer guard didn't reject and
   * custody landed). Read-once — the swap write already awaited its receipt.
   */
  export function verifyErc20Custody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const custodyBefore = ctx.outputs.assert(custodyBeforeOutputKey(cell.name))
        const custodyAfter = await readMockErc20Balance(
          ctx,
          cell.sourceTokenCode,
          assertReserveManagerAddress(ctx)
        )
        Assert.strictEqual(
          custodyAfter,
          custodyBefore + cell.sourceAmount,
          `${cell.name}: ReserveManager custody must bump by exactly ${cell.sourceAmount} ` +
            `(before=${custodyBefore}, after=${custodyAfter})`
        )
      },
      options
    )
  }

  /**
   * The depot opens a NEW uwreq row for the cell's chain pair (id above the
   * pre-swap baseline); the row id is stored under {@link uwreqIdOutputKey}
   * for the confirm / lock verifies.
   */
  export function verifyUwreqCreated(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const baselineId = ctx.outputs.assert(uwreqBaselineIdOutputKey(cell.name))
        await pollUntil(
          `${cell.name}: new UWREQ row (id > ${baselineId})`,
          async () => {
            const created = (
              await readUwreqRowsForPair(ctx, cell.sourceChainCode, cell.targetChainCode)
            ).filter(row => Number(row.id) > baselineId)
            if (created.length === 0) return false
            const newest = created.reduce((left, right) =>
              Number(left.id) >= Number(right.id) ? left : right
            )
            ctx.outputs.set(uwreqIdOutputKey(cell.name), Number(newest.id))
            return true
          },
          Timing.UwreqDeadlineMs,
          Timing.LongPollIntervalMs
        )
      },
      options
    )
  }

  /**
   * The underwriter race resolves the cell's uwreq to CONFIRMED. COMPLETED is
   * also accepted — a poll tick can land after settlement already advanced the
   * row, and reaching COMPLETED implies CONFIRMED happened.
   */
  export function verifyUwreqConfirmed(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const uwreqId = ctx.outputs.assert(uwreqIdOutputKey(cell.name))
        await pollUntil(
          `${cell.name}: UWREQ ${uwreqId} CONFIRMED`,
          async () => {
            const row = (
              await readUwreqRowsForPair(ctx, cell.sourceChainCode, cell.targetChainCode)
            ).find(candidate => Number(candidate.id) === uwreqId)
            return (
              row != null &&
              (matchesProtoEnum(
                row.status,
                SysioUwritUnderwriterequeststatus,
                SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
              ) ||
                matchesProtoEnum(
                  row.status,
                  SysioUwritUnderwriterequeststatus,
                  SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_COMPLETED
                ))
            )
          },
          Timing.RaceDeadlineMs,
          Timing.LongPollIntervalMs
        )
      },
      options
    )
  }

  /**
   * Both legs locked: exactly {@link Constants.LocksPerSwap} `sysio.uwrit::locks`
   * rows reference the cell's uwreq (the locks form in the race-resolving
   * transaction and persist for the challenge window).
   */
  export function verifyUwreqLocks(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const uwreqId = ctx.outputs.assert(uwreqIdOutputKey(cell.name))
        await pollUntil(
          `${cell.name}: ${Constants.LocksPerSwap} locks on UWREQ ${uwreqId}`,
          async () =>
            (await ctx.locksForUwreq(uwreqId)).length === Constants.LocksPerSwap,
          Timing.UwreqDeadlineMs,
          Timing.LongPollIntervalMs
        )
      },
      options
    )
  }

  /**
   * Canonical proof: the user's destination balance reaches
   * `before + (destinationTargetAmount − drift)` — only achievable if source
   * custody, the OPP round-trip, the underwriter race, the depot variance
   * check, and the destination payout all worked.
   */
  export function verifyDestinationPayout(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    cell: SwapCell
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const swapUser = ctx.outputs.assert(swapUserOutputKey())
        const destinationBefore = ctx.outputs.assert(destinationBeforeOutputKey(cell.name))
        const liveTarget = ctx.outputs.assert(liveTargetOutputKey(cell.name))
        const floor = destinationPayoutFloor(destinationBefore, cell, liveTarget)
        await pollUntil(
          `${cell.name}: destination balance ≥ ${floor}`,
          async () => (await readDestinationBalance(ctx, swapUser, cell)) >= floor,
          Timing.RemitDeadlineMs,
          Timing.LongPollIntervalMs
        )
      },
      options
    )
  }

  /**
   * Gate: every underwriter's outpost bonds have relayed to the depot — one
   * `sysio.opreg` balance row per (chain, token) collateral entry, at or above
   * the deposited amount. Without this the first SWAP_REQUEST can reach
   * `sysio.uwrit::createuwreq` before the bonds exist depot-side and revert
   * with "insufficient bond on one or both legs".
   */
  export function verifyUnderwriterBondsRelayed(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    underwriterAccounts: string[],
    collateral: UnderwriterCollateralMatrix
  ): ClusterBuildStep<SwapScenarioContext, null> {
    collateral.forEach(entries =>
      entries.forEach(entry =>
        Assert.ok(
          entry.amount,
          "verifyUnderwriterBondsRelayed: every collateral entry needs an amount"
        )
      )
    )
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        await pollUntil(
          "every underwriter bond credited on sysio.opreg",
          async () => {
            const { rows } = await ctx.wire
              .getSysioContract(SysioContractName.opreg)
              .tables.operators.query({ limit: 100 })
            return underwriterAccounts.every((account, index) => {
              const operator = rows.find(row => row.account === account)
              if (operator == null) return false
              return collateral[index].every(entry =>
                operator.balances.some(
                  balance =>
                    slugValue(balance.chain_code) === entry.chain_code &&
                    slugValue(balance.token_code) === Number(entry.amount.tokenCode) &&
                    BigInt(balance.balance) >= entry.amount.amount
                )
              )
            })
          },
          Timing.RemitDeadlineMs,
          Timing.LongPollIntervalMs
        )
      },
      options
    )
  }
}

// ── Module-internal reads / value helpers (executed INSIDE runners) ─────────

/** One row of the bootstrap-persisted `sol-mock-mints.json` manifest. */
interface SolanaMockMint {
  code: number
  mint: string
  decimals: number
}

/** Minimal structural surface for the ERC-20 `balanceOf` read. */
interface Erc20BalanceReadContract extends ethers.BaseContract {
  balanceOf: (owner: string) => Promise<bigint>
}

/** A `sysio.uwrit::uwreqs` row (generated table-row type). */
type UwreqRow = SysioContracts.SysioUwritUwRequestTType

/** Baseline uwreq id when the pair has no pre-existing rows. */
const NoUwreqBaselineId = -1

/**
 * Load a test-mock ERC-20 ABI from the hardhat artifacts. The mocks live under
 * `contracts/test/outpost/` — separate from the production `contracts/outpost/`
 * tree that `EthereumCollateralTool.loadOutpostAbi` reads.
 */
function loadTestErc20Abi(ethereumPath: string, contractName: string): ethers.InterfaceAbi {
  const artifactPath = Path.join(
    ethereumPath,
    "artifacts",
    "contracts",
    "test",
    "outpost",
    `${contractName}.sol`,
    `${contractName}.json`
  )
  Assert.ok(
    Fs.existsSync(artifactPath),
    `SwapNonNativeScenarioTokenSteps: mock ERC-20 artifact not found at ${artifactPath}`
  )
  return JSON.parse(Fs.readFileSync(artifactPath, "utf8")).abi
}

/**
 * Bind the deployed mock ERC-20 for `tokenCode`. Deployer-signed (the cached
 * `ctx.ethereum` client wallet — anvil HD 0) unless a `signer` is supplied for
 * user-signed writes (approve).
 */
function mockErc20Contract<View extends object = object>(
  ctx: SwapScenarioContext,
  tokenCode: number,
  signer?: ethers.Signer
): View & ethers.BaseContract {
  const addressKey = Constants.MockErc20AddressKeyByTokenCode.get(tokenCode)
  Assert.ok(
    addressKey != null,
    `SwapNonNativeScenarioTokenSteps: no mock ERC-20 mapping for token code ${tokenCode}`
  )
  const address = EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath)[
    addressKey
  ]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `SwapNonNativeScenarioTokenSteps: ${addressKey} not in outpost-addrs.json (got ${address})`
  )
  const abi = loadTestErc20Abi(ctx.config.ethereumPath, addressKey)
  return (
    signer == null
      ? ctx.ethereum.getContract(addressKey, address, abi)
      : contractView<View>(address, abi, signer)
  ) as View & ethers.BaseContract
}

/** The deployed ReserveManager address from `outpost-addrs.json` (asserted). */
function assertReserveManagerAddress(ctx: SwapScenarioContext): string {
  const address = EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath)[
    Constants.OutpostAddressKey.ReserveManager
  ]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `SwapNonNativeScenarioTokenSteps: ReserveManager not in outpost-addrs.json (got ${address})`
  )
  return address
}

/** Bind ReserveManager's ERC-20 swap surface to the swap user's wallet. */
function reserveManagerForSwapUser(
  ctx: SwapScenarioContext,
  wallet: ethers.Signer
): ReserveManagerErc20SwapContract {
  const abi = EthereumCollateralTool.loadOutpostAbi(
    ctx.config.ethereumPath,
    Constants.OutpostAddressKey.ReserveManager
  )
  return contractView<ReserveManagerErc20SwapContract>(
    assertReserveManagerAddress(ctx),
    abi,
    wallet
  )
}

/**
 * Resolve the bootstrap-persisted mock SPL mint pubkey for `tokenCode` from
 * `<dataPath>/sol-mock-mints.json`.
 */
function resolveSolanaMockMint(dataPath: string, tokenCode: number): PublicKey {
  const mintsFile = Path.join(dataPath, Constants.SolanaMockMintsFilename)
  Assert.ok(
    Fs.existsSync(mintsFile),
    `SwapNonNativeScenarioTokenSteps: mock SPL mints not found at ${mintsFile}`
  )
  const mints = JSON.parse(Fs.readFileSync(mintsFile, "utf8")) as SolanaMockMint[]
  const found = mints.find(entry => entry.code === tokenCode)
  Assert.ok(
    found,
    `SwapNonNativeScenarioTokenSteps: no mock SPL mint persisted for token code ${tokenCode}`
  )
  return new PublicKey(found.mint)
}

/** READ the mock ERC-20 balance of `owner` for `tokenCode`. */
function readMockErc20Balance(
  ctx: SwapScenarioContext,
  tokenCode: number,
  owner: string
): Promise<bigint> {
  return (
    mockErc20Contract<Erc20BalanceReadContract>(ctx, tokenCode)
  ).balanceOf(owner)
}

/** The cell's raw recipient bytes on the target chain (20-byte EVM / 32-byte SVM). */
function targetRecipient(swapUser: SwapUserOutput, cell: SwapCell): Uint8Array {
  return cell.destination === SwapDestinationKind.ethereumNative
    ? swapUser.ethereumAddressBytes
    : swapUser.solanaPublicKeyBytes
}

/** READ the user's destination-side balance per the cell's destination kind. */
function readDestinationBalance(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  cell: SwapCell
): Promise<bigint> {
  return match(cell.destination)
    .with(SwapDestinationKind.solanaNative, async () =>
      BigInt(await ctx.solana.getLamports(swapUser.solanaKeypair.publicKey))
    )
    .with(SwapDestinationKind.ethereumNative, () =>
      ctx.ethereum.getBalance(swapUser.ethereumWallet.address)
    )
    .with(SwapDestinationKind.solanaSplToken, () =>
      ctx.solana.getSplBalance(
        getAssociatedTokenAddressSync(
          resolveSolanaMockMint(ctx.config.dataPath, cell.targetTokenCode),
          swapUser.solanaKeypair.publicKey
        )
      )
    )
    .exhaustive()
}

/**
 * The payout floor: `before + fromDepot(liveTarget − variance drift)`. Drift is
 * applied in the depot frame (where the depot's variance gate evaluates it),
 * then the net converts to destination-native units exactly as the outpost's
 * `fromDepot` payout does.
 */
function destinationPayoutFloor(
  destinationBefore: bigint,
  cell: SwapCell,
  liveTarget: bigint
): bigint {
  const depotNet =
    liveTarget -
    WireReserveTool.varianceDrift(liveTarget, Constants.Variance.ToleranceBps)
  return (
    destinationBefore + WireReserveTool.fromDepot(depotNet, cell.destinationDecimals)
  )
}

/** The calldata-facing `SwapArgs` struct for the cell (ERC-20 source paths). */
function erc20SwapArgs(
  swapUser: SwapUserOutput,
  cell: SwapCell,
  targetAmount: bigint
): EthereumSwapArgs {
  return {
    sourceTokenCode: BigInt(cell.sourceTokenCode),
    sourceReserveCode: BigInt(Constants.Reserves.ReserveCode),
    sourceAmount: cell.sourceAmount,
    targetChainCode: BigInt(cell.targetChainCode),
    targetTokenCode: BigInt(cell.targetTokenCode),
    targetReserveCode: BigInt(Constants.Reserves.ReserveCode),
    targetRecipient: targetRecipient(swapUser, cell),
    targetAmount,
    targetToleranceBps: Constants.Variance.ToleranceBps
  }
}

/** READ the `sysio.uwrit::uwreqs` rows for a (source chain, target chain) pair. */
async function readUwreqRowsForPair(
  ctx: SwapScenarioContext,
  sourceChainCode: number,
  targetChainCode: number
): Promise<UwreqRow[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query()
  return rows.filter(
    row =>
      slugValue(row.src_chain_code) === sourceChainCode &&
      slugValue(row.dst_chain_code) === targetChainCode
  )
}

/** READ the highest existing uwreq id for the pair ({@link NoUwreqBaselineId} when none). */
async function maxUwreqIdForPair(
  ctx: SwapScenarioContext,
  sourceChainCode: number,
  targetChainCode: number
): Promise<number> {
  return (await readUwreqRowsForPair(ctx, sourceChainCode, targetChainCode)).reduce(
    (max, row) => Math.max(max, Number(row.id)),
    NoUwreqBaselineId
  )
}

/** Snapshot the ReserveManager's source-token custody before an ERC-20 swap write. */
async function snapshotErc20Custody(
  ctx: SwapScenarioContext,
  cell: SwapCell
): Promise<void> {
  ctx.outputs.set(
    SwapNonNativeScenarioTokenSteps.custodyBeforeOutputKey(cell.name),
    await readMockErc20Balance(ctx, cell.sourceTokenCode, assertReserveManagerAddress(ctx))
  )
}

/**
 * Snapshot the destination balance + the uwreq id baseline immediately before
 * the swap write (reads) — the verify steps compare against these outputs.
 */
async function snapshotSwapBaselines(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  cell: SwapCell
): Promise<void> {
  ctx.outputs.set(
    SwapNonNativeScenarioTokenSteps.destinationBeforeOutputKey(cell.name),
    await readDestinationBalance(ctx, swapUser, cell)
  )
  ctx.outputs.set(
    SwapNonNativeScenarioTokenSteps.uwreqBaselineIdOutputKey(cell.name),
    await maxUwreqIdForPair(ctx, cell.sourceChainCode, cell.targetChainCode)
  )
}
