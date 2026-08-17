import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildStep
} from "@wireio/cluster-tool/orchestration"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

/** A build whose report writes into `dir` (the fixture's path is unwritable). */
function buildWithReportDir(dir: string): ClusterBuild {
  const config = ClusterConfigProvider.deserialize(
    JSON.stringify({
      ...PersistedFixture,
      report: { ...PersistedFixture.report, path: dir }
    })
  )
  return ClusterBuild.forContext(
    new ClusterBuildContext(config, getLogger("build-test"))
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

describe("ClusterBuild", () => {
  let dir: string
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "build-"))
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("runs phases in order, stops at the first failed phase, writes the report", async () => {
    const order: string[] = []
    const build = buildWithReportDir(dir)
    ClusterBuildPhase.create(build, "P1", "first").push(ok(order, "a"))
    ClusterBuildPhase.create(build, "P2", "second").push(fail("b"))
    ClusterBuildPhase.create(build, "P3", "third").push(ok(order, "c"))
    const report = await build.build()
    expect(report.succeeded).toBe(false)
    expect(report.phases.map(phase => phase.name)).toEqual(["P1", "P2"]) // P3 never ran
    expect(order).toEqual(["a"]) // c never ran
    expect(Fs.existsSync(Path.join(dir, "cluster-build.csv"))).toBe(true)
    expect(Fs.existsSync(Path.join(dir, "cluster-build.html"))).toBe(true)
  })

  it("disarms the exit-path writer once the async write succeeds", async () => {
    const build = buildWithReportDir(dir)
    ClusterBuildPhase.create(build, "P1", "first").push(ok([], "a"))
    const before = process.listenerCount("exit")
    await build.build()
    expect(process.listenerCount("exit")).toBe(before)
  })

  it("keeps the exit-path writer armed when a phase REJECTS, so the partial Report still lands", async () => {
    // A phase whose run() rejects models an unexpected orchestration error —
    // it propagates past the async write, which is exactly the hole the exit
    // listener backstops (the other being an interrupt, where no async
    // continuation resumes at all).
    const target = Fs.mkdtempSync(Path.join(Os.tmpdir(), "build-reject-"))
    try {
      const build = buildWithReportDir(target)
      ClusterBuildPhase.create(build, "P1", "first").push(ok([], "a"))
      const phase = ClusterBuildPhase.create(build, "P2", "second").push(ok([], "b"))
      jest.spyOn(phase, "run").mockRejectedValue(new Error("engine exploded"))

      const listenersBefore = new Set(process.listeners("exit"))
      await expect(build.build()).rejects.toThrow("engine exploded")
      expect(Fs.existsSync(Path.join(target, "cluster-build.csv"))).toBe(false)

      const armed = process
        .listeners("exit")
        .filter(listener => !listenersBefore.has(listener))
      expect(armed).toHaveLength(1)

      armed[0](0) // what `process.exit()` invokes, with its exit code
      expect(Fs.existsSync(Path.join(target, "cluster-build.csv"))).toBe(true)
      // P1 completed before the rejection — its steps survive, so the written
      // report carries a real narrative rather than an empty shell.
      const csv = Fs.readFileSync(Path.join(target, "cluster-build.csv"), "utf8")
      expect(csv).toContain("P1")
      expect(csv).toContain("a")
      // …and the run is NOT titled a success: it never finished.
      expect(Fs.readFileSync(Path.join(target, "cluster-build.md"), "utf8")).toContain(
        `cluster-build: ${Report.Verdict.INTERRUPTED}`
      )
      process.removeListener("exit", armed[0])
    } finally {
      Fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it("records every finished phase on the shared context as it completes", async () => {
    const build = buildWithReportDir(dir)
    ClusterBuildPhase.create(build, "P1", "first").push(ok([], "a"))
    ClusterBuildPhase.create(build, "P2", "second").push(ok([], "b"))
    await build.build()
    expect(build.context.completedPhases.map(phase => phase.name)).toEqual([
      "P1",
      "P2"
    ])
  })

  it("append merges another build's phases in order", () => {
    const build = buildWithReportDir(dir)
    ClusterBuildPhase.create(build, "Main", "m")
    const extra = buildWithReportDir(dir)
    ClusterBuildPhase.create(extra, "Extra", "e")
    build.append(extra)
    expect(build.children.map(child => child.name)).toEqual(["Main", "Extra"])
  })

  it("forContext exposes the config from its context", () => {
    expect(buildWithReportDir(dir).config.report.path).toBe(dir)
  })
})
