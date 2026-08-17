import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  type ClusterBuildParent,
  type ClusterBuildPhaseBase,
  type SwapScenarioContext
} from "@wireio/cluster-tool"

import { SwapStressSaturationScenarioConstants as Constants } from "@wireio/test-flow-swap-stress-saturation/SwapStressSaturationScenarioConstants.js"
import { SwapStressSaturationScenarioRungSteps as RungSteps } from "@wireio/test-flow-swap-stress-saturation/steps/SwapStressSaturationScenarioRungSteps.js"

/**
 * Minimal build root. `planCampaign` only registers structure at plan time —
 * no runner executes — so the context is never dereferenced and a stub parent
 * is the honest seam rather than a live cluster context.
 */
class StubParent implements ClusterBuildParent<SwapScenarioContext> {
  readonly children: ClusterBuildPhaseBase<SwapScenarioContext>[] = []

  readonly context = {} as SwapScenarioContext

  push(...children: ClusterBuildPhaseBase<SwapScenarioContext>[]): this {
    this.children.push(...children)
    return this
  }
}

/** Phase names registered under a campaign group, in registration order. */
function phaseNames(group: ClusterBuildPhaseGroup<SwapScenarioContext>): string[] {
  return group.children.map(child => child.name)
}

/**
 * The rung phases of a campaign group — every child but the closing
 * `VerifySaturation` phase, typed as the phases they are so their steps are
 * readable.
 */
function rungPhasesOf(
  group: ClusterBuildPhaseGroup<SwapScenarioContext>
): ClusterBuildPhase<SwapScenarioContext>[] {
  return group.children.slice(
    0,
    Constants.Ramp.RungAccountCounts.length
  ) as ClusterBuildPhase<SwapScenarioContext>[]
}

describe("SwapStressSaturationScenarioRungSteps.planCampaign", () => {
  it("registers the campaign as ONE group on the parent", () => {
    // Given: a build root with nothing registered.
    const parent = new StubParent()

    // When: the campaign is planned.
    const group = RungSteps.planCampaign(parent)

    // Then: the parent received exactly one child — the campaign group — so
    // the rung phases never sit flat among the bootstrap's phases.
    expect(parent.children).toEqual([group])
    expect(group).toBeInstanceOf(ClusterBuildPhaseGroup)
    expect(group.name).toBe("RunCampaign")
  })

  it("nests one phase per ramp rung plus the closing saturation verify", () => {
    // Given/When: a planned campaign.
    const group = RungSteps.planCampaign(new StubParent())

    // Then: every rung on the curve has its own phase, in ramp order, and the
    // campaign closes with the cross-rung saturation verification.
    const expected = [
      ...Constants.Ramp.RungAccountCounts.map(count => `Rung-${count}`),
      "VerifySaturation"
    ]
    expect(phaseNames(group)).toEqual(expected)
  })

  it("gives every rung phase its own steps rather than one opaque step", () => {
    // Given/When: a planned campaign.
    const group = RungSteps.planCampaign(new StubParent())

    // Then: each rung decomposes into its individual writes and observations —
    // the whole point of the per-rung tree. A rung collapsed back into a single
    // step would make its failures unattributable in the Report.
    rungPhasesOf(group).forEach(phase => {
      expect(phase.steps.length).toBeGreaterThan(1)
      phase.steps.forEach(step => expect(step.name).toContain("rung-"))
    })
  })

  it("names every rung step for the rung it belongs to", () => {
    // Given/When: a planned campaign.
    const rungPhases = rungPhasesOf(RungSteps.planCampaign(new StubParent()))

    // Then: a step's name carries its own rung's account count, so a Report row
    // identifies the rung without reading the enclosing phase.
    Constants.Ramp.RungAccountCounts.forEach((accountCount, rungIndex) => {
      const prefix = `rung-${accountCount}-`
      rungPhases[rungIndex].steps.forEach(step =>
        expect(step.name.startsWith(prefix)).toBe(true)
      )
    })
  })
})
