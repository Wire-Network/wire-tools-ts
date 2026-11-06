import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  ClusterBuildStep
} from "@wireio/cluster-tool/orchestration"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../config/clusterConfigFixture.js"
import {
  ConcurrencyProbeKey,
  planGatedStep,
  planInFlightTrackingStep,
  rendezvous
} from "./clusterBuildFixture.js"

function newBuild(): ClusterBuild {
  return ClusterBuild.forContext(
    new ClusterBuildContext(fixtureConfig(), getLogger(__filename))
  )
}

const ok = (order: string[], name: string) =>
  ClusterBuildStep.create(
    Report.Actor.Sysio,
    name,
    name,
    {},
    null,
    async () => {
      order.push(name)
    }
  )

const fail = (name: string) =>
  ClusterBuildStep.create(
    Report.Actor.Sysio,
    name,
    name,
    {},
    null,
    async () => {
      throw new Error(`${name} boom`)
    }
  )

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
    const build = newBuild()
    const group = ClusterBuildPhaseGroup.create(build, "G", "group", {
      parallel: true
    })
    const bothStarted = rendezvous(2)
    build.context.outputs.set(ConcurrencyProbeKey, {
      order,
      counter: { inFlight: 0, peak: 0 },
      barrier: bothStarted
    })
    ClusterBuildPhase.create(group, "first", "d").push(
      planGatedStep(Report.Actor.Sysio, "first")
    )
    ClusterBuildPhase.create(group, "second", "d").push(
      planGatedStep(Report.Actor.Sysio, "second")
    )
    expect(group.config.parallel).toBe(true)
    const phases = await runGroup(group)
    expect(phases.every(phase => phase.succeeded)).toBe(true)
    expect(order.slice(0, 2).sort()).toEqual(["start:first", "start:second"]) // both started...
    expect(order.slice(2).sort()).toEqual(["end:first", "end:second"]) // ...before either ended
    expect(phases.map(phase => phase.name).sort()).toEqual(["first", "second"])
  })

  it("defaults concurrency to unbounded so parallel keeps Promise.all semantics", () => {
    const group = ClusterBuildPhaseGroup.create(newBuild(), "G", "group", {
      parallel: true
    })
    expect(group.config.concurrency).toBe(
      ClusterBuildPhaseGroup.UnboundedConcurrency
    )
  })

  it("caps children in flight at `concurrency` when parallel", async () => {
    // The bound is the point: node-start groups use it so a whole wave of
    // nodeops cannot join the p2p mesh at once and starve vote propagation.
    const counter = { inFlight: 0, peak: 0 }
    const cap = 2
    const build = newBuild()
    const group = ClusterBuildPhaseGroup.create(build, "G", "group", {
      parallel: true,
      concurrency: cap
    })
    const capInFlight = rendezvous(cap)
    build.context.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: capInFlight
    })
    const names = ["a", "b", "c", "d", "e", "f"]
    names.forEach(name =>
      ClusterBuildPhase.create(group, name, "d").push(
        planInFlightTrackingStep(Report.Actor.Sysio, name)
      )
    )
    const phases = await runGroup(group)
    expect(counter.peak).toBe(cap)
    expect(phases.map(phase => phase.name).sort()).toEqual(names)
    expect(phases.every(phase => phase.succeeded)).toBe(true)
  })

  it("runs every child at once when parallel without a concurrency bound", async () => {
    const counter = { inFlight: 0, peak: 0 }
    const names = ["a", "b", "c", "d"]
    const build = newBuild()
    const group = ClusterBuildPhaseGroup.create(build, "G", "group", {
      parallel: true
    })
    const allInFlight = rendezvous(names.length)
    build.context.outputs.set(ConcurrencyProbeKey, {
      order: [],
      counter,
      barrier: allInFlight
    })
    names.forEach(name =>
      ClusterBuildPhase.create(group, name, "d").push(
        planInFlightTrackingStep(Report.Actor.Sysio, name)
      )
    )
    const phases = await runGroup(group)
    expect(counter.peak).toBe(names.length)
    expect(phases.every(phase => phase.succeeded)).toBe(true)
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
