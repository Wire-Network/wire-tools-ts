import Assert from "node:assert"

import { PublicKey } from "@solana/web3.js"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { match } from "ts-pattern"

import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import { swapUserOutputKey } from "../../orchestration/outputs/SwapUserOutput.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import { contractView, resolveLatestNonce } from "../../utils/ethereumUtils.js"
import { slugValue } from "../../utils/slugUtils.js"
import {
  EthereumCollateralTool,
  type Erc20ApprovableContract
} from "../ethereum/EthereumCollateralTool.js"
import {
  requestEthereumSwap,
  requestEthereumSwapErc20WithApproval,
  type ReserveManagerErc20SwapContract,
  type ReserveManagerRequestSwapContract
} from "../ethereum/EthereumSwapTool.js"
import { SolanaCollateralTool } from "../solana/SolanaCollateralTool.js"
import { SolanaFundingTool } from "../solana/SolanaFundingTool.js"
import {
  requestSolanaSwap,
  requestSolanaSwapSpl,
  readSolanaSwapSourceRequestId
} from "../solana/SolanaSwapTool.js"
import { WireUserTool } from "../wire/WireUserTool.js"
import {
  type SwapRoute,
  SwapRouteEndpoint,
  SwapRouteSourceKind
} from "./SwapRouteCatalog.js"

const { SysioContractName, SysioUwritChainkind } = SysioContracts
const ReserveManagerContractName = "ReserveManager"

type SwapReserveManager = ReserveManagerRequestSwapContract &
  ReserveManagerErc20SwapContract

const Erc20ApprovalAbi: ethers.InterfaceAbi = [
  "function approve(address spender, uint256 amount) returns (bool)"
]

/** Atomic source-authorization and request Steps shared by swap scenarios. */
export namespace SwapRouteSteps {
  /** Input for one swap-user ERC-20 approval. */
  export interface ApproveErc20Input extends StepInput {
    readonly kind: "SwapRouteSteps.ApproveErc20Input"
    readonly route: SwapRoute
    readonly amount: bigint
  }

  /** Input for exactly one route request transaction. */
  export interface RequestInput extends StepInput {
    readonly kind: "SwapRouteSteps.RequestInput"
    readonly route: SwapRoute
    readonly sourceAmount: bigint
    readonly targetToleranceBps: number
    readonly wireAccount: string
  }

