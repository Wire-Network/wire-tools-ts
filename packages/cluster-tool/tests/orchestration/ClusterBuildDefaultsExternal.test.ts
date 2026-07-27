import Fs from "node:fs"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { TestSolanaGenesisHash } from "../config/clusterConfigFixture.js"

/** A phase or group node — a group carries `children`, a phase is a leaf. */
interface NamedStep {
  name: string
}

/** A phase or group node, including a phase's direct step definitions. */
interface NamedNode {
  name: string
  children?: ReadonlyArray<NamedNode>
  steps?: ReadonlyArray<NamedStep>
}

/** Every phase/group name in a built cluster, recursively. */
function collectNames(children: ReadonlyArray<NamedNode>): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child.steps?.map(step => step.name) ?? []),
    ...(child.children ? collectNames(child.children) : [])
  ])
}

describe("ClusterBuildDefaults — external-outpost compose variant", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("compose-variant-")
    externalConfigFile = Path.join(
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
        solana: {
          idlFile: "solana-idls/liqsol_core.json",
          genesisHash: TestSolanaGenesisHash
        }
      })
    )
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
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).toContain("MaterializeExternalOutposts")
    expect(names).toContain("verify-solana-cluster-identity")
    expect(names).toContain("HeadBlockAdvance")
    expect(names).not.toContain("EthereumOutpost")
    expect(names).not.toContain("SolanaOutpost")
    expect(names.indexOf("verify-solana-cluster-identity")).toBeLessThan(
      names.indexOf("OperatorNodes")
    )
  })

  it("keeps the local outpost deploys + no liveness phase in local mode", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).toContain("EthereumOutpost")
    expect(names).toContain("SolanaOutpost")
    expect(names).toContain("provision-solana-cluster-identity")
    expect(names).not.toContain("MaterializeExternalOutposts")
    expect(names).not.toContain("HeadBlockAdvance")
  })
})
