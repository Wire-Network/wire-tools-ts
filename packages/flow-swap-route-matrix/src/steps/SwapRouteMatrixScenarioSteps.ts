import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey } from "@solana/web3.js"
import type { ChainTokenAmount } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { match } from "ts-pattern"

import {
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  Report,
  SolanaCollateralTool,
  SolanaFundingTool,
  SwapScenarioContext,
  WireReserveTool,
  contractView,
  isNotEmpty,
  matchesProtoEnum,
  mintMockErc20ToUser,
  outputKey,
  pollUntil,
  provisionWireUser,
  requestEthereumSwap,
  requestEthereumSwapErc20WithApproval,
  requestEthereumSwapErc20WithPermit,
  requestSolanaSwap,
  requestSolanaSwapSpl,
  resolveLatestNonce,
  signErc20Permit,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuildStepOptions,
  type Erc20ApprovableContract,
  type Erc20PermitTarget,
  type EthereumSwapArgs,
  type MintableErc20,
  type OutputKey,
  type PermitSignature,
  type ReserveManagerErc20SwapContract,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type SwapUserOutput,
  type WireUser
} from "@wireio/cluster-tool"

import {
  type SwapRoute,
  SwapRouteEndpoint,
  SwapRouteMatrixScenarioConstants as Constants,
  type SwapRouteToken,
  SwapRouteSourceKind
} from "../SwapRouteMatrixScenarioConstants.js"

const {
  SysioContractName,
  SysioUwritChainkind,
  SysioUwritUnderwriterequeststatus
} = SysioContracts

type UwreqRow = SysioContracts.SysioUwritUwRequestTType
type MatrixReserveManager = ReserveManagerRequestSwapContract &
  ReserveManagerErc20SwapContract

/** Registered reserve identity used by the live quote helper. */
interface ReserveTriple {
  readonly chainCode: number
  readonly tokenCode: number
  readonly reserveCode: number
}

