import { ClusterBuild } from "@wireio/cluster-tool/orchestration/ClusterBuild"
import { ClusterBuildPhase } from "@wireio/cluster-tool/orchestration/ClusterBuildPhase"
import { ClusterBuildPhaseGroup } from "@wireio/cluster-tool/orchestration/ClusterBuildPhaseGroup"
import { SwapCanaryPhaseGroups } from "@wireio/cluster-tool/orchestration/phases/SwapCanaryPhaseGroups"
import {
  SwapRouteCatalog,
  SwapRouteSelector
} from "@wireio/cluster-tool/tools/all/SwapRouteCatalog"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import type { SwapScenarioContext } from "@wireio/cluster-tool/flow/contexts/SwapScenarioContext"

function createPlan(
  provisionUnderwriterCollateral: boolean,
  waitForChallenge = false
) {
  const context = {
      config: { underwriterCount: 1 }
    } as SwapScenarioContext,
    cluster = ClusterBuild.forContext(context)
  SwapCanaryPhaseGroups.plan(cluster, {
    availableRoutes: SwapRouteCatalog.fromReserveRegistrations(
      Steps.registry.MockReserveRegistrations
    ),
    routes: [SwapRouteSelector.canary],
    waitForChallenge,
    provisionUnderwriterCollateral
  })
  return cluster
}

function routePhases(cluster: ReturnType<typeof createPlan>) {
  const root = cluster.children.find(
    child => child.name === "SwapCanaryRoutes"
  ) as ClusterBuildPhaseGroup<SwapScenarioContext>
  return root.children.flatMap(
    direction =>
      (direction as ClusterBuildPhaseGroup<SwapScenarioContext>).children
  ) as ClusterBuildPhase<SwapScenarioContext>[]
}

describe("SwapCanaryPhaseGroups", () => {
  it("plans six representative canary routes in both lifecycle modes", () => {
    expect(routePhases(createPlan(true))).toHaveLength(6)
    expect(routePhases(createPlan(false))).toHaveLength(6)
  })

  it("provisions collateral only for a fresh-cluster run", () => {
    const freshNames = createPlan(true).children.map(child => child.name),
      connectedNames = createPlan(false).children.map(child => child.name)
    expect(freshNames).toContain("UnderwriterCollateral")
    expect(connectedNames).not.toContain("UnderwriterCollateral")
    expect(connectedNames).toEqual(
      expect.arrayContaining([
        "PrerequisiteHealth",
        "SwapUser",
        "WireUser",
        "UnderwriterReadiness",
        "SwapCanaryRoutes"
      ])
    )
  })

  it("adds challenge completion to every selected route only when requested", () => {
    routePhases(createPlan(false, false)).forEach(phase =>
      expect(phase.steps.map(step => step.name)).not.toContain(
        "challenge-completed"
      )
    )
    routePhases(createPlan(false, true)).forEach(phase =>
      expect(phase.steps.map(step => step.name)).toContain("challenge-completed")
    )
  })
})
