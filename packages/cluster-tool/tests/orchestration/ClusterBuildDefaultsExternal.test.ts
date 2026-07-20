import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"

/** A phase or group node — a group carries `children`, a phase is a leaf. */
interface NamedNode {
  name: string
  children?: ReadonlyArray<NamedNode>
}

/** Every phase/group name in a built cluster, recursively. */
function collectNames(children: ReadonlyArray<NamedNode>): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child.children ? collectNames(child.children) : [])
  ])
}

describe("ClusterBuildDefaults — external-outpost compose variant", () => {
  const previousRegistry = process.env.WIRE_BIND_REGISTRY_PATH
  let dir: string, buildPath: string, externalConfigFile: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "compose-variant-"))
    process.env.WIRE_BIND_REGISTRY_PATH = Path.join(dir, "bind-registry")
    // resolveExecutables asserts nodeop/kiod/clio exist under buildPath/bin.
    buildPath = Path.join(dir, "build")
    Fs.mkdirSync(Path.join(buildPath, "bin"), { recursive: true })
    ;["nodeop", "kiod", "clio"].forEach(bin =>
      Fs.writeFileSync(Path.join(buildPath, "bin", bin), "")
    )
    externalConfigFile = Path.join(dir, "external-outpost.json")
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
  })

  afterEach(() => {
    if (previousRegistry == null) delete process.env.WIRE_BIND_REGISTRY_PATH
    else process.env.WIRE_BIND_REGISTRY_PATH = previousRegistry
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(dir, "cluster"),
      buildPath,
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
    expect(names).toContain("HeadBlockAdvance")
    expect(names).not.toContain("EthereumOutpost")
    expect(names).not.toContain("SolanaOutpost")
  })

  it("keeps the local outpost deploys + no liveness phase in local mode", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).toContain("EthereumOutpost")
    expect(names).toContain("SolanaOutpost")
    expect(names).not.toContain("MaterializeExternalOutposts")
    expect(names).not.toContain("HeadBlockAdvance")
  })
})
