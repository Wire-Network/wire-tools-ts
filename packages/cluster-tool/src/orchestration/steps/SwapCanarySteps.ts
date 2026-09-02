import Assert from "node:assert"

import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey } from "@solana/web3.js"
import { SysioContracts } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { match } from "ts-pattern"

import { SwapCanaryConfig as Constants } from "../../config/SwapCanaryConfig.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import {
  type ReserveBook,
  type SwapScenarioContext
} from "../../flow/contexts/SwapScenarioContext.js"
import { Report } from "../../report/Report.js"
import {
  type SwapRoute,
  type SwapRouteAsset,
  SwapRouteCatalog,
  SwapRouteEndpoint,
  SwapRouteSourceKind
} from "../../tools/all/SwapRouteCatalog.js"
import { SwapRouteSteps } from "../../tools/all/SwapRouteSteps.js"
import { EthereumCollateralTool } from "../../tools/ethereum/EthereumCollateralTool.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { WireReserveTool } from "../../tools/wire/WireReserveTool.js"
import { contractView } from "../../utils/ethereumUtils.js"
import { matchesProtoEnum } from "../../utils/predicateUtils.js"
import { slugValue } from "../../utils/slugUtils.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../OutputStore.js"
import { swapUserOutputKey } from "../outputs/SwapUserOutput.js"
import { pollUntil, verifyStep } from "../StepTools.js"
import type { StepInput } from "../StepRunner.js"

const { SysioContractName, SysioUwritUnderwriterequeststatus } = SysioContracts
const ReserveManagerContractName = "ReserveManager"

interface BalanceErc20 extends ethers.BaseContract {
  balanceOf: (owner: string) => Promise<bigint>
}

interface RouteSnapshot {
  readonly sourceBook: ReserveBook | null
  readonly destinationBook: ReserveBook | null
  readonly destinationBalance: bigint
  readonly destinationClaimable: bigint
  readonly sourceCustody: bigint | null
}

const BalanceErc20Abi: ethers.InterfaceAbi = [
  "function balanceOf(address owner) view returns (uint256)"
]

