import Assert from "node:assert"

import type {
  ChainTokenAmount,
  ClusterConfig
} from "@wireio/cluster-tool-shared"
import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import type { ArgumentsCamelCase, Argv } from "yargs"

import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Constants as HarnessConstants,
  EthereumFundingTool,
  FlowScenario,
  Report,
  SolanaFundingTool,
  Steps as HarnessSteps,
  SwapRouteCatalog,
  SwapRouteEndpoint,
  SwapRouteSelector,
  SwapRouteSourceKind,
  SwapRouteSteps,
  SwapScenarioContext,
  SwapUserIdentities,
  WireUnderwriterTool,
  WireUserTool,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildParent,
  type ClusterBuildStep,
  type ClusterBuildStepOptions,
  type FlowScenarioArguments,
  type Logger,
  type SwapRoute,
  type SwapRouteAsset,
  type SwapRouteDirection
} from "@wireio/cluster-tool"

import { SwapCanaryScenarioConstants as Constants } from "./SwapCanaryScenarioConstants.js"
import {
  sourceAmountFor,
  SwapCanaryScenarioSteps as CanarySteps
} from "./steps/index.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** Scenario-only CLI arguments. Selectors are unioned and de-duplicated. */
export interface SwapCanaryArguments extends FlowScenarioArguments {
  readonly routes: readonly SwapRouteSelector[]
  readonly waitForChallenge: boolean
}

/** Configurable, serial canary over the canonical public swap-route catalog. */
export class SwapCanaryScenario extends FlowScenario<
  SwapScenarioContext,
  SwapCanaryArguments
> {
  readonly name = "flow-swap-canary"
  readonly description =
    "Configurable canary for public ETH, SOL, and WIRE swap routes"

  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true,
    epochDurationSec: Constants.EpochDurationSec,
    requiredUnderwriterCollateral: [
      {
        chainCode: SlugName.from("ETHEREUM"),
        tokenCode: SlugName.from("ETH"),
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: SlugName.from("SOLANA"),
        tokenCode: SlugName.from("SOL"),
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  /** Add the repeatable route selector and optional challenge wait. */
  override configureArguments(yargs: Argv): Argv {
    return yargs
      .option("routes", {
        type: "string",
        array: true,
        choices: Object.values(SwapRouteSelector),
        default: [SwapRouteSelector.canary],
        description:
          "Route selector; repeat to union groups (default: six native endpoint routes)"
      })
      .option("wait-for-challenge", {
        type: "boolean",
        default: false,
        description: "Wait for each exact UWREQ to reach COMPLETED"
      })
  }

  /** Validate raw yargs into the scenario's small typed planning surface. */
  override parseArguments(argv: ArgumentsCamelCase): SwapCanaryArguments {
    const raw = Array.isArray(argv.routes)
      ? argv.routes.map(String)
      : [String(argv.routes ?? SwapRouteSelector.canary)]
    return {
      routes: SwapRouteCatalog.parseSelectors(raw),
      waitForChallenge: Boolean(argv.waitForChallenge)
    }
  }

  /** Create the shared swap query context. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  /** Compose prerequisites and selected route phases on the canonical engine. */
  override plan(
    cluster: ClusterBuild<SwapScenarioContext>,
    args: SwapCanaryArguments
  ): void {
    const catalog = SwapRouteCatalog.fromReserveRegistrations(
        HarnessSteps.registry.MockReserveRegistrations
      ),
      routes = SwapRouteCatalog.select(catalog, args.routes),
      underwriterLabels = Array.from(
        { length: cluster.context.config.underwriterCount },
        (_, index) => HarnessConstants.underwriterLabel(index)
      ),
      collateral = buildUnderwriterCollateral(
        catalog,
        routes,
        underwriterLabels.length
      ),
      writeOptions = { timeoutMs: Constants.WriteTimeoutMs },
      activeOptions = {
        timeoutMs:
          Constants.UnderwriterActiveDeadlineMs + Constants.PollDeadlineBufferMs
      }

    Assert.ok(routes.length > 0, "flow-swap-canary selected no routes")

    planPrerequisiteHealth(cluster, routes)
    SwapUserIdentities.planIdentityProvisioning<SwapScenarioContext>(
      cluster,
      "SwapUser",
      "Provision one paired Ethereum and Solana swap identity",
      writeOptions
    )
    if (routes.some(route => routeTouchesWire(route))) {
      planWireUser(cluster, writeOptions)
    }
    planSourceFunding(cluster, routes, writeOptions)

    WireUnderwriterTool.planCollateralDeposit<SwapScenarioContext>(
      cluster,
      "UnderwriterCollateral",
      "Bond every selected external token plus native activation legs",
      writeOptions,
      underwriterLabels,
      collateral
    )
    planUnderwriterReadiness(
      cluster,
      underwriterLabels,
      collateral,
      activeOptions
    )
    planSelectedRoutes(cluster, routes, args.waitForChallenge)
  }
}

function planPrerequisiteHealth(
  cluster: ClusterBuild<SwapScenarioContext>,
  routes: readonly SwapRoute[]
): void {
  const assets = uniqueExternalAssets(routes)
  ClusterBuildPhase.create<SwapScenarioContext>(
    cluster,
    "PrerequisiteHealth",
    "WIRE is producing and every selected public reserve exists",
    [
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "wire-producing",
        "WIRE reports a positive head block",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            "WIRE head_block_num must be positive"
          )
        }
      ),
      ...assets.map(asset =>
        verifyStep<SwapScenarioContext>(
          Actor.Sysio,
          `reserve-${asset.symbol.toLowerCase()}`,
          `${asset.endpoint}/${asset.symbol}/PRIMARY reserve exists`,
          async ctx => {
            await ctx.reserveBook(
              asset.chainCode,
              asset.tokenCode,
              asset.reserveCode
            )
          }
        )
      )
    ]
  )
}

