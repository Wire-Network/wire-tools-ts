import Path from "node:path"
import type { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ClusterBuildDefaults,
  type ClusterBuildContext,
  type ClusterBuildPhaseBase,
  type Steps
} from "@wireio/cluster-tool/orchestration"
import { fixtureResolveEnvironment, type ResolveEnvironment } from "../config/resolveEnvironmentFixture.js"

/** The bootstrap phase holding the single `uwrit::setconfig` step. */
const UnderwriterConfigPhaseName = "UnderwriterConfig"
/** That phase's one step. */
const ConfigureUwritStepName = "configure-uwrit"

/**
 * Depth-first search of the composed tree for the phase registered under
 * `name`. A {@link ClusterBuildPhaseGroup} carries `children`; a
 * {@link ClusterBuildPhase} is the leaf that carries `steps`.
 */
function findPhase<C extends ClusterBuildContext>(
  children: ReadonlyArray<ClusterBuildPhaseBase<C>>,
  name: string
): ClusterBuildPhase<C> {
  return children.reduce<ClusterBuildPhase<C>>(
    (found, child) =>
      found ??
      (child instanceof ClusterBuildPhase && child.name === name
        ? child
        : child instanceof ClusterBuildPhaseGroup
          ? findPhase(child.children, name)
          : undefined),
    undefined
  )
}

describe("ClusterBuildDefaults — sysio.uwrit launch config", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("uwrit-config-")
  })

  afterEach(() => {
    environment.cleanup()
  })

  /**
   * The bootstrap's `uwrit::setconfig` payload. It is built inline inside
   * `ClusterBuildDefaults.create`, so the composed tree is the only seam.
   */
  async function underwriterConfigData(): Promise<SysioContracts.SysioUwritSetconfigAction> {
    const cluster = await ClusterBuildDefaults.create({
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    })
    const phase = findPhase(cluster.children, UnderwriterConfigPhaseName)
    expect(phase).toBeDefined()
    const step = phase.steps.find(candidate => candidate.name === ConfigureUwritStepName)
    expect(step).toBeDefined()
    return (step.input as Steps.contracts.sysio.uwrit.SetconfigInput).data
  }

  // The value that matters: a cluster must price from-WIRE revert churn the way
  // the network will (the 5% launch value), not at the 0.1% placeholder the
  // constant carried before it. Nothing else pins this — the contract's own
  // `drainfwq` tests set their rate via `setconfig`, so a stale harness mirror
  // is invisible to them AND to every flow (none drives a caller-fault
  // drain-time revert). This assertion is the only guard against that drift.
  it("seeds the 5% launch from-WIRE revert fee, mirroring the contract default", async () => {
    expect((await underwriterConfigData()).fromwire_revert_fee_bps).toBe(500)
  })

  it("seeds the WIRE-leg network swap fee the fee-split flows assert against", async () => {
    expect((await underwriterConfigData()).fee_bps).toBe(30)
  })
})