/** Route lifecycle verification Steps owned by the swap canary. */
export namespace SwapCanarySteps {
  /** Depot UWREQ id correlated to one exact source request. */
  export function uwreqIdOutputKey(routeId: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `swapCanary.${routeId}.uwreqId`,
      `${routeId} exact UWREQ id`
    )
  }

  function snapshotOutputKey(routeId: string): OutputKey<RouteSnapshot> {
    return outputKey<RouteSnapshot>(
      `swapCanary.${routeId}.snapshot`,
      `${routeId} pre-request state`
    )
  }

  /** Read a live quote and snapshot only the state this route later verifies. */
  export function planPrepareRoute(
    actor: Report.Actor,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "quote-and-snapshot",
      `${SwapRouteCatalog.routeLabel(route)}: compute the live quote and snapshot balances/books`,
      async ctx => {
        const sourceAmount = sourceAmountFor(route.source),
          target = await WireReserveTool.swapquote(ctx.wire, {
            from: reserveTriple(route.source),
            fromAmount: WireReserveTool.toDepot(
              sourceAmount,
              route.source.sourcePrecision
            ),
            to: reserveTriple(route.destination)
          })
        Assert.ok(
          target > 0n,
          `${SwapRouteCatalog.routeLabel(route)}: live quote returned zero`
        )
        ctx.outputs
          .set(SwapRouteSteps.targetOutputKey(route.id), target)
          .set(snapshotOutputKey(route.id), {
            sourceBook: await readReserveBook(ctx, route.source),
            destinationBook: await readReserveBook(ctx, route.destination),
            destinationBalance: await readDestinationBalance(
              ctx,
              route.destination
            ),
            destinationClaimable:
              route.destination.endpoint === SwapRouteEndpoint.WIRE
                ? await ctx.wire.getWireClaimable(Constants.WireUserAccount)
                : 0n,
            sourceCustody: await readSourceCustody(ctx, route.source)
          })
      }
    )
  }

  /** Verify explicit ERC-20, SPL, or WIRE source custody movement. */
  export function planVerifySourceCustody(
    actor: Report.Actor,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "source-custody",
      `${SwapRouteCatalog.routeLabel(route)}: verify the exact source custody movement`,
      async ctx => {
        const before = ctx.outputs.assert(
            snapshotOutputKey(route.id)
          ).sourceCustody,
          amount = sourceAmountFor(route.source)
        Assert.ok(
          before != null,
          `${SwapRouteCatalog.routeLabel(route)}: no custody baseline`
        )
        const after = await readSourceCustody(ctx, route.source)
        Assert.ok(
          after != null,
          `${SwapRouteCatalog.routeLabel(route)}: no custody balance`
        )
        const expected = match(route.source.sourceKind)
          .with(SwapRouteSourceKind.ERC20, () => before + amount)
          .with(
            SwapRouteSourceKind.SPL,
            SwapRouteSourceKind.WIRE,
            () => before - amount
          )
          .otherwise(() => {
            throw new Error(
              `${SwapRouteCatalog.routeLabel(route)}: custody check not applicable`
            )
          })
        Assert.strictEqual(
          after,
          expected,
          `${SwapRouteCatalog.routeLabel(route)}: source custody mismatch`
        )
      }
    )
  }

  /** Poll for the exact UWREQ whose source id came from this route's request. */
  export function planVerifyUwreqCreated(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "uwreq-correlated",
      `${SwapRouteCatalog.routeLabel(route)}: correlate the exact source request to its UWREQ`,
      async ctx => {
        const sourceRequestId = ctx.outputs.assert(
            SwapRouteSteps.sourceRequestIdOutputKey(route.id)
          ),
          sourceDepotAmount = WireReserveTool.toDepot(
            sourceAmountFor(route.source),
            route.source.sourcePrecision
          )
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: exact source request ${sourceRequestId}`,
          async () => {
            const request = (await readUwreqs(ctx, route)).find(
              row =>
                SwapRouteSteps.decodeUwreqSourceRequestId(row) ===
                sourceRequestId
            )
            if (request == null) return false
            Assert.strictEqual(
              BigInt(request.src_amount),
              sourceDepotAmount,
              `${SwapRouteCatalog.routeLabel(route)}: UWREQ source amount mismatch`
            )
            ctx.outputs.set(uwreqIdOutputKey(route.id), BigInt(request.id))
            return true
          },
          Constants.UwreqDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Poll until the exact UWREQ wins a race and reaches a settled state. */
  export function planVerifyUwreqConfirmed(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "uwreq-confirmed",
      `${SwapRouteCatalog.routeLabel(route)}: exact UWREQ reaches CONFIRMED`,
      async ctx => {
        const id = ctx.outputs.assert(uwreqIdOutputKey(route.id))
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: UWREQ ${id} confirmed`,
          async () => {
            const row = await readUwreq(ctx, route, id)
            return row != null && isConfirmedOrCompleted(row)
          },
          Constants.RaceDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Verify the route's one- or two-leg persistent lock shape. */
  export function planVerifyLocks(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    const expected = expectedLockCount(route)
    return verifyStep<SwapScenarioContext>(
      actor,
      "collateral-locks",
      `${SwapRouteCatalog.routeLabel(route)}: ${expected} expected collateral lock(s) exist`,
      async ctx => {
        const id = ctx.outputs.assert(uwreqIdOutputKey(route.id))
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: ${expected} lock(s) for UWREQ ${id}`,
          async () => (await ctx.locksForUwreq(Number(id))).length === expected,
          Constants.RaceDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Verify exact source/destination reserve-book movement at settlement. */
  export function planVerifyReserveAccounting(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "reserve-accounting",
      `${SwapRouteCatalog.routeLabel(route)}: reserve books match the live curve settlement`,
      async ctx => {
        const snapshot = ctx.outputs.assert(snapshotOutputKey(route.id)),
          sourceAmount = WireReserveTool.toDepot(
            sourceAmountFor(route.source),
            route.source.sourcePrecision
          ),
          target = ctx.outputs.assert(SwapRouteSteps.targetOutputKey(route.id)),
          grossWire =
            snapshot.sourceBook == null
              ? sourceAmount
              : WireReserveTool.tokenToWire(
                  snapshot.sourceBook.chain,
                  snapshot.sourceBook.wire,
                  snapshot.sourceBook.connectorWeightBps,
                  sourceAmount
                ),
          fee = WireReserveTool.splitWireFee(
            grossWire,
            await WireReserveTool.readFeeBps(ctx.wire),
            WireReserveTool.FeeUnderwriterShareBps,
            WireReserveTool.FeeEmissionsShareBps,
            snapshot.sourceBook?.ownerFeeBps ?? 0,
            snapshot.destinationBook?.ownerFeeBps ?? 0
          )
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: reserve books settled`,
          async () => {
            const source = await readReserveBook(ctx, route.source),
              destination = await readReserveBook(ctx, route.destination)
            return (
              booksEqual(
                source,
                snapshot.sourceBook == null
                  ? null
                  : {
                      ...snapshot.sourceBook,
                      chain: snapshot.sourceBook.chain + sourceAmount,
                      wire: snapshot.sourceBook.wire - grossWire
                    }
              ) &&
              booksEqual(
                destination,
                snapshot.destinationBook == null
                  ? null
                  : {
                      ...snapshot.destinationBook,
                      chain: snapshot.destinationBook.chain - target,
                      wire: snapshot.destinationBook.wire + fee.net
                    }
              )
            )
          },
          Constants.RaceDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Wait until the selected route's destination funds have landed. */
  export function planVerifyDestinationPayout(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "destination-funded",
      `${SwapRouteCatalog.routeLabel(route)}: destination receives the variance-adjusted payout`,
      async ctx => {
        const snapshot = ctx.outputs.assert(snapshotOutputKey(route.id)),
          target = ctx.outputs.assert(SwapRouteSteps.targetOutputKey(route.id)),
          minimumDepot =
            target -
            WireReserveTool.varianceDrift(target, Constants.ToleranceBps)
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: destination funds land`,
          async () =>
            route.destination.endpoint === SwapRouteEndpoint.WIRE
              ? (await ctx.wire.getWireClaimable(Constants.WireUserAccount)) >=
                snapshot.destinationClaimable + minimumDepot
              : (await readDestinationBalance(ctx, route.destination)) >=
                snapshot.destinationBalance +
                  WireReserveTool.fromDepot(
                    minimumDepot,
                    route.destination.sourcePrecision
                  ),
          Constants.PayoutDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }

  /** Input for the one explicit `claimwire` destination write. */
  export interface ClaimWireInput extends StepInput {
    readonly kind: "SwapCanarySteps.ClaimWireInput"
    readonly route: SwapRoute
  }

  /** Plan one WIRE-recipient claim after claimable settlement is visible. */
  export function planClaimWire(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, ClaimWireInput> {
    return ClusterBuildStep.create<SwapScenarioContext, ClaimWireInput>(
      actor,
      "claim-wire",
      `${SwapRouteCatalog.routeLabel(route)}: recipient claims its settled WIRE`,
      options,
      { kind: "SwapCanarySteps.ClaimWireInput", route },
      runClaimWire
    )
  }

  /** Named runner for exactly one `sysio.reserv::claimwire` write. */
  export async function runClaimWire(
    ctx: SwapScenarioContext,
    input: ClaimWireInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.strictEqual(
      input.route.destination.endpoint,
      SwapRouteEndpoint.WIRE,
      "claimwire requires a WIRE destination"
    )
    await ctx.wire.claimWire(Constants.WireUserAccount)
  }

  /** Verify a WIRE destination's claim reached its liquid token balance. */
  export function planVerifyWireClaim(
    actor: Report.Actor,
    route: SwapRoute
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "wire-claim-received",
      `${SwapRouteCatalog.routeLabel(route)}: claimed WIRE reaches the liquid balance`,
      async ctx => {
        const snapshot = ctx.outputs.assert(snapshotOutputKey(route.id)),
          target = ctx.outputs.assert(SwapRouteSteps.targetOutputKey(route.id)),
          minimum =
            target -
            WireReserveTool.varianceDrift(target, Constants.ToleranceBps)
        Assert.ok(
          (await ctx.wire.getWireBalance(Constants.WireUserAccount)) >=
            snapshot.destinationBalance + minimum,
          `${SwapRouteCatalog.routeLabel(route)}: claimed WIRE balance is below the payout floor`
        )
      }
    )
  }

  /** Optionally wait for the exact request to complete its challenge window. */
  export function planVerifyChallengeCompleted(
    actor: Report.Actor,
    route: SwapRoute,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<SwapScenarioContext, null> {
    return verifyStep<SwapScenarioContext>(
      actor,
      "challenge-completed",
      `${SwapRouteCatalog.routeLabel(route)}: exact UWREQ reaches COMPLETED`,
      async ctx => {
        const id = ctx.outputs.assert(uwreqIdOutputKey(route.id))
        await pollUntil(
          `${SwapRouteCatalog.routeLabel(route)}: UWREQ ${id} completed`,
          async () => {
            const row = await readUwreq(ctx, route, id)
            return (
              row != null &&
              matchesProtoEnum(
                row.status,
                SysioUwritUnderwriterequeststatus,
                SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_COMPLETED
              )
            )
          },
          Constants.ChallengeDeadlineMs,
          Constants.PollIntervalMs
        )
      },
      options
    )
  }
}

/** Source amount in the asset's native chain units. */
export function sourceAmountFor(asset: SwapRouteAsset): bigint {
  return match(asset.sourcePrecision)
    .with(18, () => Constants.Source18Decimals)
    .with(9, () => Constants.Source9Decimals)
    .with(6, () => Constants.Source6Decimals)
    .otherwise(precision => {
      throw new Error(`${asset.symbol}: unsupported precision ${precision}`)
    })
}

function reserveTriple(asset: SwapRouteAsset): WireReserveTool.ReserveTriple {
  return {
    chainCode: asset.chainCode,
    tokenCode: asset.tokenCode,
    reserveCode: asset.reserveCode
  }
}

async function readReserveBook(
  ctx: SwapScenarioContext,
  asset: SwapRouteAsset
): Promise<ReserveBook> {
  return asset.endpoint === SwapRouteEndpoint.WIRE
    ? null
    : ctx.reserveBook(asset.chainCode, asset.tokenCode, asset.reserveCode)
}

async function readDestinationBalance(
  ctx: SwapScenarioContext,
  asset: SwapRouteAsset
): Promise<bigint> {
  const user = ctx.outputs.assert(swapUserOutputKey())
  return match(asset.sourceKind)
    .with(SwapRouteSourceKind.NATIVE, () =>
      asset.endpoint === SwapRouteEndpoint.ETHEREUM
        ? ctx.ethereum.provider.getBalance(user.ethereumWallet.address)
        : ctx.solana.getLamports(user.solanaKeypair.publicKey).then(BigInt)
    )
    .with(SwapRouteSourceKind.ERC20, () =>
      readErc20Balance(ctx, asset, user.ethereumWallet.address)
    )
    .with(SwapRouteSourceKind.SPL, () => readSplBalance(ctx, asset))
    .with(SwapRouteSourceKind.WIRE, () =>
      ctx.wire.getWireBalance(Constants.WireUserAccount)
    )
    .exhaustive()
}

async function readSourceCustody(
  ctx: SwapScenarioContext,
  asset: SwapRouteAsset
): Promise<bigint> {
  return match(asset.sourceKind)
    .with(SwapRouteSourceKind.ERC20, () =>
      readErc20Balance(ctx, asset, reserveManagerAddress(ctx))
    )
    .with(SwapRouteSourceKind.SPL, () => readSplBalance(ctx, asset))
    .with(SwapRouteSourceKind.WIRE, () =>
      ctx.wire.getWireBalance(Constants.WireUserAccount)
    )
    .otherwise(() => null)
}

function readErc20Balance(
  ctx: SwapScenarioContext,
  asset: SwapRouteAsset,
  owner: string
): Promise<bigint> {
  const address = EthereumCollateralTool.mockErc20Address(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
    asset.symbol
  )
  return contractView<BalanceErc20>(
    address,
    BalanceErc20Abi,
    ctx.ethereum.provider
  ).balanceOf(owner)
}

function readSplBalance(
  ctx: SwapScenarioContext,
  asset: SwapRouteAsset
): Promise<bigint> {
  const user = ctx.outputs.assert(swapUserOutputKey()),
    mint = new PublicKey(
      SolanaFundingTool.solMintAddress(
        ctx.config.dataPath,
        BigInt(asset.tokenCode)
      )
    )
  return ctx.solana.getSplBalance(
    getAssociatedTokenAddressSync(mint, user.solanaKeypair.publicKey)
  )
}

function reserveManagerAddress(ctx: SwapScenarioContext): string {
  const address = EthereumCollateralTool.loadOutpostAddresses(
    ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
  )[ReserveManagerContractName]
  Assert.ok(
    address != null && ethers.isAddress(address),
    `${ReserveManagerContractName} missing from outpost-addrs.json`
  )
  return address
}

async function readUwreqs(
  ctx: SwapScenarioContext,
  route: SwapRoute
): Promise<SysioContracts.SysioUwritUwRequestTType[]> {
  const result = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query({ limit: Constants.TableRowLimit })
  Assert.strictEqual(
    result.more,
    false,
    `swap canary UWREQ scan exceeds ${Constants.TableRowLimit} rows`
  )
  const { rows } = result
  return rows.filter(
    row =>
      slugValue(row.src_chain_code) === route.source.chainCode &&
      slugValue(row.src_token_code) === route.source.tokenCode &&
      reserveCodeMatches(route.source, row.src_reserve_code) &&
      slugValue(row.dst_chain_code) === route.destination.chainCode &&
      slugValue(row.dst_token_code) === route.destination.tokenCode &&
      reserveCodeMatches(route.destination, row.dst_reserve_code)
  )
}

function reserveCodeMatches(
  asset: SwapRouteAsset,
  actual: SysioContracts.SysioUwritSlugNameType
): boolean {
  // The depot-native leg has no reserve row: from-WIRE uses the WIRE-token
  // sentinel while outpost request payloads carry a non-zero target sentinel.
  return (
    asset.endpoint === SwapRouteEndpoint.WIRE ||
    slugValue(actual) === asset.reserveCode
  )
}

async function readUwreq(
  ctx: SwapScenarioContext,
  route: SwapRoute,
  id: bigint
): Promise<SysioContracts.SysioUwritUwRequestTType | undefined> {
  return (await readUwreqs(ctx, route)).find(row => BigInt(row.id) === id)
}

function isConfirmedOrCompleted(
  row: SysioContracts.SysioUwritUwRequestTType
): boolean {
  return (
    matchesProtoEnum(
      row.status,
      SysioUwritUnderwriterequeststatus,
      SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
    ) ||
    matchesProtoEnum(
      row.status,
      SysioUwritUnderwriterequeststatus,
      SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_COMPLETED
    )
  )
}

function expectedLockCount(route: SwapRoute): number {
  return route.source.endpoint === SwapRouteEndpoint.WIRE ||
    route.destination.endpoint === SwapRouteEndpoint.WIRE
    ? 1
    : 2
}

function booksEqual(
  actual: ReserveBook | null,
  expected: ReserveBook | null
): boolean {
  return (
    actual?.chain === expected?.chain &&
    actual?.wire === expected?.wire &&
    actual?.connectorWeightBps === expected?.connectorWeightBps &&
    actual?.ownerFeeBps === expected?.ownerFeeBps
  )
}
