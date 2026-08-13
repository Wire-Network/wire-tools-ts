import Assert from "node:assert"
import { ethers } from "ethers"
import { match } from "ts-pattern"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  Report,
  SolanaCollateralTool,
  SwapScenarioContext,
  WireReserveTool,
  contractView,
  isNotEmpty,
  matchesProtoEnum,
  outputKey,
  pollUntil,
  provisionWireUser,
  requestEthereumSwap,
  requestSolanaSwap,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuildStepOptions,
  type OutputKey,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type SwapUserOutput,
  type WireUser
} from "@wireio/cluster-tool"
import {
  SwapRouteEndpoint,
  type SwapRoute,
  SwapRouteMatrixScenarioConstants as Constants
} from "../SwapRouteMatrixScenarioConstants.js"

const {
  SysioContractName,
  SysioUwritChainkind,
  SysioUwritUnderwriterequeststatus
} = SysioContracts

type UwreqRow = SysioContracts.SysioUwritUwRequestTType

/** Registered reserve identity used by the quote helper. */
interface ReserveTriple {
  readonly chainCode: number
  readonly tokenCode: number
  readonly reserveCode: number
}

/** Route-aware Steps shared by all six native matrix phases. */
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

  /** Input for {@link planProvisionWireUser}. */
  export interface ProvisionWireUserInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.ProvisionWireUserInput"
    /** Account used for both WIRE endpoint directions. */
    readonly account: string
    /** Treasury funding in raw WIRE base units. */
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

  /**
   * Read the live quote, destination balance, and matching UWREQ high-water
   * mark immediately before a route request.
   */
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
        const swapUser = ctx.outputs.assert(swapUserOutputKey())
        const target = await WireReserveTool.swapquote(ctx.wire, {
          from: reserveTriple(route.source),
          fromAmount: WireReserveTool.toDepot(
            route.sourceAmount,
            route.sourceDecimals
          ),
          to: reserveTriple(route.destination)
        })
        Assert.ok(target > 0n, `${route.label}: live swapquote returned zero`)
        ctx.outputs
          .set(targetOutputKey(route.id), target)
          .set(
            destinationBeforeOutputKey(route.id),
            await readDestinationBalance(ctx, swapUser, route.destination)
          )
          .set(
            uwreqBaselineOutputKey(route.id),
            await maxUwreqIdForRoute(ctx, route)
          )
        ctx.log.info(
          `[swap-route-matrix] ${route.label}: target=${target} depot units`
        )
      },
      options
    )
  }

  /** Input for the single route-request write in {@link planRequestRoute}. */
  export interface RequestRouteInput extends StepInput {
    readonly kind: "SwapRouteMatrixScenarioSteps.RequestRouteInput"
    /** Static route description; runtime quote and identities use ctx.outputs. */
    readonly route: SwapRoute
  }

  /** Submit exactly one source-endpoint request transaction for a route. */
  export function planRequestRoute(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, RequestRouteInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RequestRouteInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapRouteMatrixScenarioSteps.RequestRouteInput", route },
      runRequestRoute
    )
  }

  /** Named runner — dispatch the route through its existing native swap tool. */
  export async function runRequestRoute(
    ctx: SwapScenarioContext,
    input: RequestRouteInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const route = input.route,
      swapUser = ctx.outputs.assert(swapUserOutputKey()),
      target = ctx.outputs.assert(targetOutputKey(route.id)),
      targetRecipient = recipientBytes(ctx, swapUser, route.destination)

    await match(route.source)
      .with(SwapRouteEndpoint.Ethereum, async () => {
        const result = await requestEthereumSwap(
          loadReserveManager(ctx, swapUser.ethereumWallet),
          {
            sourceTokenCode: BigInt(Constants.EthereumTokenCode),
            sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
            sourceAmountWei: route.sourceAmount,
            targetChainCode: BigInt(chainCode(route.destination)),
            targetTokenCode: BigInt(tokenCode(route.destination)),
            targetReserveCode: BigInt(Constants.PrimaryReserveCode),
            targetRecipient,
            targetAmount: target,
            targetToleranceBps: Constants.ToleranceBps
          }
        )
        Assert.ok(
          isNotEmpty(result.transactionHash),
          `${route.label}: Ethereum request returned no transaction hash`
        )
      })
      .with(SwapRouteEndpoint.Solana, async () => {
        const signature = await requestSolanaSwap(
          ctx.solana.connection,
          SolanaCollateralTool.loadOppOutpostProgram(
            ctx,
            swapUser.solanaKeypair
          ),
          swapUser.solanaKeypair,
          {
            sourceTokenCode: BigInt(Constants.SolanaTokenCode),
            sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
            sourceAmount: route.sourceAmount,
            targetChainCode: BigInt(chainCode(route.destination)),
            targetTokenCode: BigInt(tokenCode(route.destination)),
            targetReserveCode: BigInt(Constants.PrimaryReserveCode),
            targetRecipient,
            targetAmount: target,
            targetToleranceBps: Constants.ToleranceBps
          }
        )
        Assert.ok(
          isNotEmpty(signature),
          `${route.label}: Solana request returned no signature`
        )
      })
      .with(SwapRouteEndpoint.Wire, async () => {
        const recipientKind =
          route.destination === SwapRouteEndpoint.Ethereum
            ? SysioUwritChainkind.CHAIN_KIND_EVM
            : SysioUwritChainkind.CHAIN_KIND_SVM
        const data: SysioContracts.SysioUwritSwapfromwireAction = {
          user: ctx.outputs.assert(wireUserOutputKey).account,
          wire_amount: Number(route.sourceAmount),
          dst_chain_code: { value: chainCode(route.destination) },
          dst_token_code: { value: tokenCode(route.destination) },
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
  }

  /** Poll until a new, route-specific UWREQ row appears and store its id. */
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
              WireReserveTool.toDepot(route.sourceAmount, route.sourceDecimals),
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

  /** Assert that the destination received at least the variance-adjusted target. */
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
            route.destinationDecimals
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
}

/** Resolve a route endpoint to its registered chain code. */
function chainCode(endpoint: SwapRouteEndpoint): number {
  return match(endpoint)
    .with(SwapRouteEndpoint.Ethereum, () => Constants.EthereumChainCode)
    .with(SwapRouteEndpoint.Solana, () => Constants.SolanaChainCode)
    .with(SwapRouteEndpoint.Wire, () => Constants.WireChainCode)
    .exhaustive()
}

/** Resolve a route endpoint to its registered native token code. */
function tokenCode(endpoint: SwapRouteEndpoint): number {
  return match(endpoint)
    .with(SwapRouteEndpoint.Ethereum, () => Constants.EthereumTokenCode)
    .with(SwapRouteEndpoint.Solana, () => Constants.SolanaTokenCode)
    .with(SwapRouteEndpoint.Wire, () => Constants.WireTokenCode)
    .exhaustive()
}

/** Reserve triple used by the existing live quote helper. */
function reserveTriple(endpoint: SwapRouteEndpoint): ReserveTriple {
  return {
    chainCode: chainCode(endpoint),
    tokenCode: tokenCode(endpoint),
    reserveCode: Constants.PrimaryReserveCode
  }
}

/** Recipient address bytes for an endpoint. */
function recipientBytes(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  endpoint: SwapRouteEndpoint
): Uint8Array {
  return match(endpoint)
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

/** Read the route's recipient-side native balance. */
function readDestinationBalance(
  ctx: SwapScenarioContext,
  swapUser: SwapUserOutput,
  endpoint: SwapRouteEndpoint
): Promise<bigint> {
  return match(endpoint)
    .with(SwapRouteEndpoint.Ethereum, () =>
      ctx.ethereum.getBalance(swapUser.ethereumWallet.address)
    )
    .with(SwapRouteEndpoint.Solana, () =>
      ctx.solana.getLamports(swapUser.solanaKeypair.publicKey).then(BigInt)
    )
    .with(SwapRouteEndpoint.Wire, () =>
      ctx.wire.getWireBalance(
        ctx.outputs.assert(SwapRouteMatrixScenarioSteps.wireUserOutputKey)
          .account
      )
    )
    .exhaustive()
}

/** Load ReserveManager from the existing outpost artifacts and bind the user. */
function loadReserveManager(
  ctx: SwapScenarioContext,
  wallet: ethers.Signer
): ReserveManagerRequestSwapContract {
  const address = EthereumCollateralTool.loadOutpostAddresses(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
  )[Constants.ReserveManagerContractName]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `${Constants.ReserveManagerContractName} missing from outpost-addrs.json`
  )
  return contractView<ReserveManagerRequestSwapContract>(
    address,
    EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    ),
    wallet
  )
}

/** Read matching UWREQ rows for a route, including both native token codes. */
async function readUwreqRowsForRoute(
  ctx: SwapScenarioContext,
  route: SwapRoute
): Promise<UwreqRow[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query()
  return rows.filter(
    row =>
      slugValue(row.src_chain_code) === chainCode(route.source) &&
      slugValue(row.src_token_code) === tokenCode(route.source) &&
      slugValue(row.dst_chain_code) === chainCode(route.destination) &&
      slugValue(row.dst_token_code) === tokenCode(route.destination)
  )
}

/** Highest pre-existing matching UWREQ id, or -1 when the pair is unused. */
async function maxUwreqIdForRoute(
  ctx: SwapScenarioContext,
  route: SwapRoute
): Promise<bigint> {
  return (await readUwreqRowsForRoute(ctx, route)).reduce(
    (maximum, row) => (BigInt(row.id) > maximum ? BigInt(row.id) : maximum),
    Constants.NoUwreqBaselineId
  )
}
