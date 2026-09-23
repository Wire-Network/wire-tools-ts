import Path from "node:path"
import { NodeConfig, NodeRole } from "@wireio/cluster-tool/config"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import {
  collectPhaseNames,
  collectStepActors,
  collectStepNames
} from "./clusterBuildFixture.js"

/**
 * The Report actor each role's node-start step runs under — API nodes, like
 * bios, as the sysio infrastructure (they carry no operator identity). Total
 * over `NodeRole`, so a new role cannot skip its entry; the bios node itself
 * starts in its own `BiosNode` phase, outside the node-start groups.
 */
const StartActorByRole: Record<NodeRole, Report.Actor> = {
  [NodeRole.bios]: Report.Actor.Sysio,
  [NodeRole.producer]: Report.Actor.Producer,
  [NodeRole.batch_operator]: Report.Actor.BatchOperator,
  [NodeRole.underwriter]: Report.Actor.Underwriter,
  [NodeRole.api]: Report.Actor.Sysio
}

describe("ClusterBuildDefaults — API-node start gating", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("api-nodes-")
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

  it("registers no ApiNodes group by default (apiCount 0)", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    expect(collectPhaseNames(cluster.children)).not.toContain("ApiNodes")
    // Positive control: the tree does carry the node-start groups, so the
    // absence above is not an empty tree passing vacuously.
    expect(collectPhaseNames(cluster.children)).toContain("OperatorNodes")
  })

  it("registers ApiNodes right before OperatorNodes with one phase + one start step per node", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        apiCount: 2
      }),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children),
      apiNodes = NodeConfig.plan(cluster.config).filter(
        node => node.role === NodeRole.api
      )
    expect(apiNodes).toHaveLength(2)
    // collectPhaseNames lists a group, then its children: OperatorNodes follows the
    // ApiNodes group and its per-node phases.
    expect(names.indexOf("OperatorNodes")).toBe(
      names.indexOf("ApiNodes") + 1 + apiNodes.length
    )
    apiNodes.forEach(node => {
      expect(names).toContain(node.name)
      expect(steps).toContain(`start-${node.name}`)
      expect(steps).toContain(`emit-start-script-${node.name}`)
    })
  })

  it("starts every grouped node under its role's Report actor — API nodes as the sysio infrastructure", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        apiCount: 1
      }),
      actors = collectStepActors(cluster.children),
      grouped = NodeConfig.plan(cluster.config).filter(
        node => node.role !== NodeRole.bios
      )
    expect(grouped.some(node => node.role === NodeRole.api)).toBe(true)
    grouped.forEach(node =>
      expect(actors.get(`start-${node.name}`)).toBe(StartActorByRole[node.role])
    )
  })
})
