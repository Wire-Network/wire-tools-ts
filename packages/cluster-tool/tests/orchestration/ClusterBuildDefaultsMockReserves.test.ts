import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"

/** A phase or group node — a group carries `children`, a phase is a leaf. */
interface NamedNode {
  name: string
  children?: ReadonlyArray<NamedNode>
}

/** Every phase/group name in a built cluster, recursively (tree order). */
function collectNames(children: ReadonlyArray<NamedNode>): string[] {
  return children.flatMap(child => [
    child.name,
    ...(child.children ? collectNames(child.children) : [])
  ])
}

describe("ClusterBuildDefaults — mock-reserve gating", () => {
  const previousRegistry = process.env.WIRE_BIND_REGISTRY_PATH
  let dir: string, buildPath: string

  beforeEach(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mock-reserves-"))
    process.env.WIRE_BIND_REGISTRY_PATH = Path.join(dir, "bind-registry")
    // resolveExecutables asserts nodeop/kiod/clio exist under buildPath/bin.
    buildPath = Path.join(dir, "build")
    Fs.mkdirSync(Path.join(buildPath, "bin"), { recursive: true })
    ;["nodeop", "kiod", "clio"].forEach(bin =>
      Fs.writeFileSync(Path.join(buildPath, "bin", bin), "")
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

  it("omits the MockReserves phase by default (no --enable-mock-reserves)", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).toContain("Registry")
    expect(names).not.toContain("MockReserves")
  })

  it("adds MockReserves immediately after Registry when enableMockReserves is set", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      enableMockReserves: true
    })
    const names = collectNames(cluster.children as unknown as NamedNode[])
    expect(names).toContain("MockReserves")
    // gated phase is registered directly after the Registry phase, pre-EpochBootstrap
    expect(names.indexOf("MockReserves")).toBe(names.indexOf("Registry") + 1)
  })
})
