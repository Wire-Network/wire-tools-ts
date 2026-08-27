import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuild,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ReadinessPhaseGroups
} from "@wireio/cluster-tool/orchestration"
import {
  ConnectedReadinessContext,
  createReadinessConfig
} from "@wireio/cluster-tool/readiness"

function newBuild(hyperionUrl?: string) {
  const context = new ConnectedReadinessContext(
      createReadinessConfig({
        wireRpc: "https://wire.example",
        ethereumRpc: "https://ethereum.example",
        solanaRpc: "https://solana.example",
        hyperionUrl,
        observationMs: 100,
        timeoutMs: 100,
        report: { path: "/tmp", basename: "readiness", formats: [] }
      }),
      getLogger("readiness-phase-groups-test")
    ),
    build = ClusterBuild.forContext(context)
  ReadinessPhaseGroups.plan(build)
  return build
}

describe("ReadinessPhaseGroups", () => {
  it("plans native cluster and swap phases without SDK-outpost checks", () => {
    const group = newBuild().children[0]
    expect(group).toBeInstanceOf(ClusterBuildPhaseGroup)
    const phases = (group as ClusterBuildPhaseGroup<ConnectedReadinessContext>)
        .children,
      stepNames = phases
        .filter(
          (phase): phase is ClusterBuildPhase<ConnectedReadinessContext> =>
            phase instanceof ClusterBuildPhase
        )
        .flatMap(phase => phase.steps.map(step => step.name))
    expect(phases.map(phase => phase.name)).toEqual([
      "Explicit endpoint identities",
      "Chain liveness",
      "Swap protocol configuration",
      "Swap capacity",
      "Read-only swap routes"
    ])
    expect(stepNames).toHaveLength(19)
    expect(stepNames).toContain("route-quotes")
    expect(stepNames).not.toContain("external-custody")
    expect(stepNames).not.toContain("sdk-outpost")
    expect(stepNames).not.toContain("hyperion-health")
  })

  it("only plans Hyperion when the caller supplies it", () => {
    const group = newBuild("https://hyperion.example").children[0],
      phases = (group as ClusterBuildPhaseGroup<ConnectedReadinessContext>)
        .children,
      stepNames = phases
        .filter(
          (phase): phase is ClusterBuildPhase<ConnectedReadinessContext> =>
            phase instanceof ClusterBuildPhase
        )
        .flatMap(phase => phase.steps.map(step => step.name))
    expect(stepNames).toContain("hyperion-health")
  })
})
