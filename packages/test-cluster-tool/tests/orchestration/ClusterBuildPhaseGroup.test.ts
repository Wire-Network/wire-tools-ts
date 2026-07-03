import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ClusterBuildStep
} from "@wireio/test-cluster-tool/orchestration"
import { getLogger } from "@wireio/test-cluster-tool/logging"
import { Report } from "@wireio/test-cluster-tool/report"
import { sleep } from "@wireio/test-cluster-tool/utils"
import { fixtureConfig } from "../config/clusterConfigFixture.js"

function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger("group-test"))
  )
}

const ok = (order: string[], name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    order.push(name)
  })

const fail = (name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    throw new Error(`${name} boom`)
  })

/** Run a group and flatten its single Group node to the contained phases. */
const runGroup = (group: ClusterBuildPhaseGroup): Promise<Report.Phase[]> =>
  group
    .run(new AbortController().signal)
    .then(nodes => nodes.flatMap(node => Report.Node.phases(node)))

describe("ClusterBuildPhaseGroup", () => {
  it("defaults to sequential; runs child phases in registration order", async () => {
    const order: string[] = []
    const group = ClusterBuildPhaseGroup.create(newBuild(), "G", "group")
    ClusterBuildPhase.create(group, "P1", "d").push(ok(order, "a"))
    ClusterBuildPhase.create(group, "P2", "d").push(ok(order, "b"))
    expect(group.config.parallel).toBe(false)
    const phases = await runGroup(group)
    expect(order).toEqual(["a", "b"])
    expect(phases.map(phase => phase.name)).toEqual(["P1", "P2"])
    expect(phases.every(phase => phase.succeeded)).toBe(true)
  })

  it("sequential group stops at the first failed child (omits the rest)", async () => {
    const order: string[] = []
    const group = ClusterBuildPhaseGroup.create(newBuild(), "G", "group")
    ClusterBuildPhase.create(group, "P1", "d").push(ok(order, "a"))
    ClusterBuildPhase.create(group, "P2", "d").push(fail("b"))
    ClusterBuildPhase.create(group, "P3", "d").push(ok(order, "c"))
    const phases = await runGroup(group)
    expect(order).toEqual(["a"]) // c never ran
    expect(phases.map(phase => phase.name)).toEqual(["P1", "P2"]) // P3 omitted
    expect(phases[1].succeeded).toBe(false)
  })

  it("runs children concurrently when parallel", async () => {
    const order: string[] = []
    const group = ClusterBuildPhaseGroup.create(newBuild(), "G", "group", {
      parallel: true
    })
    const timed = (name: string, ms: number) =>
      ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
        await sleep(ms)
        order.push(name)
      })
    ClusterBuildPhase.create(group, "slow", "d").push(timed("slow", 40))
    ClusterBuildPhase.create(group, "fast", "d").push(timed("fast", 5))
    expect(group.config.parallel).toBe(true)
    const phases = await runGroup(group)
    expect(order).toEqual(["fast", "slow"]) // started together; fast lands first
    expect(phases.map(phase => phase.name).sort()).toEqual(["fast", "slow"])
  })

  it("nests a group inside a group, flattening children in run order", async () => {
    const order: string[] = []
    const outer = ClusterBuildPhaseGroup.create(newBuild(), "Outer", "d")
    ClusterBuildPhase.create(outer, "P1", "d").push(ok(order, "a"))
    const inner = ClusterBuildPhaseGroup.create(outer, "Inner", "d")
    ClusterBuildPhase.create(inner, "P2", "d").push(ok(order, "b"))
    ClusterBuildPhase.create(inner, "P3", "d").push(ok(order, "c"))
    const phases = await runGroup(outer)
    expect(order).toEqual(["a", "b", "c"])
    expect(phases.map(phase => phase.name)).toEqual(["P1", "P2", "P3"])
  })
})
