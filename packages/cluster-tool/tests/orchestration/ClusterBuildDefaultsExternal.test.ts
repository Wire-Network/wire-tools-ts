import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames } from "./clusterBuildFixture.js"

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

  it("keeps the local outpost deploys + no liveness phase in local mode", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("EthereumOutpost")
    expect(names).toContain("SolanaOutpost")
    expect(names).not.toContain("MaterializeExternalOutposts")
    expect(names).not.toContain("HeadBlockAdvance")
  })
})