function planWireUser(
  cluster: ClusterBuild<SwapScenarioContext>,
  options: ClusterBuildStepOptions
): void {
  ClusterBuildPhase.create<SwapScenarioContext>(
    cluster,
    "WireUser",
    "Provision the shared WIRE recipient and from-WIRE depositor",
    [
      WireUserTool.planAccountCreation(
        Actor.User,
        "create-wire-user",
        `create ${Constants.WireUserAccount}`,
        options,
        Constants.WireUserAccount
      ),
      WireUserTool.planResourcePolicy(
        Actor.User,
        "wire-user-policy",
        `attach the standard resource policy to ${Constants.WireUserAccount}`,
        options,
        Constants.WireUserAccount
      ),
      WireUserTool.planFunding(
        Actor.User,
        "fund-wire-user",
        `fund ${Constants.WireUserAccount} for from-WIRE routes`,
        options,
        Constants.WireUserAccount,
        Constants.WireUserFunding
      )
    ]
  )
}

function planSourceFunding(
  cluster: ClusterBuild<SwapScenarioContext>,
  routes: readonly SwapRoute[],
  options: ClusterBuildStepOptions
): void {
  const sources = uniqueAssets(routes.map(route => route.source)).filter(
    source =>
      source.sourceKind === SwapRouteSourceKind.ERC20 ||
      source.sourceKind === SwapRouteSourceKind.SPL
  )
  if (sources.length === 0) return
  ClusterBuildPhase.create<SwapScenarioContext>(
    cluster,
    "SourceFunding",
    "Fund selected non-native swap sources",
    sources.map(source => {
      const amount = sourceAmountFor(source) * Constants.UserFundingMultiple
      return source.sourceKind === SwapRouteSourceKind.ERC20
        ? EthereumFundingTool.planErc20MintToSwapUser(
            Actor.User,
            `fund-${source.symbol.toLowerCase()}`,
            `fund the swap user with mock ${source.symbol}`,
            options,
            source.symbol,
            amount
          )
        : SolanaFundingTool.planSplMintToSwapUser(
            Actor.User,
            `fund-${source.symbol.toLowerCase()}`,
            `fund the swap user with mock ${source.symbol}`,
            options,
            BigInt(source.tokenCode),
            amount
          )
    })
  )
}

