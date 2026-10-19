import Fs from "node:fs"
import Path from "node:path"
import { ProtocolTiming } from "@wireio/cluster-tool"
import {
  ClusterBuildContext,
  ClusterBuildDefaults,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup
} from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

/** The phase `launchSolanaOutpost` composes. */
const LaunchPhaseName = "SolanaOutpostLaunch"

/** A flow-style context subclass, to prove `createContext` still threads through. */
class LaunchTestContext extends ClusterBuildContext {}

describe("ClusterBuildDefaults — Solana outpost launch (create only)", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("solana-launch-")
  })

  afterEach(() => {
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  it("leaves the outpost PreLaunch on the default (flow) path", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    expect(collectPhaseNames(cluster.children)).not.toContain(LaunchPhaseName)
  })

  it("launches a LOCAL outpost right after its deploy, inside the prerequisites", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions(), {
        launchSolanaOutpost: true
      }),
      names = collectPhaseNames(cluster.children),
      prerequisites = cluster.children.find(
        child => child.name === "Cluster Prerequisites"
      )
    // Directly after the deploy, so nothing between the two runs PreLaunch.
    expect(names.indexOf(LaunchPhaseName)).toBe(
      names.indexOf("SolanaOutpost") + 1
    )
    // ...and in the prerequisites group, so before every operator daemon.
    expect(collectPhaseNames([prerequisites])).toContain(LaunchPhaseName)
    // Each step is bounded by the outpost write budget, like every other
    // set_wire_state write in the harness.
    const launch =
        prerequisites instanceof ClusterBuildPhaseGroup
          ? prerequisites.children.find(child => child.name === LaunchPhaseName)
          : null,
      steps = launch instanceof ClusterBuildPhase ? launch.steps : []
    expect(steps.map(step => step.options.timeoutMs)).toEqual([
      ProtocolTiming.OutpostWriteBudgetMs,
      ProtocolTiming.OutpostWriteBudgetMs,
      ProtocolTiming.OutpostWriteBudgetMs
    ])
    expect(names.indexOf(LaunchPhaseName)).toBeLessThan(
      names.indexOf("OperatorNodes")
    )
    expect(names.indexOf(LaunchPhaseName)).toBeLessThan(
      names.indexOf("EpochBootstrap")
    )
    expect(collectStepNames(cluster.children)).toEqual(
      expect.arrayContaining([
        "set-wire-state-launching",
        "set-wire-state-post-launch",
        "verify-post-launch"
      ])
    )
  })

  it("never launches an EXTERNAL outpost", async () => {
    const externalConfigFile = Path.join(
      environment.rootPath,
      "external-outpost.json"
    )
    Fs.writeFileSync(
      externalConfigFile,
      JSON.stringify({
        ethereum: {
          addressFile: "outpost-addrs.json",
          abiFiles: ["eth-abis/OPP.json"],
          chainId: 11_155_111
        },
        solana: { idlFile: "solana-idls/liqsol_core.json" }
      })
    )
    const cluster = await ClusterBuildDefaults.create(
      {
        ...baseOptions(),
        externalOutpostConfig: externalConfigFile,
        // External mode has no local outpost to bond underwriter collateral on,
        // so `ClusterConfigProvider.resolve` demands an EXPLICIT zero.
        underwriterCount: 0
      },
      { launchSolanaOutpost: true }
    )
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("MaterializeExternalOutposts")
    expect(names).not.toContain(LaunchPhaseName)
  })

  it("builds the run's context through createContext", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions(), {
      createContext: (config, log) => new LaunchTestContext(config, log)
    })
    expect(cluster.context).toBeInstanceOf(LaunchTestContext)
    expect(collectPhaseNames(cluster.children)).not.toContain(LaunchPhaseName)
  })
})
