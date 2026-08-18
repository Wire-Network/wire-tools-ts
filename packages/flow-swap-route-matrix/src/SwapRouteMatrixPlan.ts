import { match } from "ts-pattern"

import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Report,
  SwapScenarioContext,
  type ClusterBuildParent,
  type ClusterBuildStep,
  type ClusterBuildStepOptions
} from "@wireio/cluster-tool"

import {
  type SwapRoute,
  SwapRouteEndpoint,
  SwapRouteMatrixScenarioConstants as Constants,
  SwapRouteSourceKind
} from "./SwapRouteMatrixScenarioConstants.js"
import { SwapRouteMatrixScenarioSteps as Steps } from "./steps/index.js"

const { Actor } = Report

/**
 * Compose the complete configured swap matrix under any FlowScenario parent.
 * The hierarchy is Family PhaseGroup → Direction PhaseGroup → exact Route
 * Phase → lifecycle Steps.
 *
 * @param parent - Build root or enclosing phase group.
 * @returns The self-registered top-level matrix phase group.
 */
export function planSwapRouteMatrix(
  parent: ClusterBuildParent<SwapScenarioContext>
): ClusterBuildPhaseGroup<SwapScenarioContext> {
  const matrix = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
    parent,
    "SwapRouteMatrix",
    `${Constants.AllRoutes.length} configured routes`
  )
  Constants.RouteFamilies.forEach(family => {
    const familyGroup = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
      matrix,
      family.name,
      family.description
    )
    family.directions.forEach(direction => {
      const directionGroup = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
        familyGroup,
        direction.name,
        direction.description
      )
      direction.routes.forEach(route => planSwapRoute(directionGroup, route))
    })
  })
  return matrix
}

/** Compose one exact token-pair route as a lifecycle phase. */
function planSwapRoute(
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
    steps: ClusterBuildStep.Any<SwapScenarioContext>[] = [
      Steps.planPrepareRoute(
        Actor.User,
        "prepare-route",
        `${route.label}: quote and snapshot source/UWREQ baselines`,
        {},
        route
      ),
      ...planSourceAuthorization(route),
      Steps.planRequestRoute(
        Actor.User,
        "request-swap",
        `${route.label}: submit the source-token swap request`,
        { timeoutMs: Constants.WriteTimeoutMs },
        route
      ),
      ...planSourceCustodyVerification(route),
      Steps.planVerifyUwreqCreated(
        Actor.Sysio,
        "uwreq-created",
        `${route.label}: an exact new UWREQ reaches the depot`,
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
        payoutActor(route),
        "payout-received",
        `${route.label}: destination receives the variance-adjusted target`,
        payoutOptions,
        route
      )
    ]

  return ClusterBuildPhase.create<SwapScenarioContext>(
    parent,
    phaseName(route),
    `${route.label}: authorization, request, custody, underwriting, locks, and payout`,
    steps
  )
}

/** Source-specific permit/approval step, empty for native/SPL/WIRE paths. */
function planSourceAuthorization(
  route: SwapRoute
): ClusterBuildStep.Any<SwapScenarioContext>[] {
  return match(route.source.sourceKind)
    .with(SwapRouteSourceKind.Erc20Permit, () => [
      Steps.planSignPermit(
        Actor.User,
        "sign-permit",
        `${route.label}: sign an EIP-2612 permit for the exact source amount`,
        { timeoutMs: Constants.WriteTimeoutMs },
        route
      )
    ])
    .with(SwapRouteSourceKind.Erc20Approval, () => [
      Steps.planApproveErc20Spend(
        Actor.User,
        "approve-spend",
        `${route.label}: approve ReserveManager for the exact source amount`,
        { timeoutMs: Constants.WriteTimeoutMs },
        route
      )
    ])
    .otherwise(() => [])
}

/** Source-custody assertion for ERC-20/SPL paths, empty for native/WIRE. */
function planSourceCustodyVerification(
  route: SwapRoute
): ClusterBuildStep.Any<SwapScenarioContext>[] {
  return match(route.source.sourceKind)
    .with(
      SwapRouteSourceKind.Erc20Permit,
      SwapRouteSourceKind.Erc20Approval,
      SwapRouteSourceKind.Spl,
      () => [
        Steps.planVerifySourceCustody(
          sourceActor(route),
          "source-custody",
          `${route.label}: the exact source amount leaves the user or reaches custody`,
          { timeoutMs: Constants.WriteTimeoutMs },
          route
        )
      ]
    )
    .otherwise(() => [])
}

/** Stable PascalCase phase name derived from exact source/destination ids. */
function phaseName(route: SwapRoute): string {
  return route.id
    .split("-")
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")
}

/** Report actor owning source custody. */
function sourceActor(route: SwapRoute): Report.Actor {
  return route.source.endpoint === SwapRouteEndpoint.Ethereum
    ? Actor.EthereumOutpost
    : Actor.SolanaOutpost
}

/** Report actor owning destination payout. */
function payoutActor(route: SwapRoute): Report.Actor {
  return route.destination.endpoint === SwapRouteEndpoint.Ethereum
    ? Actor.EthereumOutpost
    : route.destination.endpoint === SwapRouteEndpoint.Solana
      ? Actor.SolanaOutpost
      : Actor.Sysio
}
