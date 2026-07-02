import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildStep
} from "@wireio/test-cluster-tool/orchestration"
import { ClusterConfig } from "@wireio/test-cluster-tool/config"
import { getLogger } from "@wireio/test-cluster-tool/logging"
import { Report } from "@wireio/test-cluster-tool/report"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

/** A build whose report writes into `dir` (the fixture's path is unwritable). */
function buildWithReportDir(dir: string): ClusterBuild {
  const config = ClusterConfig.deserialize(
    JSON.stringify({
      ...PersistedFixture,
      report: { ...PersistedFixture.report, path: dir }
    })
  )
  return ClusterBuild.forContext(new ClusterBuildContext(config, getLogger("build-test")))
}

const ok = (order: string[], name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    order.push(name)
  })

const fail = (name: string) =>
  ClusterBuildStep.create(Report.Actor.Sysio, name, name, {}, null, async () => {
    throw new Error(`${name} boom`)
  })

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