/** Structural ERC-20 surface needed by matrix funding, auth, and balance reads. */
interface MatrixErc20Contract
  extends
    ethers.BaseContract,
    MintableErc20,
    Erc20PermitTarget,
    Erc20ApprovableContract {
  balanceOf: (owner: string) => Promise<bigint>
  transfer: (
    recipient: string,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

/** Structural liqETH deposit surface used to acquire test liquidity. */
interface LiqEthDepositManagerContract extends ethers.BaseContract {
  minDeposit: () => Promise<bigint>
  deposit: (
    overrides: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

/** Minimal runtime ABI shared by mock stablecoins and liqETH. */
const MatrixErc20Abi: ethers.InterfaceAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address recipient, uint256 amount) returns (bool)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)"
]

/** Minimal runtime ABI for the local liqETH deposit path. */
const LiqEthDepositManagerAbi: ethers.InterfaceAbi = [
  "function minDeposit() view returns (uint256)",
  "function deposit() payable"
]

/** Route-aware Steps shared by every exact configured matrix phase. */
export namespace SwapRouteMatrixScenarioSteps {
  /** WIRE endpoint identity provisioned once for the whole matrix. */
  export const wireUserOutputKey = outputKey<WireUser>(
    "swapRouteMatrix.wireUser",
    "WIRE matrix recipient and depositor"
  )

  /** Live depot-frame quote for one route. */
  export function targetOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRouteMatrix.${routeId}.target`,
      `${routeId} live target amount`
    )
  }

  /** Destination balance before one route request. */
  export function destinationBeforeOutputKey(
    routeId: string
  ): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRouteMatrix.${routeId}.destinationBefore`,
      `${routeId} destination balance baseline`
    )
  }

  /** Source custody/balance before one non-native request. */
  export function sourceBeforeOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRouteMatrix.${routeId}.sourceBefore`,
      `${routeId} source custody baseline`
    )
  }

  /** Highest matching UWREQ id before one route request. */
  export function uwreqBaselineOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRouteMatrix.${routeId}.uwreqBaseline`,
      `${routeId} pre-request maximum UWREQ id`
    )
  }

  /** UWREQ id created by one route. */
  export function uwreqIdOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRouteMatrix.${routeId}.uwreqId`,
      `${routeId} UWREQ id`
    )
  }

  /** Signed EIP-2612 permit for one source route. */
  export function permitOutputKey(routeId: string): OutputKey<PermitSignature> {
    return outputKey<PermitSignature>(
      `swapRouteMatrix.${routeId}.permit`,
      `${routeId} EIP-2612 permit`
    )
  }

  /** Input for {@link planProvisionWireUser}. */
  export interface ProvisionWireUserInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.ProvisionWireUserInput"
    readonly account: string
    readonly fundWireAmount: bigint
  }

  /** Provision and fund the matrix's shared WIRE endpoint account. */
  export function planProvisionWireUser(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    fundWireAmount: bigint
  ): ClusterBuildStep<SwapScenarioContext, ProvisionWireUserInput> {
    return ClusterBuildStep.create<SwapScenarioContext, ProvisionWireUserInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteMatrixScenarioSteps.ProvisionWireUserInput",
        account,
        fundWireAmount
      },
      runProvisionWireUser
    )
  }

  /** Named runner — use the existing idempotent WIRE-user provisioning tool. */
  export async function runProvisionWireUser(
    ctx: SwapScenarioContext,
    input: ProvisionWireUserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const user = await provisionWireUser(ctx.wire, input.account, {
      fundWireAmount: input.fundWireAmount
    })
    ctx.outputs.set(wireUserOutputKey, user)
  }

  /** Input for the two liqETH reserve-liquidity setup steps. */
  export interface LiqEthReserveLiquidityInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.LiqEthReserveLiquidityInput"
    readonly floor: bigint
  }

  /** Acquire any LIQETH reserve shortfall through the real DepositManager. */
  export function planAcquireLiqEthReserveLiquidity(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    floor: bigint
  ): ClusterBuildStep<SwapScenarioContext, LiqEthReserveLiquidityInput> {
    return ClusterBuildStep.create<
      SwapScenarioContext,
      LiqEthReserveLiquidityInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteMatrixScenarioSteps.LiqEthReserveLiquidityInput",
        floor
      },
      runAcquireLiqEthReserveLiquidity
    )
  }

  /** Named runner — one payable DepositManager write when owner LIQETH is short. */
  export async function runAcquireLiqEthReserveLiquidity(
    ctx: SwapScenarioContext,
    input: LiqEthReserveLiquidityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const token = erc20Contract(
        ctx,
        Constants.EthereumTokens[1],
        ctx.ethereum.wallet.signer
      ),
      reserveManager = reserveManagerAddress(ctx),
      reserveBalance = await token.balanceOf(reserveManager),
      shortfall =
        input.floor > reserveBalance ? input.floor - reserveBalance : 0n,
      owner = await ctx.ethereum.wallet.signer.getAddress(),
      ownerBalance = await token.balanceOf(owner)
    if (ownerBalance >= shortfall) return
    const response = await liqEthDepositManager(
      ctx,
      ctx.ethereum.wallet.signer
    ).deposit({ value: (shortfall - ownerBalance) * 2n })
    const receipt = await response.wait(1)
    Assert.strictEqual(receipt?.status, 1, "liqETH acquisition reverted")
  }

  /** Transfer the LIQETH reserve shortfall into ReserveManager custody. */
  export function planTransferLiqEthReserveLiquidity(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    floor: bigint
  ): ClusterBuildStep<SwapScenarioContext, LiqEthReserveLiquidityInput> {
    return ClusterBuildStep.create<
      SwapScenarioContext,
      LiqEthReserveLiquidityInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteMatrixScenarioSteps.LiqEthReserveLiquidityInput",
        floor
      },
      runTransferLiqEthReserveLiquidity
    )
  }

  /** Named runner — one ERC-20 transfer for any remaining reserve shortfall. */
  export async function runTransferLiqEthReserveLiquidity(
    ctx: SwapScenarioContext,
    input: LiqEthReserveLiquidityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const token = erc20Contract(
        ctx,
        Constants.EthereumTokens[1],
        ctx.ethereum.wallet.signer
      ),
      reserveManager = reserveManagerAddress(ctx),
      current = await token.balanceOf(reserveManager)
    if (current >= input.floor) return
    const response = await token.transfer(
      reserveManager,
      input.floor - current,
      {
        nonce: await resolveLatestNonce(token)
      }
    )
    const receipt = await response.wait(1)
    Assert.strictEqual(receipt?.status, 1, "liqETH reserve transfer reverted")
  }

  /** Input for one non-native swap-user funding write. */
  export interface FundSwapUserTokenInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.FundSwapUserTokenInput"
    readonly token: SwapRouteToken
    readonly amount: bigint
  }

  /** Fund one Ethereum ERC-20/LIQETH source token. */
  export function planFundErc20SwapUser(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    token: SwapRouteToken,
    amount: bigint
  ): ClusterBuildStep<SwapScenarioContext, FundSwapUserTokenInput> {
    return ClusterBuildStep.create<SwapScenarioContext, FundSwapUserTokenInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteMatrixScenarioSteps.FundSwapUserTokenInput",
        token,
        amount
      },
      runFundErc20SwapUser
    )
  }

  /** Named runner — one mint or one real liqETH deposit to the swap user. */
  export async function runFundErc20SwapUser(
    ctx: SwapScenarioContext,
    input: FundSwapUserTokenInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      token = erc20Contract(ctx, input.token, ctx.ethereum.wallet.signer),
      current = await token.balanceOf(swapUser.ethereumWallet.address)
    if (current >= input.amount) return
    const shortfall = input.amount - current
    if (input.token.symbol === Constants.LiqEthSymbol) {
      const depositManager = liqEthDepositManager(ctx, swapUser.ethereumWallet)
      const response = await depositManager.deposit({
        value: maximum(shortfall * 2n, await depositManager.minDeposit())
      })
      const receipt = await response.wait(1)
      Assert.strictEqual(
        receipt?.status,
        1,
        "swap-user liqETH deposit reverted"
      )
      return
    }
    await mintMockErc20ToUser(token, swapUser.ethereumWallet.address, shortfall)
  }

  /** Fund one Solana SPL/LIQSOL source token. */
  export function planFundSplSwapUser(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    token: SwapRouteToken,
    amount: bigint
  ): ClusterBuildStep<SwapScenarioContext, FundSwapUserTokenInput> {
    return ClusterBuildStep.create<SwapScenarioContext, FundSwapUserTokenInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteMatrixScenarioSteps.FundSwapUserTokenInput",
        token,
        amount
      },
      runFundSplSwapUser
    )
  }

  /** Named runner — one mock SPL mint into the swap user's ATA. */
  export async function runFundSplSwapUser(
    ctx: SwapScenarioContext,
    input: FundSwapUserTokenInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      mint = solanaMint(ctx, input.token),
      current = await readSplBalance(ctx, swapUser, input.token)
    if (current >= input.amount) return
    await SolanaFundingTool.mintMockSplToUser(
      ctx.solana.connection,
      SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      mint,
      swapUser.solanaKeypair.publicKey,
      input.amount - current
    )
  }

  /** Read the live quote and source/UWREQ baselines immediately before request. */
  export function planPrepareRoute(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const swapUser = ctx.outputs.assert(swapUserOutputKey()),
          target = await WireReserveTool.swapquote(ctx.wire, {
            from: reserveTriple(route.source),
            fromAmount: WireReserveTool.toDepot(
              route.source.sourceAmount,
              route.source.decimals
            ),
            to: reserveTriple(route.destination)
          })
        Assert.ok(target > 0n, `${route.label}: live swapquote returned zero`)
        ctx.outputs
          .set(targetOutputKey(route.id), target)
          .set(
            uwreqBaselineOutputKey(route.id),
            await maxUwreqIdForRoute(ctx, route)
          )
        if (isNonNativeSource(route.source)) {
          ctx.outputs.set(
            sourceBeforeOutputKey(route.id),
            await readSourceCustodyBaseline(ctx, swapUser, route.source)
          )
        }
        ctx.log.info(
          `[swap-route-matrix] ${route.label}: target=${target} depot units`
        )
      },
      options
    )
  }

  /** Input for source authorization and request writes. */
  export interface RouteInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.RouteInput"
    readonly route: SwapRoute
  }

  /** Sign and store the route's EIP-2612 permit. */
  export function planSignPermit(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, RouteInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RouteInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapRouteMatrixScenarioSteps.RouteInput", route },
      runSignPermit
    )
  }

  /** Named runner — off-chain permit signing with no transaction. */
  export async function runSignPermit(
    ctx: SwapScenarioContext,
    input: RouteInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      signature = await signErc20Permit(
        swapUser.ethereumWallet,
        erc20Contract(ctx, input.route.source, swapUser.ethereumWallet),
        reserveManagerAddress(ctx),
        input.route.source.sourceAmount,
        BigInt(
          Math.floor(Date.now() / 1_000) + Constants.PermitDeadlineWindowSec
        )
      )
    ctx.outputs.set(permitOutputKey(input.route.id), signature)
  }

  /** Pre-approve ReserveManager for one approval-path route. */
  export function planApproveErc20Spend(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, RouteInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RouteInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapRouteMatrixScenarioSteps.RouteInput", route },
      runApproveErc20Spend
    )
  }

  /** Named runner — one ERC-20 approval signed by the swap user. */
  export async function runApproveErc20Spend(
    ctx: SwapScenarioContext,
    input: RouteInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      token = erc20Contract(ctx, input.route.source, swapUser.ethereumWallet),
      response = await token.approve(
        reserveManagerAddress(ctx),
        input.route.source.sourceAmount,
        { nonce: await resolveLatestNonce(token) }
      ),
      receipt = await response.wait(1)
    Assert.strictEqual(
      receipt?.status,
      1,
      `${input.route.label}: approve reverted`
    )
  }

  /** Submit exactly one source-endpoint request transaction for a route. */
  export function planRequestRoute(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, RouteInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RouteInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapRouteMatrixScenarioSteps.RouteInput", route },
      runRequestRoute
    )
  }

  /** Named runner — dispatch through the existing source-specific swap tool. */
  export async function runRequestRoute(
    ctx: SwapScenarioContext,
    input: RouteInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const route = input.route,
      swapUser = ctx.outputs.assert(swapUserOutputKey()),
      target = ctx.outputs.assert(targetOutputKey(route.id)),
      targetRecipient = recipientBytes(ctx, swapUser, route.destination)

    await match(route.source.sourceKind)
      .with(SwapRouteSourceKind.Native, async () => {
        if (route.source.endpoint === SwapRouteEndpoint.Ethereum) {
          const result = await requestEthereumSwap(
            reserveManagerContract(ctx, swapUser.ethereumWallet),
            {
              sourceTokenCode: BigInt(route.source.tokenCode),
              sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
              sourceAmountWei: route.source.sourceAmount,
              targetChainCode: BigInt(route.destination.chainCode),
              targetTokenCode: BigInt(route.destination.tokenCode),
              targetReserveCode: BigInt(Constants.PrimaryReserveCode),
              targetRecipient,
              targetAmount: target,
              targetToleranceBps: Constants.ToleranceBps
            }
          )
          Assert.ok(
            isNotEmpty(result.transactionHash),
            "Ethereum request has no hash"
          )
          return
        }
        const signature = await requestSolanaSwap(
          ctx.solana.connection,
          SolanaCollateralTool.loadOppOutpostProgram(
            ctx,
            swapUser.solanaKeypair
          ),
          swapUser.solanaKeypair,
          {
            sourceTokenCode: BigInt(route.source.tokenCode),
            sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
            sourceAmount: route.source.sourceAmount,
            targetChainCode: BigInt(route.destination.chainCode),
            targetTokenCode: BigInt(route.destination.tokenCode),
            targetReserveCode: BigInt(Constants.PrimaryReserveCode),
            targetRecipient,
            targetAmount: target,
            targetToleranceBps: Constants.ToleranceBps
          }
        )
        Assert.ok(isNotEmpty(signature), "Solana request has no signature")
      })
      .with(SwapRouteSourceKind.Erc20Permit, async () => {
        const result = await requestEthereumSwapErc20WithPermit(
          reserveManagerContract(ctx, swapUser.ethereumWallet),
          erc20SwapArgs(route, targetRecipient, target),
          ctx.outputs.assert(permitOutputKey(route.id))
        )
        Assert.ok(
          isNotEmpty(result.transactionHash),
          "permit request has no hash"
        )
      })
      .with(SwapRouteSourceKind.Erc20Approval, async () => {
        const result = await requestEthereumSwapErc20WithApproval(
          reserveManagerContract(ctx, swapUser.ethereumWallet),
          erc20SwapArgs(route, targetRecipient, target)
        )
        Assert.ok(
          isNotEmpty(result.transactionHash),
          "approval request has no hash"
        )
      })
      .with(SwapRouteSourceKind.Spl, async () => {
        const signature = await requestSolanaSwapSpl(
          ctx.solana.connection,
          SolanaCollateralTool.loadOppOutpostProgram(
            ctx,
            swapUser.solanaKeypair
          ),
          swapUser.solanaKeypair,
          {
            sourceTokenCode: BigInt(route.source.tokenCode),
            sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
            sourceAmount: route.source.sourceAmount,
            sourceMint: solanaMint(ctx, route.source),
            targetChainCode: BigInt(route.destination.chainCode),
            targetTokenCode: BigInt(route.destination.tokenCode),
            targetReserveCode: BigInt(Constants.PrimaryReserveCode),
            targetRecipient,
            targetAmount: target,
            targetToleranceBps: Constants.ToleranceBps
          }
        )
        Assert.ok(isNotEmpty(signature), "SPL request has no signature")
      })
      .with(SwapRouteSourceKind.Wire, async () => {
        const recipientKind =
          route.destination.endpoint === SwapRouteEndpoint.Ethereum
            ? SysioUwritChainkind.CHAIN_KIND_EVM
            : SysioUwritChainkind.CHAIN_KIND_SVM
        const data: SysioContracts.SysioUwritSwapfromwireAction = {
          user: ctx.outputs.assert(wireUserOutputKey).account,
          wire_amount: Number(route.source.sourceAmount),
          dst_chain_code: { value: route.destination.chainCode },
          dst_token_code: { value: route.destination.tokenCode },
          dst_reserve_code: { value: Constants.PrimaryReserveCode },
          target_amount: Number(target),
          target_tolerance_bps: Constants.ToleranceBps,
          recipient_kind: recipientKind,
          recipient_addr: Buffer.from(targetRecipient).toString("hex")
        }
        await ctx.wire
          .getSysioContract(SysioContractName.uwrit)
          .actions.swapfromwire.invoke(data, {
            authorization: [{ actor: data.user, permission: "active" }]
          })
      })
      .exhaustive()

    // Snapshot after the source transaction so same-outpost native payouts do
    // not falsely fail because the request itself paid ETH/SOL transaction fees.
    ctx.outputs.set(
      destinationBeforeOutputKey(route.id),
      await readDestinationBalance(ctx, swapUser, route.destination)
    )
  }

  /** Verify the exact non-native source custody movement. */
  export function planVerifySourceCustody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const swapUser = ctx.outputs.assert(swapUserOutputKey()),
          before = ctx.outputs.assert(sourceBeforeOutputKey(route.id))
        await match(route.source.sourceKind)
          .with(
            SwapRouteSourceKind.Erc20Permit,
            SwapRouteSourceKind.Erc20Approval,
            async () => {
              const after = await readErc20Balance(
                ctx,
                route.source,
                reserveManagerAddress(ctx)
              )
              Assert.strictEqual(
                after,
                before + route.source.sourceAmount,
                `${route.label}: ReserveManager source custody mismatch`
              )
            }
          )
          .with(SwapRouteSourceKind.Spl, async () => {
            const after = await readSplBalance(ctx, swapUser, route.source)
            Assert.strictEqual(
              after,
              before - route.source.sourceAmount,
              `${route.label}: source ATA debit mismatch`
            )
          })
          .otherwise(() => {
            throw new Error(
              `${route.label}: source custody verify is not applicable`
            )
          })
      },
      options
    )
  }

  /** Poll until a new exact-route UWREQ row appears and store its id. */
  export function planVerifyUwreqCreated(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const baseline = ctx.outputs.assert(uwreqBaselineOutputKey(route.id))
        await pollUntil(
          `${route.label}: new UWREQ after ${baseline}`,
          async () => {
            const candidates = (await readUwreqRowsForRoute(ctx, route)).filter(
              row => BigInt(row.id) > baseline
            )
            if (candidates.length === 0) return false
            const newest = candidates.reduce((left, right) =>
              BigInt(left.id) >= BigInt(right.id) ? left : right
            )
            Assert.strictEqual(
              BigInt(newest.src_amount),
              WireReserveTool.toDepot(
                route.source.sourceAmount,
                route.source.decimals
              ),
              `${route.label}: UWREQ source amount differs from the request`
            )
            ctx.outputs.set(uwreqIdOutputKey(route.id), BigInt(newest.id))
            return true
          },
          Constants.UwreqDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Poll until the route's underwriter race reaches CONFIRMED or COMPLETED. */
  export function planVerifyUwreqConfirmed(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const id = ctx.outputs.assert(uwreqIdOutputKey(route.id))
        await pollUntil(
          `${route.label}: UWREQ ${id} confirmed`,
          async () => {
            const row = (await readUwreqRowsForRoute(ctx, route)).find(
              candidate => BigInt(candidate.id) === id
            )
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
          Constants.RaceDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Assert the route created the correct one-leg or two-leg lock shape. */
  export function planVerifyLocks(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const id = ctx.outputs.assert(uwreqIdOutputKey(route.id))
        await pollUntil(
          `${route.label}: ${route.expectedLockCount} lock(s) on UWREQ ${id}`,
          async () =>
            (await ctx.locksForUwreq(id)).length === route.expectedLockCount,
          Constants.RaceDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Assert the destination received at least the variance-adjusted target. */
  export function planVerifyPayout(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        const swapUser = ctx.outputs.assert(swapUserOutputKey()),
          before = ctx.outputs.assert(destinationBeforeOutputKey(route.id)),
          target = ctx.outputs.assert(targetOutputKey(route.id)),
          minimumDepotPayout =
            target -
            WireReserveTool.varianceDrift(target, Constants.ToleranceBps),
          minimumNativePayout = WireReserveTool.fromDepot(
            minimumDepotPayout,
            route.destination.decimals
          ),
          floor = before + minimumNativePayout
        await pollUntil(
          `${route.label}: destination balance reaches ${floor}`,
          async () =>
            (await readDestinationBalance(ctx, swapUser, route.destination)) >=
            floor,
          Constants.PayoutDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Gate until every configured per-token underwriter bond is depot-visible. */
  export function planVerifyUnderwriterBondsRelayed(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    underwriterLabels: string[],
    collateral: ChainTokenAmount[][]
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      name,
      description,
      async ctx => {
        await pollUntil(
          "every configured matrix bond credited on sysio.opreg",
          async () => {
            const { rows } = await ctx.wire
              .getSysioContract(SysioContractName.opreg)
              .tables.operators.query({
                limit: Constants.OperatorTableRowLimit
              })
            return underwriterLabels.every((label, index) => {
              const account = ctx.keyStore.assertOperator(label).account,
                operator = rows.find(row => row.account === account)
              if (operator == null) return false
              return collateral[index].every(entry =>
                operator.balances.some(
                  balance =>
                    slugValue(balance.chain_code) === entry.chain_code &&
                    slugValue(balance.token_code) ===
                      Number(entry.amount.tokenCode) &&
                    BigInt(balance.balance) >= entry.amount.amount
                )
              )
            })
          },
          Constants.UnderwriterActiveDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }
}

/** Reserve triple used by the existing live quote helper. */
function reserveTriple(token: SwapRouteToken): ReserveTriple {
  return {
    chainCode: token.chainCode,
    tokenCode: token.tokenCode,
    reserveCode: Constants.PrimaryReserveCode
  }
}

/** Recipient address bytes for a token's owning endpoint. */
function recipientBytes(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  token: SwapRouteToken
): Uint8Array {
  return match(token.endpoint)
    .with(SwapRouteEndpoint.Ethereum, () => swapUser.ethereumAddressBytes)
    .with(SwapRouteEndpoint.Solana, () => swapUser.solanaPublicKeyBytes)
    .with(
      SwapRouteEndpoint.Wire,
      () =>
        ctx.outputs.assert(SwapRouteMatrixScenarioSteps.wireUserOutputKey)
          .accountBytes
    )
    .exhaustive()
}

/** Read one token's recipient-side balance. */
function readDestinationBalance(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  token: SwapRouteToken
): Promise<bigint> {
  return match(token.sourceKind)
    .with(SwapRouteSourceKind.Native, () =>
      token.endpoint === SwapRouteEndpoint.Ethereum
        ? ctx.ethereum.getBalance(swapUser.ethereumWallet.address)
        : ctx.solana.getLamports(swapUser.solanaKeypair.publicKey).then(BigInt)
    )
    .with(
      SwapRouteSourceKind.Erc20Permit,
      SwapRouteSourceKind.Erc20Approval,
      () => readErc20Balance(ctx, token, swapUser.ethereumWallet.address)
    )
    .with(SwapRouteSourceKind.Spl, () => readSplBalance(ctx, swapUser, token))
    .with(SwapRouteSourceKind.Wire, () =>
      ctx.wire.getWireBalance(
        ctx.outputs.assert(SwapRouteMatrixScenarioSteps.wireUserOutputKey)
          .account
      )
    )
    .exhaustive()
}

/** Read the correct custody baseline for one non-native source. */
function readSourceCustodyBaseline(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  token: SwapRouteToken
): Promise<bigint> {
  return match(token.sourceKind)
    .with(
      SwapRouteSourceKind.Erc20Permit,
      SwapRouteSourceKind.Erc20Approval,
      () => readErc20Balance(ctx, token, reserveManagerAddress(ctx))
    )
    .with(SwapRouteSourceKind.Spl, () => readSplBalance(ctx, swapUser, token))
    .otherwise(() => {
      throw new Error(`${token.symbol}: no non-native custody baseline`)
    })
}

/** Whether a source path gets an explicit non-native custody assertion. */
function isNonNativeSource(token: SwapRouteToken): boolean {
  return [
    SwapRouteSourceKind.Erc20Permit,
    SwapRouteSourceKind.Erc20Approval,
    SwapRouteSourceKind.Spl
  ].includes(token.sourceKind)
}

/** Read one ERC-20/LIQETH balance. */
function readErc20Balance(
  ctx: SwapScenarioContext,
  token: SwapRouteToken,
  owner: string
): Promise<bigint> {
  return erc20Contract(ctx, token, ctx.ethereum.wallet.signer).balanceOf(owner)
}

/** Read one mock SPL/LIQSOL balance, returning zero for an absent ATA. */
function readSplBalance(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  token: SwapRouteToken
): Promise<bigint> {
  return ctx.solana.getSplBalance(
    getAssociatedTokenAddressSync(
      solanaMint(ctx, token),
      swapUser.solanaKeypair.publicKey
    )
  )
}

/** Resolve one configured Solana token's persisted mint. */
function solanaMint(
  ctx: SwapScenarioContext,
  token: SwapRouteToken
): PublicKey {
  return new PublicKey(
    SolanaFundingTool.solMintAddress(
      ctx.config.dataPath,
      BigInt(token.tokenCode)
    )
  )
}

/** Bind one configured Ethereum token to a signer. */
function erc20Contract(
  ctx: SwapScenarioContext,
  token: SwapRouteToken,
  signer: ethers.Signer
): MatrixErc20Contract {
  const address = EthereumCollateralTool.mockErc20Address(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
    token.symbol
  )
  return contractView<MatrixErc20Contract>(address, MatrixErc20Abi, signer)
}

/** Deployed ReserveManager address. */
function reserveManagerAddress(ctx: SwapScenarioContext): string {
  const address = EthereumCollateralTool.loadOutpostAddresses(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
  )[Constants.ReserveManagerContractName]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `${Constants.ReserveManagerContractName} missing from outpost-addrs.json`
  )
  return address
}

/** Bind ReserveManager's native and ERC-20 swap surfaces to a signer. */
function reserveManagerContract(
  ctx: SwapScenarioContext,
  signer: ethers.Signer
): MatrixReserveManager {
  return contractView<MatrixReserveManager>(
    reserveManagerAddress(ctx),
    EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    ),
    signer
  )
}

/** Bind the local liqETH DepositManager to a signer. */
function liqEthDepositManager(
  ctx: SwapScenarioContext,
  signer: ethers.Signer
): LiqEthDepositManagerContract {
  const addressesFile = Path.join(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
    "liqeth-addrs.json"
  )
  Assert.ok(
    Fs.existsSync(addressesFile),
    `liqETH addresses missing: ${addressesFile}`
  )
  const address = (
    JSON.parse(Fs.readFileSync(addressesFile, "utf8")) as Record<string, string>
  )[Constants.DepositManagerContractName]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `${Constants.DepositManagerContractName} missing from liqeth-addrs.json`
  )
  return contractView<LiqEthDepositManagerContract>(
    address,
    LiqEthDepositManagerAbi,
    signer
  )
}

/** Calldata-facing ERC-20 swap arguments. */
function erc20SwapArgs(
  route: SwapRoute,
  targetRecipient: Uint8Array,
  targetAmount: bigint
): EthereumSwapArgs {
  return {
    sourceTokenCode: BigInt(route.source.tokenCode),
    sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
    sourceAmount: route.source.sourceAmount,
    targetChainCode: BigInt(route.destination.chainCode),
    targetTokenCode: BigInt(route.destination.tokenCode),
    targetReserveCode: BigInt(Constants.PrimaryReserveCode),
    targetRecipient,
    targetAmount,
    targetToleranceBps: Constants.ToleranceBps
  }
}

/** Read exact source/destination token rows for one route. */
async function readUwreqRowsForRoute(
  ctx: SwapScenarioContext,
  route: SwapRoute
): Promise<UwreqRow[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query()
  return rows.filter(
    row =>
      slugValue(row.src_chain_code) === route.source.chainCode &&
      slugValue(row.src_token_code) === route.source.tokenCode &&
      slugValue(row.dst_chain_code) === route.destination.chainCode &&
      slugValue(row.dst_token_code) === route.destination.tokenCode
  )
}

/** Highest pre-existing exact-route UWREQ id, or -1 when unused. */
async function maxUwreqIdForRoute(
  ctx: SwapScenarioContext,
  route: SwapRoute
): Promise<bigint> {
  return (await readUwreqRowsForRoute(ctx, route)).reduce(
    (maximum, row) => (BigInt(row.id) > maximum ? BigInt(row.id) : maximum),
    Constants.NoUwreqBaselineId
  )
}

/** Return the larger bigint without coercing either amount through Number. */
function maximum(left: bigint, right: bigint): bigint {
  return left >= right ? left : right
}
