import Path from "node:path"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — external-outpost compose variant", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("compose-variant-")
    externalConfigFile = fixtureExternalOutpostConfig(environment.rootPath)
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

  it("omits the local outpost deploys + adds the liveness phase in external mode", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile
    })
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("MaterializeExternalOutposts")
    expect(names).toContain("HeadBlockAdvance")
    expect(names).not.toContain("EthereumOutpost")
    expect(names).not.toContain("SolanaOutpost")
  })

  it("trusts the config: no endpoint probe, the artifacts built from source like local mode", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        externalOutpostConfig: externalConfigFile
      }),
      steps = collectStepNames(cluster.children)
    expect(steps).toContain("materialize-external-outposts")
    expect(steps).toContain("prepare-daemon-artifacts")
    expect(steps).not.toContain("verify-ethereum-endpoint")
    expect(steps).not.toContain("verify-solana-endpoint")
    // The outposts' rosters belong to their own operators.
    expect(steps).not.toContain("seed-ethereum-roster")
    expect(steps).not.toContain("seed-solana-roster")
  })

  it("starts the batch-operator nodes, then gates each on having synced — after the envelope gate", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        externalOutpostConfig: externalConfigFile
      }),
      phases = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children),
      batchOperatorNodes = NodeConfig.plan(cluster.config).filter(
        node => node.role === NodeRole.batch_operator
      )
    expect(batchOperatorNodes.length).toBeGreaterThan(0)
    expect(phases).toContain("OperatorNodes")
    expect(phases.indexOf("OperatorNodesSynced")).toBeGreaterThan(
      phases.indexOf("OutboundEnvelopesQueued")
    )
    expect(phases.indexOf("OperatorNodesSynced")).toBeLessThan(
      phases.indexOf("StartScripts")
    )
    batchOperatorNodes.forEach(node =>
      expect(steps).toContain(`verify-${node.name}-synced`)
    )
  })

  it("keeps the local outpost deploys + no liveness phase in local mode", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("EthereumOutpost")
    expect(names).toContain("SolanaOutpost")
    expect(names).not.toContain("MaterializeExternalOutposts")
    expect(names).not.toContain("HeadBlockAdvance")
    expect(names).not.toContain("OperatorNodesSynced")
    expect(collectStepNames(cluster.children)).toContain(
      "prepare-daemon-artifacts"
    )
  })
})
