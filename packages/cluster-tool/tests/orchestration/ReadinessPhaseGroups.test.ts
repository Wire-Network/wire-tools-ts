import { ClusterReadinessFeature } from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuild,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ReadinessPhaseGroups
} from "@wireio/cluster-tool/orchestration"
import { ReadinessContext } from "@wireio/cluster-tool/readiness"
import { createReadinessDeploymentProfileFixture } from "../readiness/readinessProfileFixture.js"

function buildFor(feature: ClusterReadinessFeature) {
  const context = new ReadinessContext(
      {
        feature,
        catalogUrl: "https://catalog.example",
        requestedWireChainId: "a".repeat(64),
        outpostDeploymentProfile: createReadinessDeploymentProfileFixture(),
        endpoints: [],
        catalogRecordCount: 0,
        catalogErrors: [],
        observationMs: 1,
        timeoutMs: 1,
        report: { path: "/tmp", basename: "readiness", formats: [] }
      },
      getLogger("readiness-plan-test")
    ),
    build = ClusterBuild.forContext(context)
  ReadinessPhaseGroups.plan(build, feature)
  return build
}

describe("ReadinessPhaseGroups", () => {
  it("plans the comprehensive swap preflight as native phases and steps", () => {
    const group = buildFor(ClusterReadinessFeature.swap).children[0]
    expect(group).toBeInstanceOf(ClusterBuildPhaseGroup)
    expect(group.name).toBe("swap-readiness")
    const phases = (group as ClusterBuildPhaseGroup<ReadinessContext>).children
    expect(phases.map(phase => phase.name)).toEqual([
      "Endpoint discovery",
      "Cluster health",
      "Outpost deployment",
      "Swap protocol configuration",
      "Swap infrastructure",
      "Swap routes"
    ])
    const stepNames = phases
      .filter(
        (phase): phase is ClusterBuildPhase<ReadinessContext> =>
          phase instanceof ClusterBuildPhase
      )
      .flatMap(phase => phase.steps.map(step => step.name))
    expect(stepNames).toHaveLength(25)
    expect(stepNames).toContain("external-custody")
  })

  it("keeps stake present but intentionally nonfunctional", () => {
    const group = buildFor(ClusterReadinessFeature.stake).children[0]
    expect(group.name).toBe("stake-readiness")
    const phases = (group as ClusterBuildPhaseGroup<ReadinessContext>).children,
      stepNames = phases
        .filter(
          (phase): phase is ClusterBuildPhase<ReadinessContext> =>
            phase instanceof ClusterBuildPhase
        )
        .flatMap(phase => phase.steps.map(step => step.name))
    expect(phases.map(phase => phase.name)).toEqual([
      "Endpoint discovery",
      "Cluster health",
      "Outpost deployment",
      "Stake protocol"
    ])
    expect(stepNames).toContain("stake-lifecycle")
    expect(stepNames).not.toContain("wire-contracts")
    expect(stepNames).not.toContain("route-quotes")
  })
})
