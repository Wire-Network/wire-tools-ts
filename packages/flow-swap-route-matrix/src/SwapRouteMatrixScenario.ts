import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Constants as HarnessConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildParent,
  type ClusterBuildStepOptions,
  type Logger
} from "@wireio/cluster-tool"
import {
  type SwapRoute,
  SwapRouteEndpoint,
  SwapRouteMatrixScenarioConstants as Constants
} from "./SwapRouteMatrixScenarioConstants.js"
import { SwapRouteMatrixScenarioSteps as Steps } from "./steps/index.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/**
 * Serial six-route conformance matrix for the native ETH, SOL, and WIRE
 * endpoints. Each direction is a Phase with explicit quote, request, UWREQ,
 * race, lock, and payout Steps. The three route families are PhaseGroups so
 * the generated report remains readable without introducing a second runner.
 */
export class SwapRouteMatrixScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-route-matrix"
  readonly description =
    "Serial native route matrix: ETH ↔ SOL, ETH/SOL → WIRE, and WIRE → ETH/SOL"

  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true,
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

  /** Create the shared swap-aware context used by every route step. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  /** Append shared prerequisites followed by the three serial route families. */
  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const underwriterLabels = Array.from(
        { length: cluster.context.config.underwriterCount },
        (_, index) => HarnessConstants.underwriterLabel(index)
      ),
      writeOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.WriteTimeoutMs
      },
      activeOptions: ClusterBuildStepOptions = {
        timeoutMs:
          Constants.UnderwriterActiveDeadlineMs + Constants.PollDeadlineBufferMs
      }

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "PrerequisiteHealth",
      "WIRE produces blocks and both native public reserves are seeded"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "chain-producing",
        "WIRE chain reports a positive head block",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            "WIRE head_block_num must be positive"
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "ethereum-reserve-seeded",
        "ETHEREUM/ETH/PRIMARY reserve exists",
        async ctx => {
          await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrimaryReserveCode
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "solana-reserve-seeded",
        "SOLANA/SOL/PRIMARY reserve exists",
        async ctx => {
          await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
        }
      )
    )

    SwapUserIdentities.planIdentityProvisioning<SwapScenarioContext>(
      cluster,
      "SwapUser",
      "Provision one paired Ethereum and Solana swap identity",
      writeOptions
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "WireUser",
      "Provision the WIRE recipient and funded from-WIRE depositor"
    ).push(
      Steps.planProvisionWireUser(
        Actor.User,
        "provision-wire-user",
        `provision and fund ${Constants.WireUserAccount}`,
        writeOptions,
        Constants.WireUserAccount,
        Constants.WireUserFunding
      )
    )

    WireUnderwriterTool.planCollateralDeposit<SwapScenarioContext>(
      cluster,
      "UnderwriterCollateral",
      "Bond the existing default native collateral on both outposts",
      writeOptions,
      underwriterLabels,
      WireUnderwriterTool.load(null, cluster.context.config.underwriterCount)
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "UnderwriterActivation",
      "Wait for both native bonds to credit and activate every underwriter"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "underwriters-active",
        "every configured underwriter reaches OPERATOR_STATUS_ACTIVE",
        async ctx => {
          await pollUntil(
            "all matrix underwriters ACTIVE",
            () => readAllUnderwritersActive(ctx, underwriterLabels),
            Constants.UnderwriterActiveDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        activeOptions
      )
    )

    planRouteGroup(
      cluster,
      "CrossOutpostRoutes",
      "Two-leg native swaps between Ethereum and Solana",
      Constants.CrossOutpostRoutes
    )
    planRouteGroup(
      cluster,
      "ExternalToWireRoutes",
      "Single-leg native swaps paid directly in WIRE",
      Constants.ExternalToWireRoutes
    )
    planRouteGroup(
      cluster,
      "WireToExternalRoutes",
      "Queued WIRE escrows paid on an external outpost",
      Constants.WireToExternalRoutes
    )
  }
}

/** Add one serial route-family PhaseGroup with one Phase per direction. */
function planRouteGroup(
  parent: ClusterBuildParent<SwapScenarioContext>,
  name: string,
  description: string,
  routes: readonly SwapRoute[]
): ClusterBuildPhaseGroup<SwapScenarioContext> {
  const group = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
    parent,
    name,
    description
  )
  routes.forEach(route => planRoutePhase(group, route))
  return group
}

/** Add the lifecycle Steps for one directional route. */
function planRoutePhase(
  parent: ClusterBuildParent<SwapScenarioContext>,
  route: SwapRoute
): ClusterBuildPhase<SwapScenarioContext> {
  const uwreqOptions: ClusterBuildStepOptions = {
      timeoutMs: Constants.UwreqDeadlineMs + Constants.PollDeadlineBufferMs
    },
    raceOptions: ClusterBuildStepOptions = {
      timeoutMs: Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
    },
    payoutOptions: ClusterBuildStepOptions = {
      timeoutMs: Constants.PayoutDeadlineMs + Constants.PollDeadlineBufferMs
    },
    payoutActor =
      route.destination === SwapRouteEndpoint.Ethereum
        ? Actor.EthereumOutpost
        : route.destination === SwapRouteEndpoint.Solana
          ? Actor.SolanaOutpost
          : Actor.Sysio

  return ClusterBuildPhase.create<SwapScenarioContext>(
    parent,
    phaseName(route),
    `${route.label}: quote, request, underwriting, lock shape, and payout`,
    [
      Steps.planPrepareRoute(
        Actor.User,
        "prepare-route",
        `${route.label}: read live quote and route-specific baselines`,
        {},
        route
      ),
      Steps.planRequestRoute(
        Actor.User,
        "request-swap",
        `${route.label}: submit the source endpoint swap request`,
        { timeoutMs: Constants.WriteTimeoutMs },
        route
      ),
      Steps.planVerifyUwreqCreated(
        Actor.Sysio,
        "uwreq-created",
        `${route.label}: a new route-specific UWREQ reaches the depot`,
        uwreqOptions,
        route
      ),
      Steps.planVerifyUwreqConfirmed(
        Actor.Underwriter,
        "uwreq-confirmed",
        `${route.label}: the underwriter race confirms the request`,
        raceOptions,
        route
      ),
      Steps.planVerifyLocks(
        Actor.Sysio,
        "locks-correct",
        `${route.label}: ${route.expectedLockCount} expected collateral lock(s) exist`,
        raceOptions,
        route
      ),
      Steps.planVerifyPayout(
        payoutActor,
        "payout-received",
        `${route.label}: destination balance receives the variance-adjusted target`,
        payoutOptions,
        route
      )
    ]
  )
}

/** Stable PascalCase phase name derived from a route id. */
function phaseName(route: SwapRoute): string {
  return route.id
    .split("-")
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")
}

/** Read whether every configured underwriter is ACTIVE on the depot. */
async function readAllUnderwritersActive(
  ctx: SwapScenarioContext,
  underwriterLabels: string[]
): Promise<boolean> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorTableRowLimit })
  return underwriterLabels.every(label => {
    const account = ctx.keyStore.assertOperator(label).account,
      row = rows.find(candidate => candidate.account === account)
    return (
      row != null &&
      matchesProtoEnum(
        row.status,
        SysioOpregOperatorstatus,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      )
    )
  })
}