  /**
   * Typed live-quote output for one route.
   *
   * @param routeId - Stable token-level route id.
   * @returns Typed target-amount output key.
   */
  export function targetOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRoute.${routeId}.target`,
      `${routeId} live target amount`
    )
  }

  /**
   * Typed protocol source request id emitted by one route request.
   *
   * @param routeId - Stable token-level route id.
   * @returns Typed source-request-id output key.
   */
  export function sourceRequestIdOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapRoute.${routeId}.sourceRequestId`,
      `${routeId} protocol source request id`
    )
  }

  /**
   * Decode a depot UWREQ's source transaction id into the protocol uint64 id.
   * External outposts encode it big-endian; depot-origin WIRE requests retain
   * the chain's little-endian uint64 byte representation.
   *
   * @param row - Typed UWREQ row.
   * @returns Canonical protocol source request id.
   */
  export function decodeUwreqSourceRequestId(
    row: SysioContracts.SysioUwritUwRequestTType
  ): bigint {
    const hex = row.source_tx_id.replace(/^0x/, "")
    Assert.match(hex, /^(?:[0-9a-fA-F]{2})+$/, "UWREQ source_tx_id must be hex")
    const bytes = [...Buffer.from(hex, "hex")]
    if (slugValue(row.src_chain_code) === SlugName.from("WIRE")) {
      bytes.reverse()
    }
    return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
  }

  /**
   * Plan one swap-user ERC-20 approval for ReserveManager.
   *
   * @param actor - Narrative subject.
   * @param name - Report step name.
   * @param description - Report step description.
   * @param options - Step tuning.
   * @param route - ERC-20 source route.
   * @param amount - Source-token base units approved.
   * @returns ERC-20 approval Step.
   */
  export function planErc20Approval<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute,
    amount: bigint
  ): ClusterBuildStep<C, ApproveErc20Input> {
    return ClusterBuildStep.create<C, ApproveErc20Input>(
      actor,
      name,
      description,
      options,
      { kind: "SwapRouteSteps.ApproveErc20Input", route, amount },
      runErc20Approval
    )
  }

  /** Named runner for exactly one swap-user ERC-20 approval write. */
  export async function runErc20Approval<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveErc20Input,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.strictEqual(
      input.route.source.sourceKind,
      SwapRouteSourceKind.ERC20,
      "SwapRouteSteps.planErc20Approval requires an ERC-20 source"
    )
    Assert.ok(input.amount > 0n, "swap route approval must be positive")
    const swapUser = ctx.outputs.assert(swapUserOutputKey()),
      tokenAddress = EthereumCollateralTool.mockErc20Address(
        ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
        input.route.source.symbol
      ),
      spender = reserveManagerAddress(ctx),
      token = contractView<Erc20ApprovableContract>(
        tokenAddress,
        Erc20ApprovalAbi,
        swapUser.ethereumWallet
      ),
      nonce = await resolveLatestNonce(token),
      response = await token.approve(spender, input.amount, { nonce }),
      receipt = await response.wait(1)
    Assert.strictEqual(
      receipt?.status,
      1,
      `${input.route.id}: approve reverted`
    )
  }

  /**
   * Plan exactly one source-endpoint request transaction.
   *
   * @param actor - Narrative subject.
   * @param name - Report step name.
   * @param description - Report step description.
   * @param options - Step tuning.
   * @param route - Exact public route.
   * @param sourceAmount - Source-chain base units to escrow.
   * @param targetToleranceBps - Accepted target variance in basis points.
   * @param wireAccount - Flow-owned WIRE endpoint account.
   * @returns Source request Step.
   */
  export function planRequest<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute,
    sourceAmount: bigint,
    targetToleranceBps: number,
    wireAccount: string
  ): ClusterBuildStep<C, RequestInput> {
    return ClusterBuildStep.create<C, RequestInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapRouteSteps.RequestInput",
        route,
        sourceAmount,
        targetToleranceBps,
        wireAccount
      },
      runRequest
    )
  }

  /** Named runner dispatching exactly one write through the source endpoint. */
  export async function runRequest<C extends ClusterBuildContext>(
    ctx: C,
    input: RequestInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.sourceAmount > 0n,
      "swap route source amount must be positive"
    )
    Assert.ok(
      input.targetToleranceBps >= 0 && input.targetToleranceBps <= 10_000,
      "swap route tolerance must be in [0, 10000]"
    )
    const { route } = input,
      swapUser = ctx.outputs.assert(swapUserOutputKey()),
      targetAmount = ctx.outputs.assert(targetOutputKey(route.id)),
      targetRecipient = match(route.destination.endpoint)
        .with(SwapRouteEndpoint.ETHEREUM, () => swapUser.ethereumAddressBytes)
        .with(SwapRouteEndpoint.SOLANA, () => swapUser.solanaPublicKeyBytes)
        .with(
          SwapRouteEndpoint.WIRE,
          () =>
            ctx.outputs.assert(WireUserTool.userOutputKey(input.wireAccount))
              .accountBytes
        )
        .exhaustive()

    await match(route.source.sourceKind)
      .with(SwapRouteSourceKind.NATIVE, () =>
        match(route.source.endpoint)
          .with(SwapRouteEndpoint.ETHEREUM, async () => {
            const result = await requestEthereumSwap(
              reserveManagerContract(ctx, swapUser.ethereumWallet),
              {
                sourceTokenCode: BigInt(route.source.tokenCode),
                sourceReserveCode: BigInt(route.source.reserveCode),
                sourceAmountWei: input.sourceAmount,
                targetChainCode: BigInt(route.destination.chainCode),
                targetTokenCode: BigInt(route.destination.tokenCode),
                targetReserveCode: BigInt(route.destination.reserveCode),
                targetRecipient,
                targetAmount,
                targetToleranceBps: input.targetToleranceBps
              }
            )
            ctx.outputs.set(
              sourceRequestIdOutputKey(route.id),
              result.sourceRequestId
            )
          })
          .with(SwapRouteEndpoint.SOLANA, async () => {
            const signature = await requestSolanaSwap(
              ctx.solana.connection,
              SolanaCollateralTool.loadOppOutpostProgram(
                ctx,
                swapUser.solanaKeypair
              ),
              swapUser.solanaKeypair,
              {
                sourceTokenCode: BigInt(route.source.tokenCode),
                sourceReserveCode: BigInt(route.source.reserveCode),
                sourceAmount: input.sourceAmount,
                targetChainCode: BigInt(route.destination.chainCode),
                targetTokenCode: BigInt(route.destination.tokenCode),
                targetReserveCode: BigInt(route.destination.reserveCode),
                targetRecipient,
                targetAmount,
                targetToleranceBps: input.targetToleranceBps
              }
            )
            ctx.outputs.set(
              sourceRequestIdOutputKey(route.id),
              await readSolanaSwapSourceRequestId(
                ctx.solana.connection,
                signature
              )
            )
          })
          .otherwise(() => {
            throw new Error("native public swap source must be an outpost")
          })
      )
      .with(SwapRouteSourceKind.ERC20, async () => {
        const result = await requestEthereumSwapErc20WithApproval(
          reserveManagerContract(ctx, swapUser.ethereumWallet),
          {
            sourceTokenCode: BigInt(route.source.tokenCode),
            sourceReserveCode: BigInt(route.source.reserveCode),
            sourceAmount: input.sourceAmount,
            targetChainCode: BigInt(route.destination.chainCode),
            targetTokenCode: BigInt(route.destination.tokenCode),
            targetReserveCode: BigInt(route.destination.reserveCode),
            targetRecipient,
            targetAmount,
            targetToleranceBps: input.targetToleranceBps
          }
        )
        ctx.outputs.set(
          sourceRequestIdOutputKey(route.id),
          result.sourceRequestId
        )
      })
      .with(SwapRouteSourceKind.SPL, async () => {
        const signature = await requestSolanaSwapSpl(
          ctx.solana.connection,
          SolanaCollateralTool.loadOppOutpostProgram(
            ctx,
            swapUser.solanaKeypair
          ),
          swapUser.solanaKeypair,
          {
            sourceTokenCode: BigInt(route.source.tokenCode),
            sourceReserveCode: BigInt(route.source.reserveCode),
            sourceAmount: input.sourceAmount,
            sourceMint: new PublicKey(
              SolanaFundingTool.solMintAddress(
                ctx.config.dataPath,
                BigInt(route.source.tokenCode)
              )
            ),
            targetChainCode: BigInt(route.destination.chainCode),
            targetTokenCode: BigInt(route.destination.tokenCode),
            targetReserveCode: BigInt(route.destination.reserveCode),
            targetRecipient,
            targetAmount,
            targetToleranceBps: input.targetToleranceBps
          }
        )
        ctx.outputs.set(
          sourceRequestIdOutputKey(route.id),
          await readSolanaSwapSourceRequestId(ctx.solana.connection, signature)
        )
      })
      .with(SwapRouteSourceKind.WIRE, async () => {
        const { rows: counterRows } = await ctx.wire
            .getSysioContract(SysioContractName.uwrit)
            .tables.uwcounters.query(),
          nextSequence = BigInt(counterRows[0]?.next_fromwire_seq ?? 0),
          sourceRequestId = (1n << 63n) | nextSequence,
          user = ctx.outputs.assert(
            WireUserTool.userOutputKey(input.wireAccount)
          ),
          recipientKind = match(route.destination.endpoint)
            .with(
              SwapRouteEndpoint.ETHEREUM,
              () => SysioUwritChainkind.CHAIN_KIND_EVM
            )
            .with(
              SwapRouteEndpoint.SOLANA,
              () => SysioUwritChainkind.CHAIN_KIND_SVM
            )
            .otherwise(() => {
              throw new Error("WIRE cannot target the WIRE endpoint")
            })
        await ctx.wire
          .getSysioContract(SysioContractName.uwrit)
          .actions.swapfromwire.invoke(
            {
              user: user.account,
              wire_amount: Number(input.sourceAmount),
              dst_chain_code: { value: route.destination.chainCode },
              dst_token_code: { value: route.destination.tokenCode },
              dst_reserve_code: { value: route.destination.reserveCode },
              target_amount: Number(targetAmount),
              target_tolerance_bps: input.targetToleranceBps,
              recipient_kind: recipientKind,
              recipient_addr: Buffer.from(targetRecipient).toString("hex")
            },
            { authorization: [{ actor: user.account, permission: "active" }] }
          )
        ctx.outputs.set(sourceRequestIdOutputKey(route.id), sourceRequestId)
      })
      .exhaustive()
  }
}

function reserveManagerAddress(ctx: ClusterBuildContext): string {
  const address = EthereumCollateralTool.loadOutpostAddresses(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
  )[ReserveManagerContractName]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `${ReserveManagerContractName} missing from outpost-addrs.json`
  )
  return address
}

function reserveManagerContract(
  ctx: ClusterBuildContext,
  signer: ethers.Signer
): SwapReserveManager {
  return contractView<SwapReserveManager>(
    reserveManagerAddress(ctx),
    EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      ReserveManagerContractName
    ),
    signer
  )
}
