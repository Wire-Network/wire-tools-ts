import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  createResolveEnv,
  type ResolveEnv
} from "../config/resolveEnvFixture.js"

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
  let env: ResolveEnv

  beforeEach(() => {
    env = createResolveEnv("mock-reserves-")
  })

  afterEach(() => {
    env.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(env.dir, "cluster"),
      buildPath: env.buildPath,
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