function planUnderwriterReadiness(
  cluster: ClusterBuild<SwapScenarioContext>,
  labels: string[],
  collateral: ChainTokenAmount[][],
  options: ClusterBuildStepOptions
): void {
  ClusterBuildPhase.create<SwapScenarioContext>(
    cluster,
    "UnderwriterReadiness",
    "Wait for selected bonds to relay and every underwriter to activate"
  ).push(
    verifyStep<SwapScenarioContext>(
      Actor.Underwriter,
      "bonds-and-status-active",
      "every selected bond is credited and every underwriter is ACTIVE",
      async ctx => {
        await pollUntil(
          "selected collateral credited and underwriters ACTIVE",
          async () => {
            const { rows } = await ctx.wire
              .getSysioContract(SysioContractName.opreg)
              .tables.operators.query({ limit: Constants.TableRowLimit })
            return labels.every((label, index) => {
              const account = ctx.keyStore.assertOperator(label).account,
                operator = rows.find(row => row.account === account)
              return (
                operator != null &&
                matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                ) &&
                collateral[index].every(entry =>
                  operator.balances.some(
                    balance =>
                      slugValue(balance.chain_code) === entry.chain_code &&
                      slugValue(balance.token_code) ===
                        Number(entry.amount.tokenCode) &&
                      BigInt(balance.balance) >= entry.amount.amount
                  )
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
  )
}

function planSelectedRoutes(
  cluster: ClusterBuild<SwapScenarioContext>,
  routes: readonly SwapRoute[],
  waitForChallenge: boolean
): void {
  const root = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
    cluster,
    "SwapCanaryRoutes",
    `${routes.length} selected public route(s), serial and fail-fast`
  )
  uniqueDirections(routes).forEach(direction => {
    const group = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
      root,
      pascalCase(direction),
      `Selected ${direction} routes`
    )
    routes
      .filter(route => route.direction === direction)
      .forEach(route => planRoute(group, route, waitForChallenge))
  })
}

function planRoute(
  parent: ClusterBuildParent<SwapScenarioContext>,
  route: SwapRoute,
  waitForChallenge: boolean
): void {
  const uwreqOptions = {
      timeoutMs: Constants.UwreqDeadlineMs + Constants.PollDeadlineBufferMs
    },
    raceOptions = {
      timeoutMs: Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
    },
    payoutOptions = {
      timeoutMs: Constants.PayoutDeadlineMs + Constants.PollDeadlineBufferMs
    },
    writeOptions = { timeoutMs: Constants.WriteTimeoutMs },
    steps: ClusterBuildStep.Any<SwapScenarioContext>[] = [
      CanarySteps.planPrepareRoute(sourceActor(route), route)
    ]

  if (route.source.sourceKind === SwapRouteSourceKind.ERC20) {
    steps.push(
      SwapRouteSteps.planErc20Approval(
        Actor.User,
        "approve-source",
        `${routeLabel(route)}: approve ReserveManager for the source amount`,
        writeOptions,
        route,
        sourceAmountFor(route.source)
      )
    )
  }
  steps.push(
    SwapRouteSteps.planRequest(
      Actor.User,
      "request-swap",
      `${routeLabel(route)}: submit exactly one source request`,
      writeOptions,
      route,
      sourceAmountFor(route.source),
      Constants.ToleranceBps,
      Constants.WireUserAccount
    )
  )
  if (route.source.sourceKind !== SwapRouteSourceKind.NATIVE) {
    steps.push(CanarySteps.planVerifySourceCustody(sourceActor(route), route))
  }
  steps.push(
    CanarySteps.planVerifyUwreqCreated(Actor.Sysio, route, uwreqOptions),
    CanarySteps.planVerifyUwreqConfirmed(Actor.Underwriter, route, raceOptions),
    CanarySteps.planVerifyLocks(Actor.Sysio, route, raceOptions),
    CanarySteps.planVerifyReserveAccounting(Actor.Sysio, route, raceOptions),
    CanarySteps.planVerifyDestinationPayout(
      destinationActor(route),
      route,
      payoutOptions
    )
  )
  if (route.destination.endpoint === SwapRouteEndpoint.WIRE) {
    steps.push(
      CanarySteps.planClaimWire(Actor.User, route, writeOptions),
      CanarySteps.planVerifyWireClaim(Actor.User, route)
    )
  }
  if (waitForChallenge) {
    steps.push(
      CanarySteps.planVerifyChallengeCompleted(Actor.Sysio, route, {
        timeoutMs:
          Constants.ChallengeDeadlineMs + Constants.PollDeadlineBufferMs
      })
    )
  }
  ClusterBuildPhase.create<SwapScenarioContext>(
    parent,
    pascalCase(route.id),
    `${routeLabel(route)} request, exact underwriting, accounting, and payout`,
    steps
  )
}

function buildUnderwriterCollateral(
  catalog: readonly SwapRoute[],
  selected: readonly SwapRoute[],
  underwriterCount: number
): ChainTokenAmount[][] {
  const nativeActivationAssets = uniqueExternalAssets(catalog).filter(asset =>
      ["ETH", "SOL"].includes(asset.symbol)
    ),
    assets = uniqueAssets([
      ...nativeActivationAssets,
      ...uniqueExternalAssets(selected)
    ]),
    uniform = assets.map(asset => ({
      chain_code: asset.chainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(asset.tokenCode),
        amount: Constants.UnderwriterCollateralAmount
      })
    }))
  return Array.from({ length: underwriterCount }, () => uniform.slice())
}

function uniqueExternalAssets(routes: readonly SwapRoute[]): SwapRouteAsset[] {
  return uniqueAssets(
    routes
      .flatMap(route => [route.source, route.destination])
      .filter(asset => asset.endpoint !== SwapRouteEndpoint.WIRE)
  )
}

function uniqueAssets(assets: readonly SwapRouteAsset[]): SwapRouteAsset[] {
  const seen = new Set<string>()
  return assets.filter(asset => {
    const key = `${asset.chainCode}:${asset.tokenCode}:${asset.reserveCode}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueDirections(routes: readonly SwapRoute[]): SwapRouteDirection[] {
  return [...new Set(routes.map(route => route.direction))]
}

function sourceActor(route: SwapRoute): Report.Actor {
  return route.source.endpoint === SwapRouteEndpoint.ETHEREUM
    ? Actor.EthereumOutpost
    : route.source.endpoint === SwapRouteEndpoint.SOLANA
      ? Actor.SolanaOutpost
      : Actor.Sysio
}

function destinationActor(route: SwapRoute): Report.Actor {
  return route.destination.endpoint === SwapRouteEndpoint.ETHEREUM
    ? Actor.EthereumOutpost
    : route.destination.endpoint === SwapRouteEndpoint.SOLANA
      ? Actor.SolanaOutpost
      : Actor.Sysio
}

function routeLabel(route: SwapRoute): string {
  return `${route.source.symbol}→${route.destination.symbol}`
}

function routeTouchesWire(route: SwapRoute): boolean {
  return (
    route.source.endpoint === SwapRouteEndpoint.WIRE ||
    route.destination.endpoint === SwapRouteEndpoint.WIRE
  )
}

function pascalCase(value: string): string {
  return value
    .split("-")
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")
}
